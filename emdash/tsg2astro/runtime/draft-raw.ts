/**
 * Draft.js raw JSON rebuilt from the Portable Text ts2emdash writes. A query that selects a rich text field without
 * `Html` got the stored Draft.js from TakeShape, and templates read it (as in `item.title.blocks[0].text`).
 * Block keys are Draft.js's own, so each block comes back with its key, text and type, list depth, the inline
 * styles Portable Text has marks for, and its links. Images keep their asset id, contentTypeId, alignment, size, link,
 * caption and credit, oEmbeds their HTML. Not kept: styles without a mark (SMALL), images inside a paragraph, depth on
 * blocks other than list items, block types the converter stored as paragraphs, an image's TakeShape path, empty
 * captions and credits, and text on an atomic block other than its one space.
 *
 * Erasable TypeScript; imports types only.
 */
import type { PTBlock, PTMarkDef, RichTextSidecarEntry } from "./portable-text.ts";

export type DraftRange = { offset: number; length: number };
export type DraftRawBlock = {
	key: string;
	text: string;
	type: string;
	depth: number;
	inlineStyleRanges: Array<DraftRange & { style: string }>;
	entityRanges: Array<DraftRange & { key: number }>;
	data: Record<string, unknown>;
};
export type DraftEntity = { type: string; mutability: string; data: Record<string, unknown> };
export type DraftRawValue = { blocks: DraftRawBlock[]; entityMap: Record<string, DraftEntity> };

const HEADINGS: Record<string, string> = { h1: "header-one", h2: "header-two", h3: "header-three", h4: "header-four", h5: "header-five", h6: "header-six" };
const STYLES: Record<string, string> = { strong: "BOLD", em: "ITALIC", underline: "UNDERLINE", "strike-through": "STRIKETHROUGH", code: "CODE", subscript: "SUB", superscript: "SUP" };

/** Runs of the same value in per-character lists, as Draft.js ranges, in order of first appearance. */
function runs<T>(perChar: T[][]): Array<DraftRange & { value: T }> {
	const out: Array<DraftRange & { value: T }> = [];
	const seen: T[] = [];
	for (const list of perChar) for (const v of list) if (!seen.includes(v)) seen.push(v);
	for (const value of seen) {
		for (let i = 0; i < perChar.length; i++) {
			if (!perChar[i]!.includes(value)) continue;
			let end = i;
			while (end < perChar.length && perChar[end]!.includes(value)) end++;
			out.push({ offset: i, length: end - i, value });
			i = end;
		}
	}
	return out;
}

/** A link markDef's entity data, with TakeShape's names: url, then the attributes the converter kept. */
function linkData(def: PTMarkDef): Record<string, unknown> {
	const data: Record<string, unknown> = { url: typeof def.href === "string" ? def.href : "" };
	// As richtext.ts prints it: `blank` decides new-tab, so an editor's edit wins over the imported _blank
	const target = def.blank === true ? "_blank" : typeof def.tsTarget === "string" && def.tsTarget !== "_blank" ? def.tsTarget : "";
	if (target) data.target = target;
	for (const [name, field] of [["title", "tsTitle"], ["rel", "tsRel"], ["className", "tsClass"]] as const) if (typeof def[field] === "string") data[name] = def[field];
	if (def.tsData && typeof def.tsData === "object") Object.assign(data, def.tsData);
	return data;
}

/**
 * An image's caption as Draft.js: the entity's own, unless the block's caption was edited in EmDash since, as
 * richtext.ts prints it. An edited caption is plain text, one paragraph.
 */
function imageCaption(block: PTBlock, entry: RichTextSidecarEntry | undefined, key: string): DraftRawValue | null {
	const text = typeof block.caption === "string" ? block.caption : "";
	if (entry?.caption && text === (entry.captionText ?? "")) return draftRaw(entry.caption, undefined);
	if (!text) return null;
	return { blocks: [{ key: `${key}c`, text, type: "unstyled", depth: 0, inlineStyleRanges: [], entityRanges: [], data: {} }], entityMap: {} };
}

