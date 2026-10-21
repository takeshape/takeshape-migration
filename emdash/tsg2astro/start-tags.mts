/**
 * Start tags whose text holds Nunjucks: `<a {% if c %}class="x"{% else %}href="{{ u }}"{% endif %}>`. The parser
 * turns the pieces into attributes (static, with Nunjucks in the value, or a group under an `if`), and the checks
 * say whether Astro would print them exactly as Nunjucks did. When it would not, the tag goes out as raw HTML.
 */
import { splitOutput } from "./expressions.mts";
import type { NjNode } from "./templates.mts";

/** A piece of a construct that spans Nunjucks tags: a start tag, a comment, a whole script or style element. */
/** `block`: a layout's {% block %} inside the construct, which the extending template fills with text ($blocks). */
export type Interp =
	| string
	| { t: "out"; node: NjNode }
	| { t: "if"; node: NjNode; branches: Array<{ cond: NjNode | null; parts: Interp[] }> }
	| { t: "for"; node: NjNode; parts: Interp[]; else: Interp[] | null }
	| { t: "block"; name: string; parts: Interp[] };

export type ValPart =
	| string
	| { t: "out"; node: NjNode }
	| { t: "if"; branches: Array<{ cond: NjNode | null; parts: ValPart[] }> }
	| { t: "for"; node: NjNode; parts: ValPart[]; else: ValPart[] | null }
	| { t: "block"; name: string; parts: ValPart[] };
export type Attr =
	| { kind: "static"; ws: string; name: string; value: string | null; quote: string }
	| { kind: "dynamic"; ws: string; name: string; parts: ValPart[] }
	| { kind: "cond"; ws: string; branches: Array<{ cond: NjNode | null; attrs: Attr[] }> };
export type ParsedTag = { name: string; attrs: Attr[]; trailing: string; slash: boolean };

/** HTML whitespace between attributes (markup.mts's WS is any JavaScript whitespace). */
const ATTR_SPACE = /[ \t\n\r\f]/;

class Cursor {
	i = 0;
	j = 0;
	readonly parts: Interp[];
	constructor(parts: Interp[]) {
		this.parts = parts;
		this.skipEmpty();
	}
	skipEmpty(): void {
		while (this.i < this.parts.length && typeof this.parts[this.i] === "string" && this.j >= (this.parts[this.i] as string).length) {
			this.i++;
			this.j = 0;
		}
	}
	done(): boolean {
		return this.i >= this.parts.length;
	}
	/** The next character, or null at a Nunjucks part or the end. */
	ch(): string | null {
		const p = this.parts[this.i];
		return typeof p === "string" ? (p[this.j] ?? null) : null;
	}
	atom(): Exclude<Interp, string> | null {
		const p = this.parts[this.i];
		return p !== undefined && typeof p !== "string" ? p : null;
	}
	next(): void {
		if (typeof this.parts[this.i] === "string") this.j++;
		else {
			this.i++;
			this.j = 0;
		}
		this.skipEmpty();
	}
	readWhile(test: (c: string) => boolean): string {
		let s = "";
		for (let c = this.ch(); c !== null && test(c); c = this.ch()) {
			s += c;
			this.next();
		}
		return s;
	}
}

export function parseTag(parts: Interp[]): ParsedTag | null {
	const first = parts[0];
	if (typeof first !== "string") return null;
	const m = /^<([^\s/>]+)/.exec(first);
	if (!m) return null;
	const c = new Cursor(parts);
	for (let k = 0; k < m[0].length; k++) c.next();
	if (!c.done() && c.ch() === null) return null; // a Nunjucks tag right after the element name
	const out: ParsedTag = { name: m[1]!, attrs: [], trailing: "", slash: false };
	const attrs = parseAttrs(c, out);
	if (!attrs) return null;
	out.attrs = attrs;
	return out;
}

