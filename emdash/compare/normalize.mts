// Turns two HTML (or XML) documents into canonical lines so that differences a visitor cannot see
// (whitespace, comments, attribute order, the site origin, image hosts) disappear and everything
// else shows. Image URLs become "[image]"; collectImages returns the originals in document order,
// and the image identity check (same picture, same size) works from that list elsewhere.
import { parse } from "parse5";

export type NormNode = { tag: string; attrs: Array<[string, string]>; children: NormNode[] } | { text: string };
export type NormalizeOptions = { origins: string[] };

const IMAGE = "[image]";
const FILE = "[file]";
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const PRESERVE = new Set(["pre", "textarea"]);
const RAW = new Set(["script", "style"]);
// Elements around which whitespace does not render (block-level, table parts, and metadata elements).
const BLOCK = new Set(
	(
		"address article aside blockquote body details dialog dd div dl dt fieldset figcaption figure footer form " +
		"h1 h2 h3 h4 h5 h6 head header hgroup hr html li main nav ol p pre section table tbody thead tfoot tr td th caption ul " +
		"title meta link script style template noscript option br #document"
	).split(" "),
);
// href and action only count known image hosts and paths; these attributes also count a bare image extension.
const IMAGE_ATTRS = new Set(["src", "poster", "data-src"]);
const SRCSET_ATTRS = new Set(["srcset", "data-srcset"]);
const URL_ATTRS = new Set(["href", "action"]);
const IMAGE_META = new Set(["og:image", "twitter:image"]);
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?)$/i;
// ASCII whitespace only: U+00A0 and friends render and stay in the text.
const WS = /[ \t\n\r\f]+/g;

type P5Node = {
	nodeName: string;
	tagName?: string;
	value?: string;
	attrs?: Array<{ name: string; value: string }>;
	childNodes?: P5Node[];
	content?: P5Node;
};

function stripOrigin(url: string, origins: string[]): string {
	for (const origin of origins) {
		const o = origin.replace(/\/+$/, "");
		if (url === o) return "/";
		if (url.startsWith(`${o}/`) || url.startsWith(`${o}?`) || url.startsWith(`${o}#`)) {
			const rest = url.slice(o.length);
			return rest.startsWith("/") ? rest : `/${rest}`;
		}
	}
	return url;
}

// Replaces every listed origin inside free text (JSON-LD).
function stripOriginsInText(text: string, origins: string[]): string {
	let out = text;
	for (const origin of origins) {
		const o = origin.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`${o}(?![A-Za-z0-9.-])`, "g"), (m, offset: number, str: string) => (str[offset + m.length] === "/" ? "" : "/"));
	}
	return out;
}

