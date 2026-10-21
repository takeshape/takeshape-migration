/**
 * The Portable Text that ts2emdash writes for TakeShape's Draft.js fields,
 * and the `takeshape_rich_text` sidecar that holds what a block cannot.
 * richtext.ts renders these. Types only, so the file erases to nothing:
 * migrated sites get it with the rest of this folder, and ts2emdash.mts
 * imports it with `import type`, so the converter runs without it.
 */

/** A span of text with its decorators and link markDef keys. */
export interface PTSpan {
	_type?: string;
	_key?: string;
	text?: string;
	marks?: string[];
}

/** A link: href and blank, plus the attributes TakeShape printed (tsTarget, tsTitle, tsRel, tsClass, tsData) in tsAttrOrder. */
export interface PTMarkDef {
	_type?: string;
	_key?: string;
	href?: unknown;
	[key: string]: unknown;
}

/** A $media source in the seed. `emdash seed` downloads it and stores a reference with a url in its place. */
export interface PTMediaSource {
	url: string;
	filename?: string;
	alt?: string;
	caption?: string;
}

/** A Portable Text block or object: text blocks, image, code, break and htmlBlock. */
export interface PTBlock {
	_type?: string;
	_key?: string;
	style?: string;
	listItem?: string;
	level?: number;
	children?: PTSpan[];
	markDefs?: PTMarkDef[];
	asset?: { url?: string; _ref?: string; $media?: PTMediaSource };
	alt?: string;
	caption?: string;
	[key: string]: unknown;
}

/** What TakeShape's rich text had that a Portable Text block cannot hold, keyed by block _key. */
export type RichTextSidecarEntry = {
	pullquote?: true;
	oembed?: true;
	size?: string; // image size class from the entity: small | medium | large
	assetId?: string; // TakeShape asset id of an image block
	captionText?: string; // plain caption as stored on the block, to detect later edits
	caption?: PTBlock[]; // the entity's caption, as Portable Text, rendered plain
	credit?: PTBlock[];
};

/** One entry's sidecar: field slug, then block _key. */
export type RichTextSidecar = Record<string, Record<string, RichTextSidecarEntry>>;