/** Attributes up to the end of the tag (`tag` given) or of an if branch. */
function parseAttrs(c: Cursor, tag: ParsedTag | null): Attr[] | null {
	const attrs: Attr[] = [];
	for (;;) {
		const ws = c.readWhile((ch) => ATTR_SPACE.test(ch));
		if (c.done()) return tag ? null : attrs;
		const atom = c.atom();
		if (atom) {
			if (atom.t !== "if") return null;
			const branches: Array<{ cond: NjNode | null; attrs: Attr[] }> = [];
			for (const b of atom.branches) {
				const inner = parseAttrs(new Cursor(b.parts), null);
				if (!inner) return null;
				branches.push({ cond: b.cond, attrs: inner });
			}
			attrs.push({ kind: "cond", ws, branches });
			c.next();
			continue;
		}
		const ch = c.ch()!;
		if (ch === ">" || ch === "/") {
			if (!tag) return null;
			if (ch === "/") {
				c.next();
				if (c.ch() !== ">") continue; // a stray slash between attributes is ignored, as browsers do
				tag.slash = true;
			}
			c.next();
			tag.trailing = ws;
			return c.done() ? attrs : null;
		}
		const name = c.readWhile((x) => !ATTR_SPACE.test(x) && x !== "=" && x !== ">" && x !== "/");
		if (!name || (!c.done() && c.ch() === null)) return null;
		// look past spaces for "="
		const save = { i: c.i, j: c.j };
		c.readWhile((x) => ATTR_SPACE.test(x));
		if (c.ch() !== "=") {
			c.i = save.i;
			c.j = save.j;
			attrs.push({ kind: "static", ws, name, value: null, quote: "" });
			continue;
		}
		c.next();
		c.readWhile((x) => ATTR_SPACE.test(x));
		const q = c.ch();
		const quote = q === '"' || q === "'" ? q : "";
		if (quote) c.next();
		const value: ValPart[] = [];
		let buf = "";
		for (;;) {
			if (c.done()) return null;
			const a = c.atom();
			if (a) {
				if (buf) value.push(buf);
				buf = "";
				const v = valuePart(a, quote);
				if (!v) return null;
				value.push(v);
				c.next();
				continue;
			}
			const x = c.ch()!;
			if (quote ? x === quote : ATTR_SPACE.test(x) || x === ">") break;
			buf += x;
			c.next();
		}
		if (quote) c.next();
		if (buf) value.push(buf);
		if (value.every((v) => typeof v === "string")) attrs.push({ kind: "static", ws, name, value: value.join(""), quote });
		// An unquoted value with Nunjucks in it splits at a space in the output (`class={{ "a b" }}`): only raw HTML keeps that.
		else if (!quote) return null;
		else attrs.push({ kind: "dynamic", ws, name, parts: value });
	}
}

function valueParts(list: Interp[], quote: string): ValPart[] | null {
	const parts: ValPart[] = [];
	for (const p of list) {
		if (typeof p === "string") {
			if (quote ? p.includes(quote) : /[\s>]/.test(p)) return null;
			parts.push(p);
		} else {
			const v = valuePart(p, quote);
			if (!v) return null;
			parts.push(v);
		}
	}
	return parts;
}

function valuePart(a: Exclude<Interp, string>, quote: string): ValPart | null {
	if (a.t === "out") return { t: "out", node: a.node };
	if (a.t === "block") {
		const parts = valueParts(a.parts, quote);
		return parts ? { t: "block", name: a.name, parts } : null;
	}
	if (a.t === "for") {
		const parts = valueParts(a.parts, quote);
		const other = a.else ? valueParts(a.else, quote) : null;
		return parts && (!a.else || other) ? { t: "for", node: a.node, parts, else: other } : null;
	}
	if (a.t !== "if") return null;
	const branches: Array<{ cond: NjNode | null; parts: ValPart[] }> = [];
	for (const b of a.branches) {
		const parts = valueParts(b.parts, quote);
		if (!parts) return null;
		branches.push({ cond: b.cond, parts });
	}
	return { t: "if", branches };
}

