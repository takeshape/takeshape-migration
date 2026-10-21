/*
Ported from draft-js-export-html (github.com/sstur/draft-js-utils), by way of TakeShape's fork of it: the markup
generator (generate) and the text and attribute encoding (encodeContent, encodeAttr). Its license:

ISC License

Copyright (c) 2016, Simon Sturmer <sstur@me.com>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

The block element list (MINIFY_BLOCKS) is copied from rehype-minify-whitespace 5.0.0
(github.com/rehypejs/rehype-minify). Its license:

(The MIT License)

Copyright (c) 2016 Titus Wormer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
/**
 * Portable Text to the exact HTML TakeShape printed for a rich text field's
 * `*Html`. A port of TakeShape's renderer (its fork of draft-js-export-html
 * and its image and oEmbed templates), reading the blocks
 * ts2emdash writes and the `takeshape_rich_text` sidecar that holds what a
 * block cannot: pullquotes, oEmbeds, image sizes, captions and credits.
 *
 * Migrated sites get this file as source. It is erasable TypeScript and
 * imports only the two packages TakeShape used, at TakeShape's versions:
 * github-slugger 1.5.0 for heading ids and prismjs 1.29.0 for code blocks.
 */

import GithubSlugger from "github-slugger";
import Prism from "prismjs";
// TakeShape's Prism bundle loaded these components after Prism's default
// build, in this order. The order decides how grammars embed each other.
import "prismjs/components/prism-clike.js";
import "prismjs/components/prism-markup.js";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-markup-templating.js";
import "prismjs/components/prism-css.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-django.js";
import "prismjs/components/prism-twig.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-graphql.js";
import "prismjs/components/prism-sass.js";
import "prismjs/components/prism-scss.js";
import "prismjs/components/prism-json.js";
import type { PTBlock, PTMarkDef, PTSpan, RichTextSidecarEntry } from "./portable-text.ts";

export type ImageParams = Record<string, string | number | boolean>;
export type RichTextOptions = {
	classPrefix?: string;
	headerIdPrefix?: string;
	images?: { default?: ImageParams; small?: ImageParams; medium?: ImageParams; large?: ImageParams };
	imageUrl: (src: { url: string; storageKey?: string }, params: ImageParams | undefined) => string;
	plain?: boolean; // TakeShape's rawToHTML for captions and credits: no heading ids, SUB, SUP and SMALL dropped
};

type Sidecar = Readonly<Record<string, RichTextSidecarEntry>>;
type Tag = string | { element: string; class: string };

/** A block as TakeShape's exporter walked it: its kind, the list it sits in, and its depth. */
interface Item {
	block: PTBlock;
	kind: "text" | "image" | "code" | "break" | "html";
	list: "ul" | "ol" | null;
	depth: number;
	entry: RichTextSidecarEntry | undefined;
}

interface Context {
	options: RichTextOptions;
	plain: boolean;
	prefix: (className: string) => string;
	slugger: GithubSlugger | undefined;
}

const BREAK = "<br>";
const INDENT = "  ";
// Marks innermost first, as TakeShape nested its inline styles, with the tag each printed
const MARK_TAGS: [mark: string, tag: string][] = [
	["strong", "strong"], ["em", "em"], ["underline", "ins"], ["strike-through", "del"], ["code", "code"],
	["small", "small"], ["subscript", "sub"], ["superscript", "sup"],
];
// rawToHTML, used for captions and credits, knew only the first five
const PLAIN_MARK_TAGS = MARK_TAGS.slice(0, 5);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const MEDIA_FILE = /\/_emdash\/api\/media\/file\/([^?#]+)/;
const LODASH_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Text content, as draft-js-export-html encoded it. */
function encodeContent(text: string): string {
	return text.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split("\xA0").join("&nbsp;").split("\n").join(`${BREAK}\n`);
}

/** Attribute values, as draft-js-export-html encoded them. */
function encodeAttr(text: string): string {
	return text.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;");
}

/** lodash's escape, which TakeShape's image and code templates used. */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => LODASH_ESCAPES[c]);
}

/** A space at either end, or after another space, becomes a non-breaking space so HTML keeps it. */
function preserveWhitespace(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) out += text[i] === " " && (i === 0 || i === text.length - 1 || text[i - 1] === " ") ? "\xA0" : text[i];
	return out;
}

