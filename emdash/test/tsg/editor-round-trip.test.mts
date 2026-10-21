/**
 * What EmDash's editor keeps of the converter's Portable Text. The admin turns an entry's Portable Text into
 * ProseMirror JSON to edit it, and back when it saves. This runs the two converters emdash 1.3.0 exports
 * (portableTextToProsemirror with preserveIdentity, then prosemirrorToPortableText) over every rich-text value the
 * converter writes for the 2026 shape-books export, the nine fixtures and the crafted cases in
 * richtext-cases.json. It is a JSON round trip: the editor's TipTap schema is not involved, and the admin bundles
 * its own copy of the converters, which this does not run.
 *
 * What the migrated page needs to survive an edit: each block's `_key` (the takeshape_rich_text sidecar is keyed by
 * it), image alignment, and link attributes. Those all survive. Two things the renderer prints from do change, and
 * the test pins them as they are today: a list item more than one level deeper than the item above it moves under
 * that item, and an image with a title and no caption gets its title as caption.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { PTBlock, RichTextSidecarEntry } from "../../ts2emdash.mts";
import { load } from "../../tsg2astro/load.mts";
import { renderRichText } from "../../tsg2astro/runtime/richtext.ts";
import { writeSyntheticExport } from "../synthetic-export.mts";
import type { DraftRaw, SynthAsset } from "../synthetic-export.mts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const work = mkdtempSync(join(tmpdir(), "editor-round-trip-"));
after(() => rmSync(work, { recursive: true, force: true }));

const { portableTextToProsemirror, prosemirrorToPortableText } = await load<typeof import("emdash")>("emdash");

type Json = Record<string, any>;
type Value = { where: string; blocks: PTBlock[]; sidecar: Record<string, RichTextSidecarEntry> | undefined };

function convert(name: string, exportDir: string): Promise<Json> {
	const out = join(work, name);
	return new Promise((done, fail) => {
		const child = spawn(process.execPath, ["--no-warnings", "ts2emdash.mts", exportDir, "--out", join(out, "seed.json"), "--report", join(out, "report.md")], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => (code === 0 ? done(JSON.parse(readFileSync(join(out, "seed.json"), "utf8"))) : fail(new Error(`ts2emdash ${name} exited ${code}: ${stderr}`))));
	});
}

/** Image blocks as EmDash stores them after `emdash seed`: the asset is a reference to a media row. */
function applied(blocks: PTBlock[]): PTBlock[] {
	return blocks.map((b) => (b._type === "image" && b.asset?.$media ? { ...b, asset: { _type: "reference", _ref: "01MEDIA", url: "/_emdash/api/media/file/01MEDIA.jpg" } } : b));
}

/** Every Portable Text value in a seed, with its sidecar. */
function values(source: string, seed: Json): Value[] {
	const portableText = new Set<string>();
	for (const c of seed.collections ?? []) for (const f of c.fields ?? []) if (f.type === "portableText") portableText.add(`${c.slug}.${f.slug}`);
	const out: Value[] = [];
	for (const [collection, entries] of Object.entries<Json[]>(seed.content ?? {})) {
		for (const e of entries) {
			for (const [field, v] of Object.entries(e.data)) {
				if (!portableText.has(`${collection}.${field}`) || !Array.isArray(v)) continue;
				out.push({ where: `${source} ${e.id} ${field}`, blocks: applied(v as PTBlock[]), sidecar: e.data.takeshape_rich_text?.[field] });
			}
		}
	}
	return out;
}

const all: Value[] = [];
before(async () => {
	const sources: Array<[string, string]> = [["shape-books-2026", join(root, "test", "tsg", "sites", "shape-books", "export")]];
	for (const name of readdirSync(join(root, "test", "fixtures")).sort()) sources.push([name, join(root, "test", "fixtures", name)]);
	const cases: { assets: SynthAsset[]; cases: Record<string, DraftRaw> } = JSON.parse(readFileSync(join(here, "richtext-cases.json"), "utf8"));
	const casesExport = join(work, "cases-export");
	writeSyntheticExport(casesExport, { assets: cases.assets, posts: Object.entries(cases.cases).map(([name, story]) => ({ id: name, title: name, slug: name, story })) });
	sources.push(["cases", casesExport]);
	const seeds = await Promise.all(sources.map(([name, dir]) => convert(name, dir)));
	seeds.forEach((seed, i) => all.push(...values(sources[i]![0], seed)));
});

const roundTrip = (blocks: PTBlock[]): PTBlock[] => prosemirrorToPortableText(portableTextToProsemirror(blocks as never, { preserveIdentity: true })) as unknown as PTBlock[];
const html = (blocks: PTBlock[], sidecar: Value["sidecar"]) => renderRichText(blocks, sidecar, { imageUrl: (src) => src.url });
const links = (blocks: PTBlock[]) => blocks.flatMap((b) => ((b.markDefs ?? []) as Json[]).filter((m) => m._type === "link"));

test("block keys, image alignment and link attributes survive an edit", () => {
	assert.ok(all.length > 90, `${all.length} rich-text values`);
	for (const v of all) {
		const back = roundTrip(v.blocks);
		assert.deepEqual(back.map((b) => b._key), v.blocks.map((b) => b._key), v.where);
		// An image link's `blank: false` is dropped, which prints the same
		const images = (blocks: PTBlock[]) =>
			blocks.filter((b) => b._type === "image").map((b) => {
				const link = b.link as { href?: string; blank?: boolean } | undefined;
				return [b._key, b.alignment ?? null, link?.href ?? null, Boolean(link?.blank)];
			});
		assert.deepEqual(images(back), images(v.blocks), v.where);
		assert.deepEqual(links(back), links(v.blocks), v.where);
	}
	// The values hold what is checked here
	assert.deepEqual([...new Set(all.flatMap((v) => v.blocks.map((b) => b.alignment)).filter(Boolean))].sort(), ["center", "left", "right"]);
	assert.ok(all.some((v) => links(v.blocks).some((m) => "tsTarget" in m)));
});

test("the page prints the same after an edit, but for two changes", () => {
	const changed = new Map<string, { before: string; after: string }>();
	for (const v of all) {
		const before = html(v.blocks, v.sidecar);
		const after = html(roundTrip(v.blocks), v.sidecar);
		if (before !== after) changed.set(v.where, { before, after });
	}
	assert.deepEqual([...changed.keys()].sort(), ["cases ts-image-link story", "cases ts-nested-list story"]);

	// A list item two levels below the one above it moves under that item
	const list = changed.get("cases ts-nested-list story")!;
	assert.ok(list.before.includes("<li>Second</li>\n  <li>Skipped a level</li>"), list.before);
	assert.ok(list.after.includes("<li>Second\n    <ol>\n      <li>Skipped a level</li>\n    </ol>\n  </li>"), list.after);

	// An image with a title and no caption gets its title as caption
	const image = changed.get("cases ts-image-link story")!;
	assert.ok(image.before.includes('<img title="Photo two" src="/_emdash/api/media/file/01MEDIA.jpg"/></a><figcaption> <span class="credit">'), image.before);
	assert.equal(image.after, image.before.replace('<figcaption> <span class="credit">', '<figcaption><span class="caption">Photo two</span> <span class="credit">'));
});
