/**
 * Small TakeShape exports built in code, for tests that need assets and
 * posts shaped a particular way. They reuse the edge-cases fixture's
 * schema.json: Post (P1) has title t, slug s, Markdown body b, an image
 * list g and a file field br; Asset rows use TakeShape's built-in keys.
 * A spec whose posts hold a story also gets a Draft.js field, story (dj).
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SynthAsset {
	id: string;
	path: string;
	filename: string;
	mimeType: string;
	title?: string;
	description?: string;
}
export interface SynthPost {
	id: string;
	title: string;
	slug: string;
	body?: string;
	gallery?: string[];
	brochure?: string;
	/** Draft.js raw value, stored as a JSON string the way real exports store it */
	story?: DraftRaw;
}
export interface DraftBlock {
	key: string;
	text: string;
	type?: string;
	depth?: number;
	inlineStyleRanges?: { offset: number; length: number; style: string }[];
	entityRanges?: { offset: number; length: number; key: number }[];
	data?: Record<string, unknown>;
}
export interface DraftRaw {
	blocks: DraftBlock[];
	entityMap: Record<string, { type: string; mutability: string; data: Record<string, unknown> }>;
}
export interface SynthSpec {
	assets: SynthAsset[];
	posts: SynthPost[];
}

const schemaFile = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "edge-cases", "schema.json");

export function writeSyntheticExport(dir: string, spec: SynthSpec): void {
	mkdirSync(dir, { recursive: true });
	if (spec.posts.some((p) => p.story)) {
		const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
		schema.shapes.Post.schema.properties.story = { type: "object", title: "Story", "@mapping": "takeshape:local:Post.dj", "@tag": "draftjs" };
		schema.forms.Post.default.properties.story = { widget: "wysiwygText" };
		schema.forms.Post.default.order.push("story");
		writeFileSync(join(dir, "schema.json"), `${JSON.stringify(schema, null, 2)}\n`);
	} else copyFileSync(schemaFile, join(dir, "schema.json"));
	const assetRows = spec.assets.map((a) => ({
		_id: a.id,
		_shapeId: "ASSET",
		_enabled: true,
		Hk6FQuz5: a.path,
		H1oYQOM9: a.filename,
		SyCYX_Gq: a.mimeType,
		...(a.title ? { By5tQOMc: a.title } : {}),
		...(a.description ? { B1Zsra3fx: a.description } : {}),
	}));
	const postRows = spec.posts.map((p) => ({
		_id: p.id,
		_shapeId: "P1",
		_enabled: true,
		t: p.title,
		s: p.slug,
		...(p.body ? { b: p.body } : {}),
		...(p.gallery ? { g: p.gallery.map((id) => ({ shapeId: "ASSET", id })) } : {}),
		...(p.brochure ? { br: { shapeId: "ASSET", id: p.brochure } } : {}),
		...(p.story ? { dj: JSON.stringify(p.story) } : {}),
	}));
	writeFileSync(join(dir, "data.jsonl"), `${[...assetRows, ...postRows].map((r) => JSON.stringify(r)).join("\n")}\n`);
}

/** A minimal PNG (signature, IHDR, IEND): enough for image-size to read width and height. 45 bytes. */
export function pngHeader(width: number, height: number): Uint8Array {
	const b = Buffer.alloc(45);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "ascii");
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	b[24] = 8; // bit depth
	b[25] = 6; // RGBA
	b.writeUInt32BE(0, 33); // IEND length
	b.write("IEND", 37, "ascii");
	return new Uint8Array(b);
}

export const FIELDS_ONLY: SynthSpec = {
	assets: [
		{ id: "img1", path: "proj/dev/img1/photo one.jpg", filename: "photo one.jpg", mimeType: "image/jpeg", title: "Photo one" },
		{ id: "img2", path: "proj/dev/img2/b.png", filename: "b.png", mimeType: "image/png" },
		{ id: "pdf1", path: "proj/dev/pdf1/brochure.pdf", filename: "brochure.pdf", mimeType: "application/pdf" },
	],
	posts: [
		{ id: "a", title: "Post A", slug: "post-a", gallery: ["img1", "img2"], brochure: "pdf1" },
		{ id: "b", title: "Post B", slug: "post-b", gallery: ["img1"] },
	],
};

export const WITH_RICH_TEXT: SynthSpec = {
	assets: FIELDS_ONLY.assets,
	posts: FIELDS_ONLY.posts.map((p) =>
		p.id === "a"
			? { ...p, body: "Intro\n\n![Small b](https://images.takeshape.io/proj/dev/img2/b.png?w=300)\n\n![Orphan](https://images.takeshape.io/proj/dev/orphan/orphan.jpg)" }
			: p,
	),
};

const draft = (blocks: DraftBlock[], entityMap: DraftRaw["entityMap"] = {}): DraftRaw => ({
	blocks: blocks.map((b) => ({ type: "unstyled", depth: 0, inlineStyleRanges: [], entityRanges: [], data: {}, ...b })),
	entityMap,
});
const post = (slug: string, story: DraftRaw): SynthPost => ({ id: slug, title: slug, slug, story });

export const OEMBED_HTML = '<iframe width="480" height="270" src="https://www.youtube.com/embed/abc?feature=oembed" frameborder="0" allowfullscreen></iframe>';