function pathOf(url: string): string {
	return url.split(/[?#]/)[0];
}

// Takes a URL with the site origin already stripped. allowExt: a bare image extension counts (image attributes only).
function classify(url: string, allowExt: boolean): typeof IMAGE | typeof FILE | null {
	const m = /^(?:https?:)?\/\/([^/?#]+)/i.exec(url);
	if (m) {
		const host = m[1].toLowerCase();
		if (host === "images.takeshape.io") return IMAGE;
		if (host === "assets.takeshape.io") return IMAGE_EXT.test(pathOf(url)) ? IMAGE : FILE;
		return null; // another site: a link or an embed, not ours to compare
	}
	// EmDash's media, and the TakeShape files tsg2astro/rehost.mts moved onto the site
	if (url.startsWith("/_emdash/api/media/file/") || url.startsWith("/_takeshape-files/")) return IMAGE_EXT.test(pathOf(url)) ? IMAGE : FILE;
	if (url.startsWith("/_image?") || url.startsWith("/_takeshape/image?")) return IMAGE;
	if (allowExt && IMAGE_EXT.test(pathOf(url))) return IMAGE;
	return null;
}

/**
 * The file URLs, images aside, that the content compare turns into `[file]` in an attribute it doesn't read as a link
 * (a component's `:sources`, a `data-file`): the whole value, or each quoted URL in it. The content compare can't see
 * a missing file there, so the crawl follows them and the broken-link check reads them (crawl.mts extractLinks).
 * Images there join the image check instead.
 */
/**
 * A URL in quotes inside an attribute's value (a component's `:images="['/a.png']"`): it ends at its own quote, so the
 * other quote may sit inside it (a file named "Owner's photo.jpg"), and a backslash escape (a binding's `Owner\'s`) does
 * not end it. Group 1 is a double-quoted URL, group 2 a single-quoted one, each as written. Each quote opens its own
 * branch and each character reads one way, so a long list reads in linear time.
 */
const QUOTED_URL = /"((?:https?:)?\/\/(?:[^"\\]|\\.)+|\/(?:[^"\\]|\\.)+)"|'((?:https?:)?\/\/(?:[^'\\]|\\.)+|\/(?:[^'\\]|\\.)+)'/g;
/** The URL a match holds, its backslash escapes read as a JavaScript string reads them. */
const quotedUrl = (m: RegExpMatchArray | string[]): string => unescapeQuoted((m[1] ?? m[2])!);
const SINGLE_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
/**
 * A JavaScript string literal's escapes, decoded without running anything: \uXXXX, \u{X}, \xHH, the one-letter ones,
 * a line continuation, and any other character for itself (\' is ', \\ is \).
 */
const unescapeQuoted = (s: string): string =>
	s.replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/g, (_m, cp: string | undefined, u: string | undefined, x: string | undefined, c: string | undefined) => {
		const code = cp ?? u ?? x;
		if (code !== undefined) {
			const n = Number.parseInt(code, 16);
			return n <= 0x10ffff ? String.fromCodePoint(n) : _m;
		}
		if (c === "\n" || c === "\r\n" || c === "\r" || c === "\u2028" || c === "\u2029") return "";
		return SINGLE_ESCAPES[c!] ?? c!;
	});

export function componentFileUrls(name: string, value: string, origins: string[]): string[] {
	if (SRCSET_ATTRS.has(name) || IMAGE_ATTRS.has(name) || URL_ATTRS.has(name) || name === "style") return [];
	const whole = value.trim();
	if (classify(stripOrigin(whole, origins), false) === FILE) return [whole];
	const out: string[] = [];
	for (const m of value.matchAll(QUOTED_URL)) {
		const url = quotedUrl(m);
		if (classify(stripOrigin(url, origins), false) === FILE) out.push(url);
	}
	return out;
}

// A TakeShape CDN URL with no path (a template printed the host where an asset was missing) showed nothing, as an
// empty value does
const BARE_CDN = /^(?:https?:)?\/\/(?:images|assets)\.takeshape\.io\/?$/i;

// HTML srcset parsing: a URL is a run of non-whitespace (commas inside it are fine); trailing commas end a
// candidate without a descriptor; otherwise a descriptor runs to the next comma outside parentheses.
function parseSrcset(value: string): Array<{ url: string; descriptor: string }> {
	const out: Array<{ url: string; descriptor: string }> = [];
	let i = 0;
	const n = value.length;
	while (i < n) {
		while (i < n && /[ \t\n\r\f,]/.test(value[i])) i++;
		if (i >= n) break;
		let j = i;
		while (j < n && !/[ \t\n\r\f]/.test(value[j])) j++;
		let url = value.slice(i, j);
		i = j;
		let descriptor = "";
		if (/,$/.test(url)) {
			url = url.replace(/,+$/, "");
		} else {
			let depth = 0;
			const startD = i;
			while (i < n) {
				const c = value[i];
				if (c === "(") depth++;
				else if (c === ")") depth = Math.max(0, depth - 1);
				else if (c === "," && depth === 0) break;
				i++;
			}
			descriptor = value.slice(startD, i).replace(WS, " ").trim();
			if (i < n) i++; // the comma
		}
		if (url) out.push({ url, descriptor });
	}
	return out;
}

type Ctx = { origins: string[]; images: string[] };

// Inside JSON-LD, an image or file URL (TakeShape's CDN, EmDash's media, the site's image endpoint, a path with an
// image extension) compares as the marker an attribute holding it gets, so a re-hosted logo compares equal, and an
// image joins the image check, which fetches both. Origins are already stripped.
/**
 * Each JSON string in JSON-LD text that holds a URL, whole: `fn` gets the URL decoded (JSON's `\/` and `\u0026` as
 * `/` and `&`) and returns the token's replacement, or undefined to keep it. An absolute URL may hold raw spaces
 * (TakeShape kept file names as uploaded); a path may not.
 */
function jsonLdUrls(text: string, fn: (url: string) => string | undefined): string {
	return text.replace(/"((?:[^"\\\n]|\\.)*)"/g, (token, inner: string) => {
		let url: string;
		try {
			url = JSON.parse(token) as string;
		} catch {
			url = inner.replace(/\\\//g, "/");
		}
		if (!/^(?:(?:https?:)?\/\/[^"]+|\/[^"\s]*)$/.test(url)) return token;
		return fn(url) ?? token;
	});
}

