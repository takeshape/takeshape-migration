/**
 * runtime/draft-raw.ts: Draft.js raw JSON rebuilt from the Portable Text ts2emdash writes, for queries that select a
 * rich text field without Html (TakeShape returned the stored Draft.js there). Each crafted rich-text case goes
 * through the real converter and back, and keeps its blocks' keys, text and types, list depth, the styles Portable
 * Text has marks for, and its links.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { draftRaw } from "../../tsg2astro/runtime/draft-raw.ts";
import { writeSyntheticExport } from "../synthetic-export.mts";
import type { DraftRaw, SynthAsset } from "../synthetic-export.mts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const work = mkdtempSync(join(tmpdir(), "draft-raw-"));
after(() => rmSync(work, { recursive: true, force: true }));

type Json = Record<string, any>;
const cases: { assets: SynthAsset[]; cases: Record<string, DraftRaw> } = JSON.parse(readFileSync(join(here, "richtext-cases.json"), "utf8"));
writeSyntheticExport(join(work, "export"), {
	assets: cases.assets,
	posts: Object.entries(cases.cases).map(([name, story]) => ({ id: name, title: name, slug: name, story })),
});
const res = spawnSync(process.execPath, ["--no-warnings", "ts2emdash.mts", join(work, "export"), "--out", join(work, "seed.json"), "--report", join(work, "report.md")], { cwd: root, encoding: "utf8" });
assert.equal(res.status, 0, `ts2emdash exited ${res.status}: ${res.stderr}`);
const seed: Json = JSON.parse(readFileSync(join(work, "seed.json"), "utf8"));
const entries = new Map<string, Json>(Object.values<Json[]>(seed.content).flat().map((e) => [e.id, e.data]));

const MARKED = new Set(["BOLD", "ITALIC", "UNDERLINE", "STRIKETHROUGH", "CODE", "SUB", "SUP"]);
const LIST = new Set(["unordered-list-item", "ordered-list-item"]);
// Types the converter keeps as a paragraph, and atomic blocks, whose text Draft.js leaves to the entity
const typeOf = (b: Json) => (b.type === "atomic" ? "atomic" : ["unstyled", "header-one", "header-two", "header-three", "header-four", "header-five", "header-six", "blockquote", "pullquote", "code-block", "section-break", ...LIST].includes(b.type) ? b.type : "unstyled");
/** Each style's characters as ranges, touching ranges joined: Draft.js may store BOLD 0+4 and 4+4 for one run. */
function styleRuns(ranges: Json[]): string[] {
	const chars = new Map<string, Set<number>>();
	for (const r of ranges) for (let i = r.offset; i < r.offset + r.length; i++) (chars.get(r.style) ?? chars.set(r.style, new Set()).get(r.style)!).add(i);
	const out: string[] = [];
	for (const [style, set] of chars) {
		const sorted = [...set].sort((a, b) => a - b);
		for (let i = 0; i < sorted.length; ) {
			let j = i;
			while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
			out.push(`${style}@${sorted[i]}+${j - i + 1}`);
			i = j + 1;
		}
	}
	return out.sort();
}

/** What survives Portable Text, per block: key, text, type, list depth, marked styles, links as [offset, length, url]. */
function comparable(raw: Json) {
	return raw.blocks.map((b: Json) => ({
		key: b.key,
		text: b.type === "atomic" ? " " : b.type === "section-break" ? "" : b.text,
		type: typeOf(b),
		depth: LIST.has(b.type) ? b.depth : 0,
		// A code block keeps only its code: TakeShape printed it through Prism, without styles
		styles: b.type === "atomic" || b.type === "code-block" ? [] : styleRuns((b.inlineStyleRanges ?? []).filter((r: Json) => MARKED.has(r.style))),
		links: (b.entityRanges ?? [])
			.filter((r: Json) => String(raw.entityMap[r.key]?.type).toUpperCase() === "LINK")
			// TakeShape's link entities hold the address as url or href
			.map((r: Json) => `${r.offset}+${r.length}:${raw.entityMap[r.key].data.url || raw.entityMap[r.key].data.href || ""}`)
			.sort(),
	}));
}

