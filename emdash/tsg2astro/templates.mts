/**
 * Loads every template the routes reach, parsed with Nunjucks 3.2.0's own parser (the version takeshape-ssg ran),
 * with the extends/include graph and the blocks each template declares. takeshape-ssg resolves every template name
 * from the templatePath root, and any file type can be included, so a logo.svg is a template too. Names are
 * normalized (templateKey), in the parse tree too, so every template is loaded once and found by one name. A name
 * that leads outside the site folder is reported and never read.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TsgConfig } from "./config.mts";
import { load } from "./load.mts";
import { initialLexState, tokenizeMarkup } from "./markup.mts";
import type { Report } from "./report.mts";
import { outPath, siteFileName, templateKey } from "./scope.mts";
import { namesInUse, versionSets } from "./versions.mts";

export type NjNode = { typename: string; lineno: number; colno: number; [key: string]: unknown };
export type Template = {
	/** Its path from the templates folder, normalized (templateKey). Templates and includes find it by this. */
	name: string;
	/** Where it is written under src/templates/, when that is not `name`: a site file outside the templates folder. */
	outName?: string;
	kind: "html" | "text" | "raw";
	source: string;
	ast: NjNode | null;
	extends: string | null;
	includes: string[];
	blocks: string[];
	/** Nunjucks segments that sit inside an HTML tag, which the Astro emitter translates or reports. */
	tagInteriors: TagInterior[];
};

type Nunjucks = { parser: { parse: (src: string) => NjNode } };

const REFS = new Set(["Extends", "Include", "Import", "FromImport"]);

/** Visits every node below `node`, in source order. */
function walk(node: unknown, visit: (n: NjNode) => void): void {
	if (Array.isArray(node)) {
		for (const x of node) walk(x, visit);
		return;
	}
	if (!node || typeof node !== "object") return;
	const n = node as NjNode;
	if (typeof n.typename === "string") visit(n);
	for (const v of Object.values(n)) if (v && typeof v === "object") walk(v, visit);
}

export type TagInterior = {
	/** Source offsets of the `{% %}` or `{{ }}` segment. */
	start: number;
	end: number;
	/** 1-based line and column. The line is the parser node's `lineno + 1`; the column is its `colno + 1`. */
	line: number;
	col: number;
	kind: "tag" | "output";
	where: "start-tag" | "attr-value";
	quote?: '"' | "'";
	/** Lowercased name of the HTML tag the segment sits in, and the offset of that tag's `<`. */
	element: string;
	tagStart: number;
	raw: string;
};

// A TakeShape CDN URL built by hand around an output. https://assets.takeshape.io/{{ x.path }} printed what the asset
// filter prints, and https://images.takeshape.io/{{ x.path }}?<imgix parameters> what the image filter prints with
// them (@takeshape/routing getAssetUrl, getImageUrl). On EmDash the path is a storage key, so the filters, which
// serve it from EmDash, take the URL's place. The rewrite keeps every line where it was. A query part is a literal
// character or a whole {{ output }}; a parenthesis ends it, so the ) closing a CSS url() stays outside, and so does a #,
// since a fragment is no part of the query.
const CDN_OUTPUT = /https?:\/\/(assets|images)\.takeshape\.io\/\{\{-?\s*([^{}]+?)\s*-?\}\}(?:\?((?:&#[xX]?[0-9a-fA-F]+;|[^"'\s<>{}()#]|\{\{[^{}]*\}\})*))?/g;
const WHOLE_OUTPUT = /^\{\{-?\s*([^{}]+?)\s*-?\}\}$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** A query string's name or value, decoded as URLSearchParams decodes it. */
const decodeQuery = (part: string): string => new URLSearchParams(`x=${part}`).get("x") ?? "";

/** Character references in an attribute or text, which HTML decodes before the browser reads the URL. */
const decodeHtml = (s: string): string =>
	s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|quot|lt|gt|apos));/g, (_m, dec: string | undefined, hex: string | undefined, name: string | undefined) =>
		name ? ({ amp: "&", quot: '"', lt: "<", gt: ">", apos: "'" } as Record<string, string>)[name]! : String.fromCodePoint(Number.parseInt(dec ?? hex!, dec ? 10 : 16)),
	);

/** Where a template's markup is a script's or a style's raw text, which HTML does not decode, as [start, end) offsets. */
function rawTextRanges(source: string, code: Array<[number, number]>): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	const open = /<(script|style)\b[^>]*>/gi;
	for (let m = open.exec(source); m; m = open.exec(source)) {
		if (code.some(([from, to]) => m!.index >= from && m!.index < to)) continue;
		const start = m.index + m[0].length;
		const close = source.toLowerCase().indexOf(`</${m[1]!.toLowerCase()}`, start);
		const end = close < 0 ? source.length : close;
		out.push([start, end]);
		open.lastIndex = end;
	}
	return out;
}