/** TakeShape's removeExtraBlankLines, applied to a whole field. */
function removeExtraBlankLines(html: string): string {
	return html
		.replace(/^(<p><br><\/p>\n)+/, "")
		.replace(/<\/figure>\n<p><br><\/p>/g, "</figure>")
		.replace(/<\/iframe>\n<p><br><\/p>/g, "</iframe>")
		.replace(/(\n<p><br><\/p>)+$/, "");
}

const spansOf = (block: PTBlock): PTSpan[] => (Array.isArray(block.children) ? block.children.filter((s) => isObj(s) && typeof s.text === "string") : []);
const textOf = (block: PTBlock): string => spansOf(block).map((s) => s.text).join("");
const marksOf = (s: PTSpan): string[] => (Array.isArray(s.marks) ? s.marks : []);

function entryFor(sidecar: Sidecar | undefined, key: unknown): RichTextSidecarEntry | undefined {
	return sidecar && typeof key === "string" && Object.hasOwn(sidecar, key) && isObj(sidecar[key]) ? sidecar[key] : undefined;
}

/** The blocks TakeShape's exporter would have walked. Unknown block types print nothing. */
function itemsOf(blocks: readonly PTBlock[], sidecar: Sidecar | undefined): Item[] {
	const items: Item[] = [];
	for (const block of blocks) {
		if (!isObj(block)) continue;
		const entry = entryFor(sidecar, block._key);
		const item = (kind: Item["kind"]): Item => ({ block, kind, list: null, depth: 0, entry });
		if (block._type === "block") {
			const it = item("text");
			if (block.listItem) {
				it.list = block.listItem === "number" ? "ol" : "ul";
				it.depth = Math.max(0, (Number(block.level) || 1) - 1);
			}
			items.push(it);
		} else if (block._type === "image") items.push(item("image"));
		else if (block._type === "code") items.push(item("code"));
		else if (block._type === "break") items.push(item("break"));
		else if (block._type === "htmlBlock" && (str(block.html) || entry?.oembed)) items.push(item("html"));
	}
	return items;
}

/** ContentState.hasText: more than one block, or one block with text. */
function hasText(items: Item[]): boolean {
	if (items.length !== 1) return items.length > 1;
	const { kind, block } = items[0];
	if (kind === "text") return textOf(block).length > 0;
	if (kind === "code") return str(block.code).length > 0;
	return true;
}

/** A link's attributes in the order TakeShape printed them, following any edit to href or new-tab. */
function linkAttrs(def: PTMarkDef): string {
	const href = str(def.href);
	const target = def.blank === true ? "_blank" : def.tsTarget !== "_blank" ? str(def.tsTarget) : "";
	const values: Record<string, unknown> = { href, target, title: def.tsTitle, rel: def.tsRel, class: def.tsClass };
	if (isObj(def.tsData)) for (const [k, v] of Object.entries(def.tsData)) if (k.startsWith("data-")) values[k] = v;
	const names = Array.isArray(def.tsAttrOrder) ? def.tsAttrOrder.map(String) : ["href", "target"];
	if (href && !names.includes("href")) names.unshift("href");
	if (target && !names.includes("target")) names.push("target");
	let attrs = "";
	for (const name of names) if (values[name]) attrs += ` ${name}="${encodeAttr(String(values[name]))}"`;
	return attrs;
}

/** A text block's content: links wrap runs of styled spans, each span wrapped in its own tags. */
function spanContent(block: PTBlock, tags: [string, string][]): string {
	const spans = spansOf(block);
	const text = spans.map((s) => s.text).join("");
	if (text === "") return BREAK;
	const preserved = preserveWhitespace(text);
	const links = new Map<string, PTMarkDef>();
	for (const def of Array.isArray(block.markDefs) ? block.markDefs : []) if (isObj(def) && def._type === "link" && typeof def._key === "string") links.set(def._key, def);
	const linkOf = (s: PTSpan) => marksOf(s).map((m) => links.get(m)).find(Boolean);
	let html = "";
	let pos = 0;
	for (let i = 0; i < spans.length; ) {
		const link = linkOf(spans[i]);
		let content = "";
		for (; i < spans.length && linkOf(spans[i]) === link; i++) {
			const len = str(spans[i].text).length;
			if (!len) continue;
			let piece = encodeContent(preserved.slice(pos, pos + len));
			pos += len;
			const marks = marksOf(spans[i]);
			for (const [mark, tag] of tags) if (marks.includes(mark)) piece = `<${tag}>${piece}</${tag}>`;
			content += piece;
		}
		html += link ? `<a${linkAttrs(link)}>${content}</a>` : content;
	}
	return html;
}