// one-empty-block: TakeShape printed nothing and the converter stores nothing, so the field reads as null.
// inline-image: an image inside a paragraph keeps only its text (the converter's report counts it).
for (const name of Object.keys(cases.cases).filter((n) => n !== "one-empty-block" && n !== "inline-image")) {
	test(`${name} comes back as the Draft.js TakeShape stored`, () => {
		const data = entries.get(`ts-${name}`)!;
		const rebuilt = draftRaw(data.story, data.takeshape_rich_text?.story);
		assert.ok(rebuilt, "no value");
		assert.deepEqual(comparable(rebuilt), comparable(cases.cases[name] as Json));
	});
}

test("an empty field reads as null, as nothing was stored", () => {
	assert.equal(draftRaw(entries.get("ts-one-empty-block")!.story, undefined), null);
	assert.equal(draftRaw(undefined, undefined), null);
});

test("image blocks keep their asset id, alignment and size", () => {
	const data = entries.get("ts-image-link")!;
	const images = (raw: Json) =>
		raw.blocks
			.filter((b: Json) => b.type === "atomic")
			.map((b: Json) => raw.entityMap[b.entityRanges?.[0]?.key])
			.filter((e: Json) => e?.type === "image")
			.map((e: Json) => ({ id: e.data.id, alignment: e.data.alignment || undefined, size: e.data.size || undefined }));
	const rebuilt = images(draftRaw(data.story, data.takeshape_rich_text?.story)!);
	assert.equal(rebuilt.length, 3);
	assert.deepEqual(rebuilt, images(cases.cases["image-link"] as Json));
});

// A site's data files can print content as stored Draft.js, and TakeShape's image entities held the caption
// and credit as Draft.js of their own, the link, and contentTypeId. The asset's path is left out: it named
// TakeShape's CDN. An empty caption or credit (one empty paragraph) is left out too, as an empty field reads as null.
const imageData = (raw: Json) =>
	raw.blocks
		.filter((b: Json) => b.type === "atomic")
		.map((b: Json) => raw.entityMap[b.entityRanges?.[0]?.key])
		.filter((e: Json) => e?.type === "image")
		.map(({ data: d }: Json) => {
			const part = (v: Json | undefined) => (v && v.blocks.some((b: Json) => b.text) ? comparable(v) : undefined);
			return { contentTypeId: d.contentTypeId, link: d.link, caption: part(d.caption), credit: part(d.credit) };
		});

test("image entities keep their caption, credit, link and contentTypeId", () => {
	const data = entries.get("ts-image-link")!;
	const rebuilt = imageData(draftRaw(data.story, data.takeshape_rich_text?.story)!);
	assert.equal(rebuilt.length, 3);
	assert.deepEqual(rebuilt, imageData(cases.cases["image-link"] as Json));
});

test("a caption edited in EmDash comes back as its plain text, as richtext.ts prints it", () => {
	const data = entries.get("ts-image-link")!;
	const story = structuredClone(data.story) as Json[];
	const image = story.find((b) => b._type === "image" && b.caption)!;
	image.caption = "New caption";
	const entity = draftRaw(story, data.takeshape_rich_text?.story)!.entityMap;
	const captions = Object.values(entity).map((e) => (e.data.caption as Json | undefined)?.blocks.map((b: Json) => b.text));
	assert.deepEqual(captions[0], ["New caption"]);
});

// A link imported with target="_blank" keeps it as tsTarget; an editor who turns new-tab off sets blank to false, and
// the Draft.js follows the edit, as richtext.ts's HTML does. Another target stays.
test("a link's new-tab setting follows an edit in EmDash", () => {
	const block = (def: Record<string, unknown>) => [{ _type: "block", _key: "b", style: "normal", markDefs: [{ _type: "link", _key: "l", href: "https://x.test", ...def }], children: [{ _type: "span", _key: "s", text: "x", marks: ["l"] }] }];
	const target = (def: Record<string, unknown>) => draftRaw(block(def), undefined)!.entityMap["0"]!.data.target;
	assert.equal(target({ blank: true, tsTarget: "_blank" }), "_blank");
	assert.equal(target({ blank: false, tsTarget: "_blank" }), undefined);
	assert.equal(target({ blank: false, tsTarget: "_self" }), "_self");
	assert.equal(target({ blank: true }), "_blank");
});