/** Where a tag or output whose code starts at `from` ends (after `close`), skipping quoted strings, as Nunjucks's lexer reads them. */
function codeEnd(source: string, from: number, close: "%}" | "}}"): number {
	for (let i = from; i < source.length; i++) {
		const c = source[i];
		if (c === '"' || c === "'") {
			for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
		} else if (c === close[0] && source[i + 1] === "}") return i + 2;
	}
	return source.length;
}

/**
 * The parts of a template that are Nunjucks code or raw text, not markup: tags and outputs (with their strings),
 * comments, and raw and verbatim blocks, as [start, end) offsets. A hand-built URL starts in markup, and its own
 * `{{ x.path }}` is an output after that start.
 */
function codeRanges(source: string): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let i = source.indexOf("{"); i >= 0 && i < source.length; i = source.indexOf("{", i)) {
		const next = source[i + 1];
		if (next === "#") {
			const end = source.indexOf("#}", i + 2);
			const stop = end < 0 ? source.length : end + 2;
			out.push([i, stop]);
			i = stop;
		} else if (next === "{") {
			const stop = codeEnd(source, i + 2, "}}");
			out.push([i, stop]);
			i = stop;
		} else if (next === "%") {
			let stop = codeEnd(source, i + 2, "%}");
			const raw = /^\{%-?\s*(raw|verbatim)\s*-?%\}$/.exec(source.slice(i, stop));
			if (raw) {
				const close = new RegExp(`\\{%-?\\s*end${raw[1]}\\s*-?%\\}`, "g");
				close.lastIndex = stop;
				const m = close.exec(source);
				stop = m ? m.index + m[0].length : source.length;
			}
			out.push([i, stop]);
			i = stop;
		} else i++;
	}
	return out;
}

export function rewriteCdnUrls(source: string, file: string, report: Report): string {
	const code = codeRanges(source);
	const rawText = rawTextRanges(source, code);
	return source.replace(CDN_OUTPUT, (whole: string, host: string, expr: string, fullQuery: string | undefined, offset: number) => {
		// Only markup: a URL in a tag's or an output's string, a comment or a raw block is not printed as written
		if (code.some(([from, to]) => offset >= from && offset < to)) return whole;
		// Commas that end the URL separate it from the next srcset candidate, as HTML's srcset parsing reads them
		const trail = /,+$/.exec(fullQuery ?? "")?.[0] ?? "";
		const match = whole.slice(0, whole.length - trail.length);
		const query = fullQuery === undefined ? undefined : fullQuery.slice(0, fullQuery.length - trail.length);
		return rewriteOne(match, host, expr, query, offset) + trail;
	});
	function rewriteOne(match: string, host: string, expr: string, query: string | undefined, offset: number): string {
		const line = source.slice(0, offset).split("\n").length;
		// In a script or a style nothing decodes references, and the URL must print unescaped (an output there is escaped)
		const raw = rawText.some(([from, to]) => offset >= from && offset < to);
		const safe = raw ? " | safe" : "";
		const construct = host === "assets" ? "asset" : "image";
		const leave = (why: string): string => {
			report.add({
				kind: "not-translated",
				file,
				line,
				construct,
				message: `\`${match}\` builds a TakeShape CDN URL ${why}, so it is left as it was and still loads from TakeShape. Rewrite it as \`{{ ${expr} | image({ ... }) }}\`, each parameter an argument.`,
			});
			return match;
		};
		// A tag or comment right after the URL changes it at run time, and text there means the output is only part of the
		// path (https://assets.takeshape.io/{{ projectId }}/dev/logo.svg), which the filters can't take the place of
		const next = source[offset + match.length] ?? "";
		if (next === "{") return leave("that a template tag continues");
		if (query === undefined && /[\w./%~+-]/.test(next)) return leave("whose path goes on after the output");
		// A filter binds tighter than or, and, if and the rest, so anything beyond a plain path is grouped first
		const value = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\][]*\])*$/.test(expr.trim()) ? expr : `(${expr})`;
		let replacement: string;
		if (host === "assets") replacement = `{{ ${value} | asset${safe} }}${query !== undefined ? `?${query}` : ""}`;
		else {
			const args: string[] = [];
			const html = (t: string) => (raw ? t : decodeHtml(t));
			// Outside raw text an & that starts another character reference (&#39;) belongs to the value
			for (const part of (query ?? "").split(raw ? /&/ : /&amp;|&#0*38;|&#[xX]0*26;|&(?!#[xX]?[0-9a-fA-F]+;|[A-Za-z]+;)/)) {
				if (!part) continue;
				const eq = part.indexOf("=");
				const key = decodeQuery(html(eq < 0 ? part : part.slice(0, eq)));
				const value = eq < 0 ? "" : part.slice(eq + 1);
				if (key.includes("{")) return leave("with a parameter name from an output");
				const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
				const output = WHOLE_OUTPUT.exec(value);
				// The CDN read the value decoded, which undoes a last `| urlencode`
				if (output) args.push(`${name}: ${output[1]!.replace(/\s*\|\s*urlencode\s*$/, "")}`);
				else if (value.includes("{")) return leave("with a parameter that mixes text and an output");
				else args.push(`${name}: ${JSON.stringify(decodeQuery(html(value)))}`);
			}
			// Without tsg.yml's imageDefaults, which the hand-built URL never had
			replacement = `{{ ${value} | image(${args.length ? `{ ${args.join(", ")} }` : "{}"}, false)${safe} }}`;
		}
		report.add({
			kind: "note",
			file,
			line,
			construct,
			message: `\`${match}\` builds a TakeShape CDN URL from an asset's path. It is translated as \`${replacement}\`, which serves the file from EmDash.`,
		});
		return replacement;
	}
}