/** The Draft.js a field held, from its Portable Text and its sidecar entries. Null when the field is empty. */
export function draftRaw(blocks: unknown, sidecar: Record<string, RichTextSidecarEntry> | undefined): DraftRawValue | null {
	if (!Array.isArray(blocks) || !blocks.length) return null;
	const entityMap: Record<string, DraftEntity> = {};
	let nextEntity = 0;
	const entity = (type: string, mutability: string, data: Record<string, unknown>) => {
		const key = nextEntity++;
		entityMap[String(key)] = { type, mutability, data };
		return key;
	};
	const out: DraftRawBlock[] = [];
	for (const raw of blocks) {
		if (!raw || typeof raw !== "object") continue;
		const b = raw as PTBlock;
		const key = typeof b._key === "string" ? b._key : "";
		const entry = sidecar?.[key];
		const block: DraftRawBlock = { key, text: "", type: "unstyled", depth: 0, inlineStyleRanges: [], entityRanges: [], data: {} };
		const atomic = (type: string, data: Record<string, unknown>) => {
			block.type = "atomic";
			block.text = " ";
			block.entityRanges = [{ offset: 0, length: 1, key: entity(type, "IMMUTABLE", data) }];
		};
		if (b._type === "block") {
			const style = typeof b.style === "string" ? b.style : "normal";
			if (b.listItem === "bullet" || b.listItem === "number") {
				block.type = b.listItem === "bullet" ? "unordered-list-item" : "ordered-list-item";
				block.depth = Math.max(0, (Number(b.level) || 1) - 1);
			} else if (HEADINGS[style]) block.type = HEADINGS[style]!;
			else if (style === "blockquote") block.type = entry?.pullquote ? "pullquote" : "blockquote";
			const defs = new Map((b.markDefs ?? []).map((d) => [d._key, d] as const));
			const styles: string[][] = [];
			const links: string[][] = [];
			for (const span of b.children ?? []) {
				const text = typeof span.text === "string" ? span.text : "";
				const marks = Array.isArray(span.marks) ? span.marks.map(String) : [];
				const own = marks.map((m) => STYLES[m]).filter((s): s is string => Boolean(s));
				const linked = marks.filter((m) => defs.get(m)?._type === "link");
				block.text += text;
				// Draft.js counts offsets in code points, so an emoji is one character
				for (const _ of text) {
					styles.push(own);
					links.push(linked);
				}
			}
			block.inlineStyleRanges = runs(styles).map(({ offset, length, value }) => ({ offset, length, style: value }));
			block.entityRanges = runs(links).map(({ offset, length, value }) => ({ offset, length, key: entity("LINK", "MUTABLE", linkData(defs.get(value)!)) }));
		} else if (b._type === "image") {
			const data: Record<string, unknown> = {};
			if (entry?.assetId) {
				data.id = entry.assetId;
				data.contentTypeId = "ASSET";
			}
			if (typeof b.alignment === "string") data.alignment = b.alignment;
			if (entry?.size) data.size = entry.size;
			const link = b.link && typeof b.link === "object" ? (b.link as { href?: unknown; blank?: unknown }) : undefined;
			if (typeof link?.href === "string" && link.href) data.link = { url: link.href, external: link.blank === true };
			const caption = imageCaption(b, entry, key);
			if (caption) data.caption = caption;
			const credit = entry?.credit ? draftRaw(entry.credit, undefined) : null;
			if (credit) data.credit = credit;
			atomic("image", data);
		} else if (b._type === "htmlBlock") {
			if (entry?.oembed) atomic("oembed", { html: typeof b.html === "string" ? b.html : "" });
			else {
				block.type = "atomic";
				block.text = " ";
			}
		} else if (b._type === "code") {
			block.type = "code-block";
			block.text = typeof b.code === "string" ? b.code : "";
			if (typeof b.language === "string" && b.language) block.data = { lang: b.language };
		} else if (b._type === "break") block.type = "section-break";
		out.push(block);
	}
	return out.length ? { blocks: out, entityMap } : null;
}