function mapUrlsInJsonLd(text: string, ctx: Ctx): string {
	// Each URL is classified without its origin and collected as written, as mapUrl does, so the image check fetches it
	// (or finds it in an image index) by its own URL; the caller strips origins from the rest afterwards
	return jsonLdUrls(text, (url) => {
		if (BARE_CDN.test(url)) return '""';
		const kind = classify(stripOrigin(url, ctx.origins), true);
		if (kind === IMAGE) ctx.images.push(url);
		return kind ? `"${kind}"` : undefined;
	});
}

/**
 * The file URLs, images aside, that mapUrlsInJsonLd turns into `[file]` (a video's contentUrl): the crawl follows them
 * so a missing one is a broken link, as componentFileUrls does for attributes.
 */
export function jsonLdFileUrls(text: string, origins: string[]): string[] {
	const out: string[] = [];
	jsonLdUrls(text, (url) => {
		if (!BARE_CDN.test(url) && classify(stripOrigin(url, origins), true) === FILE) out.push(url);
		return undefined;
	});
	return out;
}

// Collected images keep their original text (origin included) so a later check can fetch them.
function mapUrl(raw: string, ctx: Ctx, allowExt: boolean): string {
	const v = raw.trim();
	if (BARE_CDN.test(v)) return "";
	const stripped = stripOrigin(v, ctx.origins);
	const kind = classify(stripped, allowExt);
	if (kind === IMAGE) ctx.images.push(v);
	return kind ?? stripped;
}

