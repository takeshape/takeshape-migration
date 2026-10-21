/**
 * Draft.js to Portable Text: each case is a post in WITH_DRAFT_CASES
 * (test/synthetic-export.mts). The export is converted with ts2emdash.mts
 * into a temp folder and the tests read the seed it writes.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OEMBED_HTML, WITH_DRAFT_CASES, writeSyntheticExport } from "./synthetic-export.mts";
import type { SynthSpec } from "./synthetic-export.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "draft-to-pt-"));
after(() => rmSync(work, { recursive: true, force: true }));

type Json = Record<string, any>;
interface Converted {
	text: string;
	seed: Json;
	report: string;
}

let runs = 0;
function convertDir(exportDir: string): Converted {
	const out = join(work, `run-${++runs}`);
	const seedFile = join(out, "seed.json");
	const res = spawnSync(process.execPath, ["--no-warnings", "ts2emdash.mts", exportDir, "--out", seedFile, "--report", join(out, "report.md")], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(res.status, 0, `ts2emdash exited ${res.status}: ${res.stderr}`);
	const text = readFileSync(seedFile, "utf8");
	return { text, seed: JSON.parse(text), report: readFileSync(join(out, "report.md"), "utf8") };
}

function convertSpec(spec: SynthSpec): Converted {
	const dir = join(work, `export-${runs + 1}`);
	writeSyntheticExport(dir, spec);
	return convertDir(dir);
}

let cases: Converted | undefined;
const draftCases = () => (cases ??= convertSpec(WITH_DRAFT_CASES));

/** The post with this slug: its Portable Text story and its sidecar. */
function caseOf(slug: string) {
	const entry = draftCases().seed.content.posts.find((e: Json) => e.slug === slug);
	assert.ok(entry, `no post ${slug} in the seed`);
	const blocks: Json[] = entry.data.story ?? [];
	const sidecar: Json = entry.data.takeshape_rich_text?.story ?? {};
	const block = (key: string) => {
		const b = blocks.find((x) => x._key === key);
		assert.ok(b, `no block ${key} in ${slug}: ${JSON.stringify(blocks)}`);
		return b;
	};
	return { entry, blocks, sidecar, block };
}

const spans = (b: Json) => (b.children as Json[]).map((c) => ({ text: c.text, marks: c.marks }));
const blockText = (b: Json) => ((b.children ?? []) as Json[]).map((c) => c.text).join("");

test("pullquote-kept", () => {
	const { block, sidecar } = caseOf("pullquote");
	const b = block("pq1");
	assert.equal(b._type, "block");
	assert.equal(b.style, "blockquote");
	assert.equal(blockText(b), "Quote me.");
	assert.deepEqual(sidecar.pq1, { pullquote: true });
	assert.equal(block("pq-a").style, "normal");
	assert.equal(sidecar["pq-a"], undefined);
});

test("section-break-kept", () => {
	const { block } = caseOf("section-break");
	assert.deepEqual(block("sb1"), { _type: "break", _key: "sb1", style: "lineBreak" });
});

test("marks-kept", () => {
	const { block } = caseOf("marks");
	assert.deepEqual(spans(block("mk1")), [
		{ text: "H", marks: [] },
		{ text: "2", marks: ["subscript"] },
		{ text: "O, x", marks: [] },
		{ text: "2", marks: ["superscript"] },
		{ text: " and ", marks: [] },
		{ text: "underlined", marks: ["underline"] },
	]);
});

test("link-attrs-kept", () => {
	const { block } = caseOf("link");
	const b = block("ln1");
	assert.equal(b.markDefs.length, 1);
	const def = b.markDefs[0];
	assert.deepEqual(def, { _type: "link", _key: def._key, href: "https://x.test", blank: true, tsTarget: "_blank", tsAttrOrder: ["href", "target"] });
	assert.deepEqual(spans(b), [
		{ text: "Visit ", marks: [] },
		{ text: "x", marks: [def._key] },
		{ text: " now", marks: [] },
	]);
});

test("image-entity", () => {
	const { block, sidecar } = caseOf("image");
	assert.deepEqual(block("im1"), {
		_type: "image",
		_key: "im1",
		asset: { $media: { url: "https://assets.takeshape.io/proj/dev/img1/photo%20one.jpg", filename: "photo one.jpg", alt: "Alt one" } },
		alt: "Alt one",
		title: "Photo one",
		alignment: "center",
		link: { href: "https://example.test/page", blank: true },
		caption: "A caption",
	});
	const entry = sidecar.im1;
	assert.ok(entry, `no sidecar entry for im1: ${JSON.stringify(sidecar)}`);
	assert.equal(entry.size, "large");
	assert.equal(entry.assetId, "img1");
	assert.equal(entry.captionText, "A caption");
	assert.deepEqual(entry.caption.map(blockText), ["A caption"]);
	const credit = entry.credit?.[0];
	assert.ok(credit, "no credit in the sidecar");
	assert.equal(blockText(credit), "Photo by Jo");
	assert.equal(credit.markDefs.length, 1);
	assert.equal(credit.markDefs[0]._type, "link");
	assert.equal(credit.markDefs[0].href, "https://jo.test");
	assert.equal(credit.markDefs[0].tsTitle, "Jo");
	assert.deepEqual(credit.markDefs[0].tsAttrOrder, ["href", "title"]);
	assert.deepEqual(spans(credit).at(-1), { text: "Jo", marks: [credit.markDefs[0]._key] });
});