/** TakeShape's code template: Prism for a language its bundle loaded, lodash-escaped text otherwise. */
function codeHtml(block: PTBlock, ctx: Context): string {
	const text = str(block.code);
	const lang = str(block.language).toLowerCase();
	const grammar = lang ? Prism.languages[lang] : undefined;
	const code = grammar ? Prism.highlight(text, grammar, lang) : escapeHtml(text);
	return `<pre><code${lang ? ` class="${ctx.prefix(`language-${lang}`)}"` : ""}>${code}</code></pre>`;
}

/** The caption as stored with the entity, unless it was edited since: then the block's own caption, escaped. */
function captionHtml(block: PTBlock, entry: RichTextSidecarEntry | undefined, ctx: Context): string {
	const caption = str(block.caption);
	if (entry && caption === (entry.captionText ?? "") && entry.caption) return renderRichText(entry.caption, undefined, { ...ctx.options, plain: true });
	return encodeContent(caption);
}

/** TakeShape's image template. Empty without an asset, so the block falls back to a bare figure. */
function imageHtml(block: PTBlock, entry: RichTextSidecarEntry | undefined, ctx: Context): string {
	const asset: Record<string, unknown> | undefined = isObj(block.asset) ? block.asset : undefined;
	const url = str(asset?.url);
	if (!url) return "";
	const size = str(entry?.size);
	const images = ctx.options.images as Record<string, ImageParams | undefined> | undefined;
	const params = images ? (size && Object.hasOwn(images, size) ? images[size] : undefined) || images.default : undefined;
	const storageKey = str(asset?.storageKey) || MEDIA_FILE.exec(url)?.[1];
	const src = ctx.options.imageUrl(storageKey ? { url, storageKey } : { url }, params);

	const caption = captionHtml(block, entry, ctx);
	const credit = entry?.credit ? renderRichText(entry.credit, undefined, { ...ctx.options, plain: true }) : "";
	let figCaption = "";
	if (caption || credit) {
		const captionSpan = caption ? `<span class="${ctx.prefix("caption")}">${caption}</span>` : "";
		const creditSpan = credit ? `<span class="${ctx.prefix("credit")}">${credit}</span>` : "";
		figCaption = `<figcaption>${captionSpan} ${creditSpan}</figcaption>`;
	}
	const classes = [ctx.prefix(str(block.alignment)), ctx.prefix(size)].filter(Boolean).join(" ");
	const imgAttrs = [["alt", block.alt], ["title", block.title]].filter(([, v]) => v).map(([k, v]) => `${k}="${escapeHtml(String(v))}"`);
	let image = `<img${imgAttrs.length ? ` ${imgAttrs.join(" ")}` : ""} src="${src}"/>`;
	const link = isObj(block.link) ? block.link : undefined;
	// target="blank" without the underscore is what TakeShape printed
	if (str(link?.href)) image = `<a href="${str(link?.href)}"${link?.blank ? ' target="blank" rel="noopener noreferrer"' : ""}>${image}</a>`;
	return `<figure${classes ? ` class="${classes}"` : ""}>${image}${figCaption}</figure>`;
}

/** What TakeShape's block renderers printed in place of the default tags, or "" to use them. */
function customHtml(item: Item, ctx: Context): string {
	const { block, kind, entry } = item;
	if (kind === "html") return entry?.oembed ? `<div class="${ctx.prefix("oembed")}">${str(block.html)}</div>` : str(block.html);
	if (ctx.plain) return "";
	if (kind === "image") return imageHtml(block, entry, ctx);
	if (kind === "code") return codeHtml(block, ctx);
	if (kind === "break") return "<hr/>";
	const style = str(block.style);
	if (!item.list && HEADINGS.has(style) && ctx.slugger) {
		// An id needs at least one character
		const text = textOf(block);
		const id = text.length > 0 ? ` id="${ctx.slugger.slug(`${ctx.options.headerIdPrefix ?? ""}${text}`)}"` : "";
		return `<${style}${id}>${spanContent(block, MARK_TAGS)}</${style}>`;
	}
	return "";
}