/** HTML attribute values Astro would treat as its own syntax, or render differently from a plain string. */
const ASTRO_DIRECTIVE = /^(set|is|client|server|transition|define|class):/i;
export const BOOLEAN_ATTRS = new Set(
	"allowfullscreen async autofocus autoplay checked controls default defer disabled disablepictureinpicture disableremoteplayback formnovalidate inert loop muted nomodule novalidate open playsinline readonly required reversed scoped seamless selected itemscope".split(" "),
);
/** Names Astro reads as its own syntax, or (`<`) cannot compile. */
// A name with a character JavaScript counts as whitespace and HTML does not (`"\u00a0scrolling"` in a pasted embed), or a quote:
// Astro's compiler splits it, and its runtime drops it, so the tag keeps its bytes as raw HTML
const specialName = (name: string) => ASTRO_DIRECTIVE.test(name) || name.toLowerCase() === "slot" || /[{}<\s"']/.test(name);
/** Astro prints these as a bare name for any truthy value and drops them for a falsy one. */
export const booleanish = (name: string) => BOOLEAN_ATTRS.has(name.toLowerCase()) || name.toLowerCase() === "popover";
/** Names whose value Astro changes when it comes from an expression: booleans, and `className` (printed as class). */
const dynamicUnsafe = (name: string) => booleanish(name) || name === "className";

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
/** Decodes the character references in an attribute value, or returns null when the decoding is not certain. */
export function decodeAttr(s: string): string | null {
	let ok = true;
	const out = s.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[A-Za-z][A-Za-z0-9]*;?)?/g, (m, ref: string | undefined) => {
		if (!ref) return m;
		if (ref.startsWith("#")) {
			const hex = /^#[xX]/.test(ref);
			const code = Number.parseInt(ref.replace(/^#[xX]?|;$/g, ""), hex ? 16 : 10);
			if (!ref.endsWith(";") || !(code > 0 && code <= 0x10ffff) || (code >= 0x80 && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) ok = false;
			return ok ? String.fromCodePoint(code) : m;
		}
		const name = ref.replace(/;$/, "");
		if (ref.endsWith(";") && Object.hasOwn(NAMED, name)) return NAMED[name]!;
		ok = false;
		return m;
	});
	return ok ? out : null;
}

/** Whether Astro prints these attributes as Nunjucks did. Otherwise the tag goes out as raw HTML. */
/**
 * Whether an output may print a macro's result (a SafeString in Nunjucks, which it printed as it was). A native Astro
 * attribute escapes its value again, so a tag with one goes out as raw HTML. The emitter knows the macros.
 */
export type MayHoldSafe = (node: NjNode) => boolean;

export function attrsOk(attrs: Attr[], mayHoldSafe: MayHoldSafe = () => false): boolean {
	for (const a of attrs) {
		if (a.kind === "cond") {
			if (!spreadOk(a, mayHoldSafe) || namePaths([a]).some((p) => new Set(p).size < p.length)) return false;
			continue;
		}
		if (specialName(a.name)) return false;
		if (a.kind === "dynamic" && (dynamicUnsafe(a.name) || !valueOk(a.parts, mayHoldSafe))) return false;
	}
	return true;
}

/** An attribute inside a conditional spread: Astro renders every one of them as if it came from an expression. */
function spreadOk(a: Attr, mayHoldSafe: MayHoldSafe = () => false): boolean {
	if (a.kind === "cond") return a.branches.every((b) => b.attrs.every((x) => spreadOk(x, mayHoldSafe)));
	if (specialName(a.name) || a.name === "className") return false;
	if (a.kind === "dynamic") return !dynamicUnsafe(a.name) && valueOk(a.parts, mayHoldSafe);
	if (a.value === null) return true;
	// `checked=""` is the same as `checked`; any other value on a boolean name would be lost
	return decodeAttr(a.value) !== null && (!booleanish(a.name) || a.value === "");
}

/**
 * The attribute names each way through nested conditions can print, lowercased. A name twice on one way means the
 * browser keeps the first where a JavaScript object keeps the last. Too many ways counts as a repeat.
 */
function namePaths(attrs: Attr[]): string[][] {
	let paths: string[][] = [[]];
	for (const a of attrs) {
		if (a.kind !== "cond") {
			paths = paths.map((p) => [...p, a.name.toLowerCase()]);
			continue;
		}
		const options = a.branches.flatMap((b) => namePaths(b.attrs));
		if (a.branches[a.branches.length - 1]!.cond) options.push([]);
		paths = paths.flatMap((p) => options.map((o) => [...p, ...o]));
		if (paths.length > 256) return [["*", "*"]];
	}
	return paths;
}

export function valueOk(parts: ValPart[], mayHoldSafe: MayHoldSafe = () => false): boolean {
	return parts.every((p) => {
		if (typeof p === "string") return decodeAttr(p) !== null;
		if (p.t === "out") {
			const { inner, html } = splitOutput(p.node);
			return !html && !mayHoldSafe(inner);
		}
		if (p.t === "block") return valueOk(p.parts, mayHoldSafe);
		if (p.t === "for") return valueOk(p.parts, mayHoldSafe) && (!p.else || valueOk(p.else, mayHoldSafe));
		return p.branches.every((b) => valueOk(b.parts, mayHoldSafe));
	});
}