// TakeShape rendered captions with rawToHTML, which knew no pullquote or section break: both printed as paragraphs
test("caption-pullquote-and-break-as-paragraphs", () => {
	const { sidecar } = caseOf("caption-blocks");
	const caption: Json[] = sidecar.cb1?.caption ?? [];
	assert.deepEqual(
		caption.map((b) => [b._key, b._type, b.style, blockText(b)]),
		[
			["cq1", "block", "normal", "A pullquote"],
			["cs1", "block", "normal", " "],
			["cq2", "block", "blockquote", "A blockquote"],
		],
	);
});

// TakeShape nested any block one level deeper than the list item before it; Portable Text keeps depth only on list items
test("nested-paragraph-reported", () => {
	const { block } = caseOf("nested-paragraph");
	for (const key of ["np0", "np2"]) {
		assert.equal(block(key).style, "normal");
		assert.equal(block(key).listItem, undefined);
		assert.equal(block(key).level, undefined);
	}
	assert.equal(block("np3").level, 2);
	// np2 was nested under "One"; np0 had a depth but no list item before it, so TakeShape printed it at the top too
	assert.match(draftCases().report, /^- 1 rich text block that TakeShape nested under a list item \(usually a paragraph indented in the list\) now renders at the top level, after the list\.$/m);
});

// --preload-media swaps $media for the stored media row (offline, with test/fake-fetch.mts)
let preloaded: Json | undefined;
function preloadCases(): Json {
	if (preloaded) return preloaded;
	const dir = join(work, "export-preload");
	writeSyntheticExport(dir, WITH_DRAFT_CASES);
	const out = join(work, "preload");
	const res = spawnSync(
		process.execPath,
		["--no-warnings", "--import", pathToFileURL(join(root, "test", "fake-fetch.mts")).href, "ts2emdash.mts", dir, "--out", join(out, "seed.json"), "--report", join(out, "report.md"),
			"--preload-media", "local", "--database", join(out, "data.db"), "--uploads-dir", join(out, "uploads")],
		{ cwd: root, encoding: "utf8", env: { ...process.env, FAKE_FETCH: "images", FAKE_FETCH_LOG: join(out, "fetch.log") } },
	);
	assert.equal(res.status, 0, `ts2emdash exited ${res.status}: ${res.stderr}`);
	preloaded = JSON.parse(readFileSync(join(out, "seed.json"), "utf8")) as Json;
	return preloaded;
}
const preloadedBlock = (slug: string, key: string): Json => preloadCases().content.posts.find((e: Json) => e.slug === slug)?.data.story.find((b: Json) => b._key === key) ?? {};

test("image-entity-preloaded", () => {
	// The rewritten block keeps its other keys
	const { asset, ...rest } = preloadedBlock("image", "im1");
	assert.equal(asset?._type, "reference");
	assert.equal(asset?.url, "/_emdash/api/media/file/ts-img1.jpg");
	assert.deepEqual(rest, {
		_type: "image",
		_key: "im1",
		alt: "Alt one",
		title: "Photo one",
		alignment: "center",
		link: { href: "https://example.test/page", blank: true },
		caption: "A caption",
		width: 4,
		height: 3,
	});
});

test("image-alt-from-description-only", () => {
	// img2 has a title and no description: TakeShape printed no alt, with or without the preload
	const { block } = caseOf("image-no-description");
	const b = block("im2");
	assert.equal(b.alt, undefined);
	assert.deepEqual(b.asset, { $media: { url: "https://assets.takeshape.io/proj/dev/img2/b.png", filename: "b.png" } });
	const { asset, link, ...rest } = preloadedBlock("image-no-description", "im2");
	assert.equal(asset?._type, "reference");
	assert.deepEqual(rest, { _type: "image", _key: "im2", title: "Photo two", alignment: "left", width: 4, height: 3 });
	// The preload moved the file the image links to into the media library
	assert.match(String((link as { href?: string })?.href), /^\/_emdash\/api\/media\/file\/ts-url-[0-9a-f]{16}\.pdf$/);
	assert.equal((link as { blank?: boolean })?.blank, false);
});