/** The default tags for a block the custom renderers left alone. */
function tagsOf(item: Item, ctx: Context): Tag[] {
	const { block, kind, entry } = item;
	if (kind === "code") return ["pre", "code"];
	if (kind === "image" || kind === "html") return ["figure"];
	if (kind === "break") return ["p"];
	if (item.list) return ["li"];
	const style = str(block.style);
	if (HEADINGS.has(style)) return [style];
	if (style === "blockquote") return !ctx.plain && entry?.pullquote ? [{ element: "aside", class: ctx.prefix("pullquote") }, "blockquote"] : ["blockquote"];
	return ["p"];
}

function defaultContent(item: Item, ctx: Context): string {
	if (item.kind === "text") return spanContent(item.block, ctx.plain ? PLAIN_MARK_TAGS : MARK_TAGS);
	if (item.kind === "code") {
		const code = str(item.block.code);
		return code ? encodeContent(preserveWhitespace(code)) : BREAK;
	}
	// A figure whose image entity had no src
	if (item.kind === "image") return "<img/>";
	return BREAK;
}

/** draft-js-export-html's MarkupGenerator: blocks in order, lists nested by depth, two spaces per level. */
function generate(items: Item[], ctx: Context): string {
	const out: string[] = [];
	let i = 0;
	let indentLevel = 0;
	let wrapper: string | null = null;
	const indent = () => out.push(INDENT.repeat(indentLevel));
	const openWrapper = (tag: string) => {
		wrapper = tag;
		indent();
		out.push(`<${tag}>\n`);
		indentLevel++;
	};
	const closeWrapper = () => {
		if (!wrapper) return;
		indentLevel--;
		indent();
		out.push(`</${wrapper}>\n`);
		wrapper = null;
	};
	const processBlock = () => {
		const item = items[i];
		if (wrapper !== item.list) {
			if (wrapper) closeWrapper();
			if (item.list) openWrapper(item.list);
		}
		indent();
		const custom = customHtml(item, ctx);
		if (custom) {
			out.push(custom, "\n");
			i++;
			return;
		}
		const tags = tagsOf(item, ctx);
		for (const tag of tags) out.push(typeof tag === "string" ? `<${tag}>` : `<${tag.element} class="${tag.class}">`);
		out.push(defaultContent(item, ctx));
		// A list item nests the items one level deeper that follow it
		const next = items[i + 1];
		if (item.list && next && next.depth === item.depth + 1) {
			out.push("\n");
			const outer = wrapper;
			wrapper = null;
			indentLevel++;
			i++;
			processAtDepth(next.depth);
			wrapper = outer;
			indentLevel--;
			indent();
		} else i++;
		out.push(`${tags.map((tag) => `</${typeof tag === "string" ? tag : tag.element}>`).reverse().join("")}\n`);
	};
	const processAtDepth = (depth: number) => {
		while (items[i] && items[i].depth === depth) processBlock();
		closeWrapper();
	};
	while (i < items.length) processBlock();
	closeWrapper();
	return out.join("").trim();
}

// rehype-minify-whitespace 5.0.0's block elements (lib/block.js), which TakeShape's MDX renderer ran
const MINIFY_BLOCKS = new Set(
	"address article aside blockquote body br caption center col colgroup dd dialog dir div dl dt figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html legend li listing main menu nav ol optgroup option p plaintext pre section summary table tbody td tfoot th thead tr ul wbr xmp".split(" "),
);

// Elements whose text keeps its whitespace: rehype-minify-whitespace's pre-like ones and textarea, and script and style,
// whose text holds no tags at all, so a tag inside one (a template literal's <div>) is left as written
const RAW_TEXT = /^(?:pre|listing|plaintext|xmp|textarea|script|style)$/i;
const PRE_LIKE = /^(?:pre|listing|plaintext|xmp)$/i;
const NAME_START = /[A-Za-z]/;
const NAME_CHAR = /[\w-]/;
// HTML's whitespace: rehype-minify-whitespace collapses only [\t\n\v\f\r ], so a no-break or an em space is text
const SPACE = /[\t\n\v\f\r ]/;
// The first run holds no line break, so the one a gap needs has one place
const GAP = /[\t\v\f\r ]*\n[\t\n\v\f\r ]*(?=<(\/?[A-Za-z][\w-]*)?)/y;