function mapAttr(tag: string, attrs: Map<string, string>, name: string, value: string, ctx: Ctx): string {
	if (SRCSET_ATTRS.has(name)) {
		return parseSrcset(value)
			.map((c) => {
				const u = mapUrl(c.url, ctx, true);
				return c.descriptor ? `${u} ${c.descriptor}` : u;
			})
			.join(", ");
	}
	if (IMAGE_ATTRS.has(name)) return mapUrl(value, ctx, true);
	if (URL_ATTRS.has(name)) return mapUrl(value, ctx, false);
	if (tag === "meta" && name === "content") {
		const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
		if (IMAGE_META.has(key)) return mapUrl(value, ctx, true);
		if ((attrs.get("http-equiv") ?? "").toLowerCase() === "refresh") {
			return value.replace(/(\burl\s*=\s*)(['"]?)([^'";\s]+)/i, (_m, pre: string, quote: string, u: string) => `${pre}${quote}${stripOrigin(u, ctx.origins)}`);
		}
		return stripOrigin(value.trim(), ctx.origins);
	}
	if (name === "style") {
		return value.replace(/url\(\s*(["']?)([^)"']*?)\1\s*\)/gi, (_all, q2: string, u: string) => `url(${q2}${mapUrl(u, ctx, true)}${q2})`);
	}
	// Any other attribute (a component's img or background, a list of video sources) holding a URL on TakeShape's CDN,
	// EmDash's media, the image endpoint or the moved files, whole or in quotes, compares as the marker, and an image
	// joins the image check as an <img src> does. Text that only ends like a file name (alt="logo.png") stays text.
	if (classify(stripOrigin(value.trim(), ctx.origins), false)) return mapUrl(value, ctx, false);
	return value.replace(QUOTED_URL, (m, dq: string | undefined, sq: string | undefined) => {
		const url = unescapeQuoted((dq ?? sq)!);
		const q = dq !== undefined ? '"' : "'";
		// The bare host TakeShape printed for a missing image is the empty value, as mapUrl reads it
		if (BARE_CDN.test(url)) return `${q}${q}`;
		const kind = classify(stripOrigin(url, ctx.origins), false);
		if (kind === IMAGE) ctx.images.push(url);
		return kind ? `${q}${kind}${q}` : m;
	});
}

function isBlock(n: NormNode): boolean {
	return "tag" in n && BLOCK.has(n.tag);
}

function convert(node: P5Node, ctx: Ctx, preserve: boolean, parentTag: string, jsonLd: boolean): NormNode[] {
	const items: NormNode[] = [];
	let pending: string | null = null;
	const flush = () => {
		if (pending === null) return;
		if (preserve) {
			const t = jsonLd ? stripOriginsInText(mapUrlsInJsonLd(pending, ctx), ctx.origins) : pending;
			if (t !== "") items.push({ text: t });
		} else {
			items.push({ text: pending.replace(WS, " ") });
		}
		pending = null;
	};
	const kids = node.nodeName === "template" && node.content ? node.content.childNodes ?? [] : node.childNodes ?? [];
	for (const child of kids) {
		if (child.nodeName === "#text") {
			pending = (pending ?? "") + (child.value ?? "");
		} else if (child.nodeName === "#comment" || child.nodeName === "#documentType") {
			continue; // comments vanish before text runs are merged, so "a<!-- -->b" is one run
		} else {
			flush();
			const tag = child.tagName ?? child.nodeName;
			const map = new Map((child.attrs ?? []).map((a) => [a.name, a.value] as const));
			// By name, the order the attributes compare in: the image check pairs old and new images by position, so a
			// swap between two attributes shows, and a harmless reorder doesn't
			const byName = [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
			const attrs = byName.map(([n, v]) => [n, mapAttr(tag, map, n, v, ctx)] as [string, string]);
			const ld = tag === "script" && /^application\/ld\+json\b/i.test(map.get("type") ?? "");
			items.push({ tag, attrs, children: convert(child, ctx, preserve || PRESERVE.has(tag) || RAW.has(tag), tag, ld) });
		}
	}
	flush();
	if (preserve) return items;
	const containerBlock = BLOCK.has(parentTag);
	const out: NormNode[] = [];
	items.forEach((it, i) => {
		if (!("text" in it)) {
			out.push(it);
			return;
		}
		let t = it.text;
		const prev = items[i - 1];
		const next = items[i + 1];
		if (i === 0 ? containerBlock : isBlock(prev)) t = t.replace(/^ /, "");
		if (i === items.length - 1 ? containerBlock : isBlock(next)) t = t.replace(/ $/, "");
		if (t) out.push({ text: t });
	});
	return out;
}

export type NormalizeResult = { tree: NormNode; images: string[] };

// images: the original image URLs (origin included), in source order.
export function normalizeHtml(html: string, options: NormalizeOptions): NormalizeResult {
	const doc = parse(html) as unknown as P5Node;
	const ctx: Ctx = { origins: options.origins, images: [] };
	const tree: NormNode = { tag: "#document", attrs: [], children: convert(doc, ctx, false, "#document", false) };
	return { tree, images: ctx.images };
}

const q = (s: string) => JSON.stringify(s).replace(/\u00a0/g, "\\u00a0");

export function canonicalLines(node: NormNode): string[] {
	const lines: string[] = [];
	const walk = (n: NormNode, depth: number) => {
		const pad = "  ".repeat(depth);
		if ("text" in n) {
			lines.push(`${pad}${q(n.text)}`);
			return;
		}
		const attrs = n.attrs.map(([k, v]) => ` ${k}=${q(v)}`).join("");
		lines.push(`${pad}<${n.tag}${attrs}>`);
		for (const c of n.children) walk(c, depth + 1);
		if (!VOID.has(n.tag)) lines.push(`${pad}</${n.tag}>`);
	};
	walk(node, 0);
	return lines;
}

function decodeEntities(t: string): string {
	return t.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
		const l = e.toLowerCase();
		if (l === "amp") return "&";
		if (l === "lt") return "<";
		if (l === "gt") return ">";
		if (l === "quot") return '"';
		if (l === "apos") return "'";
		const code = l.startsWith("#x") ? Number.parseInt(l.slice(2), 16) : Number.parseInt(l.slice(1), 10);
		return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
	});
}

// Sitemaps, RSS, Atom. A small tokenizer is enough: the feeds we compare are generated, well formed XML.
// Text and attribute values are decoded, CDATA counts as text, and any value that starts with a listed origin loses it.
export function normalizeXml(xml: string, options: NormalizeOptions): string[] {
	const lines: string[] = [];
	const stripped = xml
		.replace(/<\?[\s\S]*?\?>/g, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<!DOCTYPE[^>]*>/gi, "");
	const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s>/]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)/g;
	let depth = 0;
	let buf = "";
	const pad = () => "  ".repeat(depth);
	const flush = () => {
		const v = buf.replace(WS, " ").replace(/^ | $/g, "");
		buf = "";
		if (v) lines.push(`${pad()}${q(stripOrigin(v, options.origins))}`);
	};
	for (const m of stripped.matchAll(token)) {
		if (m[1] !== undefined) buf += m[1];
		else if (m[6] !== undefined) buf += decodeEntities(m[6]);
		else if (m[3] !== undefined) {
			flush();
			const [, , closing, name, rest, selfClose] = m;
			if (closing) {
				depth = Math.max(0, depth - 1);
				lines.push(`${pad()}</${name}>`);
			} else {
				const attrs = [...rest.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
					.map((a) => [a[1], stripOrigin(decodeEntities(a[2] ?? a[3]).trim(), options.origins)] as const)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([k, v]) => ` ${k}=${q(v)}`)
					.join("");
				lines.push(`${pad()}<${name}${attrs}>`);
				if (selfClose) lines.push(`${pad()}</${name}>`);
				else depth++;
			}
		}
	}
	flush();
	return lines;
}