/** One post per Draft.js case, each named by its slug. Block keys are the ones the tests look up. */
export const WITH_DRAFT_CASES: SynthSpec = {
	assets: [
		{ id: "img1", path: "proj/dev/img1/photo one.jpg", filename: "photo one.jpg", mimeType: "image/jpeg", title: "Photo one", description: "Alt one" },
		{ id: "img2", path: "proj/dev/img2/b.png", filename: "b.png", mimeType: "image/png", title: "Photo two" },
	],
	posts: [
		post("pullquote", draft([{ key: "pq-a", text: "Before." }, { key: "pq1", text: "Quote me.", type: "pullquote" }, { key: "pq-b", text: "After." }])),
		post("section-break", draft([{ key: "sb-a", text: "One" }, { key: "sb1", text: "", type: "section-break" }, { key: "sb-b", text: "Two" }])),
		post(
			"marks",
			draft([
				{
					key: "mk1",
					text: "H2O, x2 and underlined",
					inlineStyleRanges: [
						{ offset: 1, length: 1, style: "SUB" },
						{ offset: 6, length: 1, style: "SUP" },
						{ offset: 12, length: 10, style: "UNDERLINE" },
					],
				},
			]),
		),
		post(
			"link",
			draft([{ key: "ln1", text: "Visit x now", entityRanges: [{ offset: 6, length: 1, key: 0 }] }], {
				0: { type: "LINK", mutability: "MUTABLE", data: { url: "https://x.test", target: "_blank" } },
			}),
		),
		post(
			"image",
			draft([{ key: "im-a", text: "Intro" }, { key: "im1", text: " ", type: "atomic", entityRanges: [{ offset: 0, length: 1, key: 0 }] }], {
				0: {
					type: "image",
					mutability: "IMMUTABLE",
					data: {
						id: "img1",
						caption: draft([{ key: "cap1", text: "A caption" }]),
						credit: draft([{ key: "cr1", text: "Photo by Jo", entityRanges: [{ offset: 9, length: 2, key: 0 }] }], {
							0: { type: "LINK", mutability: "MUTABLE", data: { href: "https://jo.test", title: "Jo", url: "https://jo.test" } },
						}),
						alignment: "center",
						size: "large",
						link: { url: "https://example.test/page", external: true },
						contentTypeId: "ASSET",
					},
				},
			}),
		),
		post(
			"oembed",
			draft(
				[
					{ key: "oe1", text: " ", type: "atomic", entityRanges: [{ offset: 0, length: 1, key: 0 }] },
					{ key: "oe-b", text: "Watch it ", entityRanges: [{ offset: 8, length: 1, key: 1 }] },
				],
				{
					0: { type: "oembed", mutability: "IMMUTABLE", data: { html: OEMBED_HTML } },
					1: { type: "oembed", mutability: "IMMUTABLE", data: { html: OEMBED_HTML } },
				},
			),
		),
		post("empty-block", draft([{ key: "eb-a", text: "A" }, { key: "eb1", text: "" }, { key: "eb-b", text: "B" }])),
		post(
			"nested-list",
			draft([
				{ key: "nl1", text: "One", type: "unordered-list-item" },
				{ key: "nl2", text: "One.a", type: "unordered-list-item", depth: 1 },
				{ key: "nl3", text: "Two", type: "unordered-list-item" },
			]),
		),
		post("emoji", draft([{ key: "em1", text: "😀 bold move", inlineStyleRanges: [{ offset: 2, length: 4, style: "BOLD" }] }])),
		// An asset with a title and no description, linked to a file on TakeShape's CDN
		post(
			"image-no-description",
			draft([{ key: "im2", text: " ", type: "atomic", entityRanges: [{ offset: 0, length: 1, key: 0 }] }], {
				0: { type: "image", mutability: "IMMUTABLE", data: { id: "img2", alignment: "left", link: { url: "https://images.takeshape.io/proj/dev/files/guide.pdf", external: false }, contentTypeId: "ASSET" } },
			}),
		),
		// A paragraph indented under a list item (Draft.js keeps its depth), and one with a depth but no list before it
		post(
			"nested-paragraph",
			draft([
				{ key: "np0", text: "Not under a list", depth: 1 },
				{ key: "np1", text: "One", type: "unordered-list-item" },
				{ key: "np2", text: "Indented note", depth: 1 },
				{ key: "np3", text: "One.a", type: "unordered-list-item", depth: 1 },
				{ key: "np4", text: "Two", type: "unordered-list-item" },
			]),
		),
		// A caption holding blocks that TakeShape's caption renderer (rawToHTML) printed as paragraphs
		post(
			"caption-blocks",
			draft([{ key: "cb1", text: " ", type: "atomic", entityRanges: [{ offset: 0, length: 1, key: 0 }] }], {
				0: {
					type: "image",
					mutability: "IMMUTABLE",
					data: {
						id: "img1",
						caption: draft([
							{ key: "cq1", text: "A pullquote", type: "pullquote" },
							{ key: "cs1", text: " ", type: "section-break" },
							{ key: "cq2", text: "A blockquote", type: "blockquote" },
						]),
						contentTypeId: "ASSET",
					},
				},
			}),
		),
		// Content kept as TakeShape printed it, without converting the entity
		post(
			"kept-as-is",
			draft(
				[
					{ key: "ka1", text: "pic here", entityRanges: [{ offset: 0, length: 3, key: 0 }] },
					{ key: "ka2", text: " ", type: "atomic", entityRanges: [{ offset: 0, length: 1, key: 1 }] },
					{ key: "ka3", text: " ", type: "atomic", entityRanges: [{ offset: 0, length: 1, key: 2 }] },
				],
				{
					0: { type: "IMAGE", mutability: "IMMUTABLE", data: { src: "https://example.test/a.png" } },
					1: { type: "image", mutability: "IMMUTABLE", data: { id: "not-in-export", alignment: "center" } },
					2: { type: "video", mutability: "IMMUTABLE", data: { url: "https://example.test/v.mp4" } },
				},
			),
		),
	],
};