/**
 * The tag that starts at `i` (a `<`), read as a browser reads one: its name, then up to the `>`, a quoted attribute
 * value whole. Null when `<` starts no tag; "open" when the tag never closes, since it then takes the rest of the text.
 * One pass over each character, so no input makes it slow.
 */
function tagAt(html: string, i: number): { end: number; name: string; close: boolean } | null | "open" {
	let j = i + 1;
	const close = html[j] === "/";
	if (close) j++;
	if (!NAME_START.test(html[j] ?? "")) return null;
	const from = j;
	while (j < html.length && NAME_CHAR.test(html[j]!)) j++;
	const name = html.slice(from, j);
	while (j < html.length) {
		const c = html[j]!;
		if (c === ">") return { end: j + 1, name, close };
		j++;
		if (c !== "=") continue;
		while (j < html.length && SPACE.test(html[j]!)) j++;
		const quote = html[j];
		if (quote !== '"' && quote !== "'") continue;
		const shut = html.indexOf(quote, j + 1);
		if (shut === -1) return "open";
		j = shut + 1;
	}
	return "open";
}

/**
 * Markdown and MDX HTML as TakeShape printed it: its MDX renderer ran rehype-minify-whitespace, so whitespace
 * between two tags goes where a block element starts or ends there, and collapses to one space between inline ones
 * (two links stay apart). Code, scripts, styles, textareas and comments keep their text as it is.
 */
export function withoutBlockBreaks(html: string): string {
	let out = "";
	let at = 0;
	for (let i = html.indexOf("<"); i !== -1; i = html.indexOf("<", Math.max(at, i + 1))) {
		// A comment's text is no markup either
		if (html.startsWith("<!--", i)) {
			const shut = html.indexOf("-->", i + 4);
			if (shut === -1) break;
			out += html.slice(at, shut + 3);
			at = shut + 3;
			continue;
		}
		const tag = tagAt(html, i);
		if (tag === "open") break;
		if (!tag) continue;
		let end = tag.end;
		if (!tag.close && RAW_TEXT.test(tag.name)) {
			const shut = new RegExp(`</${tag.name}[\\t\\n\\f\\r ]*>`, "gi");
			shut.lastIndex = end;
			const found = shut.exec(html);
			end = found ? found.index + found[0].length : html.length;
		}
		out += html.slice(at, end);
		at = end;
		GAP.lastIndex = end;
		const gap = GAP.exec(html);
		const next = gap?.[1]?.replace(/^\//, "");
		// A <pre> as a block drops the break after it, before any markup; elsewhere the break sits between two tags
		if (gap && (next || PRE_LIKE.test(tag.name))) {
			const block = MINIFY_BLOCKS.has(tag.name.toLowerCase()) || (next !== undefined && MINIFY_BLOCKS.has(next.toLowerCase()));
			out += block ? "" : " ";
			at = end + gap[0].length;
		}
	}
	return out + html.slice(at);
}

/**
 * The HTML TakeShape printed for these blocks. `sidecar` is the field's entry
 * in `takeshape_rich_text`; an entry counts only while its block is there.
 * `plain` renders a caption or credit the way TakeShape's rawToHTML did.
 */
export function renderRichText(
	blocks: readonly PTBlock[] | null | undefined,
	sidecar: Readonly<Record<string, RichTextSidecarEntry>> | undefined,
	options: RichTextOptions,
): string {
	if (!Array.isArray(blocks)) return "";
	const items = itemsOf(blocks, sidecar);
	if (!hasText(items)) return "";
	const plain = options.plain === true;
	const classPrefix = options.classPrefix ?? "";
	const ctx: Context = {
		options,
		plain,
		prefix: (className) => (className ? classPrefix + className : ""),
		// One slugger per field, so a repeated heading gets -1, -2
		slugger: plain ? undefined : new GithubSlugger(),
	};
	const html = generate(items, ctx);
	return plain ? html : removeExtraBlankLines(html);
}