test("image-link-to-takeshape-reported", () => {
	const { report } = draftCases();
	const section = report.split("## Links to TakeShape-hosted files")[1] ?? "";
	assert.ok(section.includes("- https://images.takeshape.io/proj/dev/files/guide.pdf (in posts/image-no-description)"), `report section:\n${section}`);
});

test("kept-content-reported", () => {
	const { block } = caseOf("kept-as-is");
	assert.equal(blockText(block("ka1")), "pic here");
	assert.deepEqual(block("ka2"), { _type: "htmlBlock", _key: "ka2", html: "<figure><img/></figure>" });
	assert.deepEqual(block("ka3"), { _type: "htmlBlock", _key: "ka3", html: "<figure>&nbsp;</figure>" });
	const { report } = draftCases();
	assert.ok(!report.includes("could not be converted"), "the report says content was left out");
	assert.ok(report.includes("- 1 image inside rich text paragraphs (entity \"IMAGE\") was not converted. Its paragraph text was kept as plain text."), report);
	assert.ok(report.includes("- 1 rich text image points at an asset missing from the export. It was kept as TakeShape's fallback HTML, an empty figure."), report);
	assert.ok(report.includes("- 1 rich text block of type \"video\" was not converted. It was kept as TakeShape's fallback HTML, a figure holding the block's text."), report);
});

test("oembed-html-kept", () => {
	const { block, sidecar } = caseOf("oembed");
	assert.deepEqual(block("oe1"), { _type: "htmlBlock", _key: "oe1", html: OEMBED_HTML });
	assert.deepEqual(sidecar.oe1, { oembed: true });
	const text = block("oe-b");
	assert.equal(blockText(text), "Watch it ");
	assert.deepEqual(text.markDefs, []);
	assert.equal(sidecar["oe-b"], undefined);
	assert.ok(!draftCases().text.includes("⟦ts-embed"), "the seed still holds a ⟦ts-embed⟧ marker");
});

test("empty-block-kept", () => {
	const { blocks, block } = caseOf("empty-block");
	assert.deepEqual(
		blocks.map((b) => b._key),
		["eb-a", "eb1", "eb-b"],
	);
	assert.deepEqual(block("eb1"), { _type: "block", _key: "eb1", style: "normal", children: [{ _type: "span", _key: "eb1-s0", text: "", marks: [] }], markDefs: [] });
});

test("nested-list-levels", () => {
	const { blocks } = caseOf("nested-list");
	assert.deepEqual(
		blocks.map((b) => [b._key, b.listItem, b.level, blockText(b)]),
		[
			["nl1", "bullet", 1, "One"],
			["nl2", "bullet", 2, "One.a"],
			["nl3", "bullet", 1, "Two"],
		],
	);
});

test("emoji-offsets", () => {
	const { block } = caseOf("emoji");
	assert.deepEqual(spans(block("em1")), [
		{ text: "😀 ", marks: [] },
		{ text: "bold", marks: ["strong"] },
		{ text: " move", marks: [] },
	]);
});

test("deterministic-keys", () => {
	const a = convertSpec(WITH_DRAFT_CASES);
	const b = convertSpec(WITH_DRAFT_CASES);
	assert.ok(a.text === b.text, "two runs wrote different seeds");
});

test("shape-books-regression", () => {
	const fixture = join(root, "test", "fixtures", "shape-books");
	// Every pullquote's text, read straight from the export
	const pullquotes: string[] = [];
	for (const line of readFileSync(join(fixture, "data.jsonl"), "utf8").split("\n").filter(Boolean)) {
		for (const v of Object.values(JSON.parse(line) as Json)) {
			const raw = typeof v === "string" && v.startsWith("{") ? JSON.parse(v) : null;
			for (const b of raw?.blocks ?? []) if (b.type === "pullquote") pullquotes.push(b.text);
		}
	}
	assert.equal(pullquotes.length, 5, `found ${pullquotes.length} pullquotes in the export`);
	const { seed } = convertDir(fixture);
	const blocks: Json[] = [];
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (!v || typeof v !== "object") return;
		const o = v as Json;
		if (typeof o._type === "string" && typeof o._key === "string") blocks.push(o);
		Object.values(o).forEach(walk);
	};
	for (const list of Object.values(seed.content as Record<string, Json[]>)) for (const e of list) for (const [k, v] of Object.entries(e.data)) if (k !== "takeshape_rich_text") walk(v);
	const quotes = blocks.filter((b) => b._type === "block" && b.style === "blockquote").map(blockText);
	for (const text of pullquotes) assert.ok(quotes.includes(text), `pullquote missing from the seed: ${text.slice(0, 60)}`);
	assert.equal(blocks.filter((b) => b._type === "break").length, 3);
});
