/**
 * The rich-text renderer against TakeShape's own output. Each fixture and the
 * crafted cases in richtext-cases.json are converted with ts2emdash.mts into
 * a temp folder. Every Draft.js value's Portable Text and sidecar are read from
 * the seed and rendered, and the HTML must equal the golden that TakeShape's
 * renderer printed (see richtext-golden/README.md).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { PTBlock, RichTextSidecarEntry } from "../../ts2emdash.mts";
import { renderRichText, withoutBlockBreaks } from "../../tsg2astro/runtime/richtext.ts";
import type { ImageParams, RichTextOptions } from "../../tsg2astro/runtime/richtext.ts";
import { writeSyntheticExport } from "../synthetic-export.mts";
import type { DraftRaw, SynthAsset } from "../synthetic-export.mts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const fixtures = join(root, "test", "fixtures");
const goldenDir = join(here, "richtext-golden");
const work = mkdtempSync(join(tmpdir(), "richtext-"));
after(() => rmSync(work, { recursive: true, force: true }));

type Json = Record<string, any>;
type Sidecar = Record<string, RichTextSidecarEntry>;
interface Converted {
	seed: Json;
	report: string;
}

let runs = 0;
function convert(exportDir: string): Converted {
	const out = join(work, `run-${++runs}`);
	const res = spawnSync(process.execPath, ["--no-warnings", "ts2emdash.mts", exportDir, "--out", join(out, "seed.json"), "--report", join(out, "report.md")], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(res.status, 0, `ts2emdash exited ${res.status}: ${res.stderr}`);
	return { seed: JSON.parse(readFileSync(join(out, "seed.json"), "utf8")), report: readFileSync(join(out, "report.md"), "utf8") };
}

const golden = (name: string): Record<string, string> => JSON.parse(readFileSync(join(goldenDir, `${name}.json`), "utf8"));

/**
 * Image blocks as EmDash stores them after `emdash seed`: the asset is a
 * reference with a url. The seed's $media url points at TakeShape's asset
 * host; the goldens use its image host, where TakeShape's own markup pointed.
 */
function applied(blocks: PTBlock[] | undefined): PTBlock[] | undefined {
	return blocks?.map((b) => {
		const media = b.asset?.$media;
		if (b._type !== "image" || !media) return b;
		return { ...b, asset: { _type: "reference", url: String(media.url).replace("https://assets.takeshape.io/", "https://images.takeshape.io/") } };
	});
}

const imageUrl = (src: { url: string }) => src.url;