function lineCol(src: string, offset: number): { line: number; col: number } {
	let line = 1;
	let last = -1;
	for (let i = 0; i < offset; i++) {
		if (src.charCodeAt(i) === 10) {
			line++;
			last = i;
		}
	}
	return { line, col: offset - last };
}

/**
 * Finds every `{% %}` and `{{ }}` that sits inside an HTML tag (`<a {% if x %}class="on"{% endif %}>`, `<a {{ attrs }}>`,
 * `<a href="{{ url }}">`). The position matches the Nunjucks parser: an Output node starts at its `{{`, and a tag's node
 * starts at the keyword after `{%` (so `endif` and `else`, which have no node, get the same spot).
 */
export function findTagInteriors(src: string): TagInterior[] {
	const out: TagInterior[] = [];
	const re = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g;
	let state = initialLexState();
	let last = 0;
	const text = (from: number, to: number) => {
		if (to > from) state = tokenizeMarkup(src.slice(from, to), state, from).state;
	};
	for (let m = re.exec(src); m; m = re.exec(src)) {
		text(last, m.index);
		last = m.index + m[0].length;
		if (m[0][1] === "#" || state.mode !== "tag") continue;
		const kind = m[0][1] === "%" ? "tag" : "output";
		let at = m.index;
		if (kind === "tag") {
			const kw = /^\{%[-+]?\s*/.exec(m[0])!;
			at += kw[0].length;
		}
		const { line, col } = lineCol(src, at);
		const inValue = state.quote !== null || state.attr === "before-value" || state.attr === "unquoted";
		out.push({
			start: m.index,
			end: last,
			line,
			col,
			kind,
			where: inValue ? "attr-value" : "start-tag",
			...(state.quote ? { quote: state.quote } : {}),
			element: state.element ?? "",
			tagStart: state.tagStart ?? 0,
			raw: m[0],
		});
	}
	text(last, src.length);
	return out;
}

export async function loadTemplates(
	siteDir: string,
	config: TsgConfig,
	entries: Array<{ name: string; kind: "html" | "text"; routes?: RouteUse[] }>,
	report: Report,
): Promise<Map<string, Template>> {
	const njMod = await load<{ default?: Nunjucks } & Partial<Nunjucks>>("nunjucks");
	const nunjucks = (njMod.default ?? njMod) as Nunjucks;
	const s = await stat(siteDir).catch(() => null);
	const base = join(s?.isFile() ? dirname(siteDir) : siteDir, config.templatePath);
	const out = new Map<string, Template>();
	const queue: Array<{ name: string; kind: "html" | "text"; from?: { name: string; line: number }; routes?: RouteUse[] }> = [...entries];
	const uses = new Map<string, Use[]>();
	while (queue.length) {
		const { name: asWritten, kind: wanted, from, routes } = queue.shift()!;
		const name = templateKey(asWritten);
		const here: Use[] = routes?.length ? routes.map((route) => ({ file: "tsg.yml", asWritten, route })) : [{ file: from?.name ?? "tsg.yml", line: from?.line, asWritten }];
		uses.set(name, [...(uses.get(name) ?? []), ...here]);
		if (out.has(name)) continue;
		const outName = siteFileName(name, config.templatePath);
		if (outName === null) {
			report.add({
				kind: "not-translated",
				file: from?.name ?? "tsg.yml",
				line: from?.line,
				construct: asWritten,
				message: `Template "${asWritten}" is outside the site folder, so tsg2astro does not read it, and nothing is written for it. Move it into ${config.templatePath} and include it from there.`,
			});
			continue;
		}
		let source: string;
		try {
			source = await readFile(join(base, name), "utf8");
		} catch {
			report.add({
				kind: "not-translated",
				file: from?.name ?? name,
				line: from?.line,
				construct: name,
				message: `Template "${name}" was not found under ${config.templatePath}.`,
			});
			continue;
		}
		const tpl: Template = { name, kind: "raw", source, ast: null, extends: null, includes: [], blocks: [], tagInteriors: [] };
		if (outName !== name) tpl.outName = outName;
		out.set(name, tpl);
		if (!/\{\{|\{%|\{#/.test(source)) continue;
		tpl.kind = wanted;
		tpl.source = source = rewriteCdnUrls(source, name, report);
		try {
			tpl.ast = nunjucks.parser.parse(source);
		} catch (e) {
			report.add({ kind: "not-translated", file: name, message: `Nunjucks could not parse this template: ${(e as Error).message.replace(/\s+/g, " ")}` });
			continue;
		}
		walk(tpl.ast, (n) => {
			if (n.typename === "Block") {
				const b = n.name as NjNode | undefined;
				if (b && typeof b.value === "string") tpl.blocks.push(b.value);
				return;
			}
			if (!REFS.has(n.typename)) return;
			const ref = n.template as NjNode | undefined;
			if (!ref || ref.typename !== "Literal" || typeof ref.value !== "string") {
				report.add({
					kind: "not-translated",
					file: name,
					line: n.lineno + 1,
					construct: n.typename.toLowerCase(),
					message: "The template name is computed at build time, so the translator cannot follow it.",
				});
				return;
			}
			// The emitters find the template by the name in the tree
			const key = templateKey(ref.value);
			queue.push({ name: ref.value, kind: wanted, from: { name, line: n.lineno + 1 } });
			ref.value = key;
			if (n.typename === "Extends") tpl.extends = key;
			else tpl.includes.push(key);
		});
		tpl.tagInteriors = findTagInteriors(source);
	}
	dropSharedOutputs(out, uses, report);
	const taken = namesInUse(out);
	for (const t of out.values()) versionSets(t, out, taken);
	return out;
}

/** A route part that renders a template: the tsg.yml key that names it, the route and the path it serves. */
export type RouteUse = { construct: string; name: string; path: string };

/** A place that names a template: the template and line of an include or extends, or tsg.yml for a route. */
type Use = { file: string; line?: number; asWritten: string; route?: RouteUse };

/**
 * Templates that would be written to one file, such as `a.html` and `a.njk` (both `a.astro`), or a template in the
 * templates folder's `_site/` and the site file it mirrors: neither is written, and every place that names one of
 * them is reported, so the includes and routes that get nothing say why.
 */
function dropSharedOutputs(out: Map<string, Template>, uses: Map<string, Use[]>, report: Report): void {
	const byPath = new Map<string, string[]>();
	for (const t of out.values()) byPath.set(outPath(t), [...(byPath.get(outPath(t)) ?? []), t.name]);
	const shared = [...byPath].filter(([, names]) => names.length > 1).sort(([a], [b]) => (a < b ? -1 : 1));
	const dropped = new Set(shared.flatMap(([, names]) => names));
	for (const [path, names] of shared) {
		const { all, none } = sharedNames(names.map((n) => `"${n}"`));
		const rename = names.length === 2 ? "one of the two files" : "all but one of the files";
		for (const name of [...names].sort()) {
			for (const use of uses.get(name) ?? []) {
				if (dropped.has(use.file)) continue;
				const { route } = use;
				report.add({
					kind: "not-translated",
					file: use.file,
					line: use.line,
					construct: route?.construct ?? use.asWritten,
					message: route
						? `Route "${route.name}" serves ${route.path} with "${use.asWritten}", but ${all} become ${path}, so ${none} is written and ${route.path} has no pages. Rename ${rename} in a copy of the site and translate that copy into a new folder, or write the template and the route's pages by hand.`
						: use.line === undefined
							? `${all} become ${path}, so ${none} is written and the routes that use this template have no pages. Translate each by hand into a file of its own under src/templates/, then write those pages.`
							: `${all} become ${path}, so ${none} is written and this line gets nothing. Translate each by hand into a file of its own under src/templates/ and use it here.`,
				});
			}
		}
	}
	for (const name of dropped) out.delete(name);
}

/**
 * Names that share one output file, for a report message: `all` is the sorted list ("a, b and c"), followed by
 * "both" when there are two, and `none` is "neither" for two and "none of them" for more.
 */
export function sharedNames(names: string[]): { all: string; none: string } {
	const sorted = [...names].sort();
	const list = `${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}`;
	return sorted.length === 2 ? { all: `${list} both`, none: "neither" } : { all: list, none: "none of them" };
}