/** TakeShape's image query string: pickBy(v !== ''), keys sorted, strict encoding. Enough for the cases' args. */
function withQuery(src: { url: string }, params: ImageParams | undefined): string {
	const entries = Object.entries(params ?? {}).filter(([, v]) => v !== "");
	if (!entries.length) return src.url;
	const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `${src.url}?${entries
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${enc(k)}=${enc(String(v))}`)
		.join("&")}`;
}

/** camelCase property name to the field slug ts2emdash gives it. */
const fieldSlug = (prop: string) => prop.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

interface Value {
	blocks: PTBlock[] | undefined;
	sidecar: Sidecar | undefined;
	/** For caption and credit keys: the sidecar entry's caption or credit, rendered plain */
	part?: "caption" | "credit";
	blockKey?: string;
}

/** A seed entry with its collection and that collection's field slugs. */
interface SeedEntry {
	data: Json;
	collection: string;
	fields: Set<string>;
}

/**
 * The seed's Portable Text for a golden key, or undefined when the seed has
 * no entry for it. `printed` is the golden HTML. The field must exist, so a
 * wrong slug can't pass as an empty value. The entry must hold a value
 * whenever TakeShape printed something: the converter writes nothing only
 * for a value TakeShape printed as ''.
 */
function seedValue(entries: Map<string, SeedEntry>, key: string, printed: string): Value | undefined {
	const [id, prop, blockKey, part] = key.split("/");
	const entry = entries.get(`ts-${id}`);
	if (!entry) return undefined;
	const slug = fieldSlug(prop);
	assert.ok(entry.fields.has(slug), `${key}: collection ${entry.collection} has no field ${slug}`);
	const sidecar: Sidecar | undefined = entry.data.takeshape_rich_text?.[slug];
	const blocks: PTBlock[] | undefined = entry.data[slug];
	if (part === "caption" || part === "credit") {
		// TakeShape rendered captions only for an image with its asset, which always converts with a sidecar entry
		assert.ok(Object.hasOwn(entry.data, slug), `${key}: entry has no ${slug}`);
		assert.ok(sidecar?.[blockKey], `${key}: no sidecar entry for block ${blockKey}`);
		return { blocks, sidecar, part, blockKey };
	}
	if (printed !== "") assert.ok(Object.hasOwn(entry.data, slug), `${key}: entry has no ${slug}, but TakeShape printed it`);
	return { blocks, sidecar };
}

function render(v: Value, options: RichTextOptions): string {
	if (v.part) return renderRichText(v.sidecar?.[v.blockKey!]?.[v.part], undefined, { ...options, plain: true });
	return renderRichText(applied(v.blocks), v.sidecar, options);
}

function entriesOf(seed: Json): Map<string, SeedEntry> {
	const fields = new Map<string, Set<string>>();
	for (const c of seed.collections ?? []) fields.set(c.slug, new Set((c.fields ?? []).map((f: Json) => f.slug)));
	const entries = new Map<string, SeedEntry>();
	for (const [collection, list] of Object.entries<Json[]>(seed.content ?? {})) {
		for (const e of list) entries.set(e.id, { data: e.data, collection, fields: fields.get(collection) ?? new Set() });
	}
	return entries;
}

/** Renders every golden key and returns actual and expected for the keys that differ. */
function compare(gold: Record<string, string>, entries: Map<string, SeedEntry>, options: RichTextOptions, skip: (key: string) => boolean = () => false) {
	const actual: Record<string, string> = {};
	const expected: Record<string, string> = {};
	const missing: string[] = [];
	let matched = 0;
	for (const [key, html] of Object.entries(gold)) {
		if (skip(key)) continue;
		const v = seedValue(entries, key, html);
		if (!v) {
			missing.push(key);
			continue;
		}
		const got = render(v, options);
		if (got === html) matched++;
		else {
			actual[key] = got;
			expected[key] = html;
		}
	}
	return { actual, expected, missing, matched };
}

// --- Fixtures --------------------------------------------------------------

for (const name of readdirSync(fixtures).sort()) {
	if (!existsSync(join(goldenDir, `${name}.json`))) continue;
	test(`fixture ${name} matches TakeShape`, (t) => {
		const gold = golden(name);
		const { seed } = convert(join(fixtures, name));
		const { actual, expected, missing, matched } = compare(gold, entriesOf(seed), { imageUrl });
		// Golden keys with no seed entry must be asset rows: their caption and credit stay plain media text
		const rows: Json[] = readFileSync(join(fixtures, name, "data.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const assetIds = new Set(rows.filter((r) => (r._shapeId ?? r._contentTypeId) === "ASSET").map((r) => String(r._id)));
		assert.deepEqual(missing.filter((k) => !assetIds.has(k.split("/")[0])), [], "golden keys with no seed entry that are not assets");
		t.diagnostic(`${matched} of ${Object.keys(gold).length} matched, ${missing.length} asset values not in the seed`);
		assert.deepEqual(actual, expected);
	});
}

// --- Crafted cases ---------------------------------------------------------

const cases: { args: Json; assets: SynthAsset[]; cases: Record<string, DraftRaw> } = JSON.parse(readFileSync(join(here, "richtext-cases.json"), "utf8"));
let crafted: Converted | undefined;
function craftedSeed(): Converted {
	if (crafted) return crafted;
	const dir = join(work, "cases-export");
	writeSyntheticExport(dir, {
		assets: cases.assets,
		posts: Object.entries(cases.cases).map(([name, story]) => ({ id: name, title: name, slug: name, story })),
	});
	crafted = convert(dir);
	return crafted;
}

// Cases the converter cannot carry over exactly, checked on their own below
const SMALL = "small/story";
const INLINE_IMAGE = "inline-image/story";
const special = (key: string) => key === SMALL || key === INLINE_IMAGE;

for (const [file, options] of [
	["cases", { imageUrl }],
	["cases-args", { ...cases.args, imageUrl: withQuery }],
] as [string, RichTextOptions][]) {
	test(`crafted cases match TakeShape (${file}.json)`, (t) => {
		const gold = golden(file);
		const { actual, expected, missing, matched } = compare(gold, entriesOf(craftedSeed().seed), options, special);
		assert.deepEqual(missing, [], "golden keys with no seed entry");
		t.diagnostic(`${matched} of ${Object.keys(gold).length - 2} matched`);
		assert.deepEqual(actual, expected);
	});

	// SMALL has no EmDash mark, so the converter drops it: the output differs from TakeShape's only by <small>
	test(`small-dropped-only (${file}.json)`, () => {
		const html = golden(file)[SMALL];
		assert.match(html, /<small>/);
		const got = render(seedValue(entriesOf(craftedSeed().seed), SMALL, html)!, options);
		assert.equal(got, html.replace(/<\/?small>/g, ""));
	});
}

test("inline-image-reported", () => {
	const { seed, report } = craftedSeed();
	assert.match(report, /1 image inside rich text paragraphs \(entity "IMAGE"\) was not converted\. Its paragraph text was kept as plain text\./);
	// TakeShape printed an <img> in place of the text; the converter keeps the text
	assert.match(golden("cases")[INLINE_IMAGE], /<img src="https:\/\/example\.test\/a\.png"/);
	assert.equal(render(seedValue(entriesOf(seed), INLINE_IMAGE, golden("cases")[INLINE_IMAGE])!, { imageUrl }), "<p>See pic here.</p>");
});

// --- After an edit in EmDash ----------------------------------------------

/** A crafted case's applied blocks and sidecar, copied so a test can change them. */
function editable(name: string): { blocks: PTBlock[]; sidecar: Sidecar } {
	const v = seedValue(entriesOf(craftedSeed().seed), `${name}/story`, golden("cases")[`${name}/story`])!;
	return structuredClone({ blocks: applied(v.blocks)!, sidecar: v.sidecar ?? {} });
}

test("edited-caption-falls-back", () => {
	const { blocks, sidecar } = editable("image-link");
	const image = blocks.find((b) => b._key === "il1")!;
	assert.equal(image.caption, sidecar.il1.captionText);
	image.caption = 'New <caption> & "more"';
	const html = renderRichText(blocks, sidecar, { imageUrl });
	const before = '<span class="caption"><p>A caption with H2O and x2</p></span>';
	assert.ok(golden("cases")["image-link/story"].includes(before));
	assert.equal(html, golden("cases")["image-link/story"].replace(before, '<span class="caption">New &lt;caption&gt; &amp; "more"</span>'));
});

test("missing-sidecar-key", () => {
	const { blocks, sidecar } = editable("blocks");
	assert.deepEqual(sidecar.bk2, { pullquote: true });
	delete sidecar.bk2;
	const html = renderRichText(blocks, sidecar, { imageUrl });
	assert.equal(html, golden("cases")["blocks/story"].replace('<aside class="pullquote"><blockquote>Pull</blockquote></aside>', "<blockquote>Pull</blockquote>"));
});

test("deleted-image-block", () => {
	const { blocks, sidecar } = editable("image-link");
	assert.ok(sidecar.il1);
	const kept = blocks.filter((b) => b._key !== "il1");
	const html = renderRichText(kept, sidecar, { imageUrl });
	const lines = golden("cases")["image-link/story"].split("\n");
	assert.match(lines[1], /^<figure class="left medium">/);
	assert.equal(html, [lines[0], ...lines.slice(2)].join("\n"));
});

// TakeShape's MDX renderer ran rehype-minify-whitespace 5.0.0: whitespace between tags goes where
// a block element starts or ends there, and collapses to one space between inline ones, so two links stay apart
test("withoutBlockBreaks drops breaks at block boundaries and keeps a space between inline elements", () => {
	assert.equal(withoutBlockBreaks('<p><a href="/a">one</a>\n<a href="/b">two</a></p>'), '<p><a href="/a">one</a> <a href="/b">two</a></p>');
	assert.equal(withoutBlockBreaks("<p>a</p>\n\n<p>b</p>"), "<p>a</p><p>b</p>");
	assert.equal(withoutBlockBreaks("<ul>\n  <li>x</li>\n</ul>"), "<ul><li>x</li></ul>");
	assert.equal(withoutBlockBreaks('<p><em>a</em>\n<img src="x"></p>'), '<p><em>a</em> <img src="x"></p>');
	assert.equal(withoutBlockBreaks("<p><strong>a</strong>\n</p>"), "<p><strong>a</strong></p>");
	assert.equal(withoutBlockBreaks("<pre>a\n\nb</pre>\n<p>c</p>"), "<pre>a\n\nb</pre><p>c</p>");
});

// Inside a script, a style and a textarea, a tag is text: an htmlBlock's script keeps its template literal as written,
// as rehype-minify-whitespace keeps a textarea's whitespace. Around them the usual rule applies.
test("withoutBlockBreaks leaves the text of scripts, styles and textareas alone", () => {
	const script = "<script>const t = `<div>\n<span>x</span>\n</div>`;</script>";
	assert.equal(withoutBlockBreaks(`<p>a</p>\n${script}\n<p>b</p>`), `<p>a</p>${script}<p>b</p>`);
	assert.equal(withoutBlockBreaks("<p><textarea>\n\n</textarea>\n<span>x</span></p>"), "<p><textarea>\n\n</textarea> <span>x</span></p>");
	assert.equal(withoutBlockBreaks("<style>a > b {}\n</style>\n<div></div>"), "<style>a > b {}\n</style><div></div>");
	assert.equal(withoutBlockBreaks("<SCRIPT>\n<b>\n</b>\n</SCRIPT>"), "<SCRIPT>\n<b>\n</b>\n</SCRIPT>");
	assert.equal(withoutBlockBreaks("<p>a</p>\n<!-- <b>\n<i> -->\n<p>b</p>"), "<p>a</p>\n<!-- <b>\n<i> -->\n<p>b</p>");
	assert.equal(withoutBlockBreaks("<p>a</p>\n<!-- never closed <b>\n<i>"), "<p>a</p>\n<!-- never closed <b>\n<i>");
	// A name that only starts like one is an ordinary tag
	assert.equal(withoutBlockBreaks("<preview>\n<p>x</p></preview>"), "<preview><p>x</p></preview>");
});

// A > inside a quoted attribute value doesn't end the tag, and only HTML's whitespace counts: rehype-minify-whitespace
// collapses [\t\n\v\f\r ], so a no-break space is text
test("withoutBlockBreaks reads quoted attribute values whole and keeps other Unicode spaces", () => {
	const title = '<div title="first>\n<span>second">body</div>';
	assert.equal(withoutBlockBreaks(title), title);
	assert.equal(withoutBlockBreaks("<p>a</p>\n<div title='x>y'>z</div>\n<p>b</p>"), "<p>a</p><div title='x>y'>z</div><p>b</p>");
	assert.ok(withoutBlockBreaks("<p>a</p>\n\u00a0<p>b</p>").includes("\u00a0"));
	assert.ok(withoutBlockBreaks("<b>a</b>\u2003\n<b>b</b>").includes("\u2003"));
	// A < that never closes is read once: before many quoted values, with a long name, and a long run of line breaks
	for (const input of [`<a ${'x="1" '.repeat(40)}`, `<${"a".repeat(32000)}`, `<b>${"\n".repeat(32000)}x`, "<a ".repeat(20000), `<a x="${"<b ".repeat(20000)}`]) {
		const started = performance.now();
		assert.equal(withoutBlockBreaks(input), input);
		assert.ok(performance.now() - started < 100, `took ${Math.round(performance.now() - started)} ms on ${input.slice(0, 12)}…`);
	}
});
