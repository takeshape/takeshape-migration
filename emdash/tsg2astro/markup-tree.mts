/**
 * The template as a tree of HTML pieces and Nunjucks statements. The builder runs the HTML lexer (markup.mts)
 * through the template in source order, each `if` branch starting from the state at the `if`, and assembles start
 * tags, comments and whole script and style elements that span Nunjucks segments. The balance pass then decides,
 * per scope (component body, slot, if branch, loop body, IIFE), which tags stay Astro markup: a start tag and its
 * end tag do; anything without a partner, or that Astro cannot hold, becomes raw HTML with the exact text.
 */
import { initialLexState, tokenizeMarkup } from "./markup.mts";
import type { LexState } from "./markup.mts";
import { Report } from "./report.mts";
import { analyze, astOf, kids, lineOf } from "./scope.mts";
import type { Analysis } from "./scope.mts";
import { attrsOk, parseTag } from "./start-tags.mts";
import type { Interp, MayHoldSafe } from "./start-tags.mts";
import type { NjNode, Template } from "./templates.mts";

/** `partner`: for an end tag, the start tag it closes (set by balance). */
export type TagNode = { k: "tag"; close: boolean; name: string; parts: Interp[]; selfClosing: boolean; line: number; raw?: boolean; force?: boolean; partner?: TagNode };
export type MNode =
	| { k: "text"; text: string; rc: boolean }
	| { k: "out"; node: NjNode }
	| TagNode
	| { k: "raw"; parts: Interp[] }
	| { k: "if"; branches: Array<{ cond: NjNode | null; body: MNode[] }>; line: number }
	| { k: "for"; node: NjNode; body: MNode[]; else: MNode[] | null }
	/** `sets`: the sets (or the first set of each group) declared at the top of the function, in order. */
	| { k: "iife"; sets: NjNode[]; body: MNode[] }
	| { k: "include"; node: NjNode; name: string }
	| { k: "block"; name: string; body: MNode[] }
	/** A set that moved to the frontmatter or a loop callback, or was left out. `pre`: inside preformatted text. */
	| { k: "set"; node: NjNode; pre: boolean };

export const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const WHOLE_ELEMENTS = new Set(["script", "style"]);

type Pending =
	| { kind: "tag"; parts: Interp[]; name: string; closing: boolean; foreign: boolean; line: number }
	| { kind: "construct"; parts: Interp[]; mode: LexState["mode"] }
	| { kind: "element"; parts: Interp[]; name: string };

const cloneState = (s: LexState): LexState => ({ ...s });

export class MarkupBuilder {
	state: LexState = initialLexState();
	pending: Pending | null = null;
	depth = 0;
	/** Open <pre> elements, so whitespace there is never touched. */
	preDepth = 0;
	pendingDepth = 0;
	/** Lexer state where each block starts, for children of this template. */
	blockStates = new Map<string, LexState>();
	/** If chains already wrapped in the function that declares their groups. */
	wrapped = new Set<NjNode>();
	readonly t: Template;
	readonly an: Analysis;
	readonly report: Report;
	constructor(t: Template, an: Analysis, report: Report) {
		this.t = t;
		this.an = an;
		this.report = report;
	}

	/**
	 * A node at the top of the template's parse tree. The emitter's depth says nothing here: a set read before and after
	 * it wraps the rest of the body in a function, and a child template's block body starts at the top.
	 */
	atTopLevel(n: NjNode): boolean {
		return kids(this.t.ast).includes(n);
	}

	/** An import whose names the top level already imports, each from the same template under the same name. */
	repeatsTopLevelImport(n: NjNode): boolean {
		if (n.typename !== "FromImport" && n.typename !== "Import") return false;
		const bindings = (x: NjNode): string[] => {
			const from = String((x.template as NjNode | undefined)?.value);
			if (x.typename === "Import") return [`${from} * ${String((x.target as NjNode).value)}`];
			return kids(x.names as NjNode).map((p) => (p.typename === "Pair" ? `${from} ${String((p.key as NjNode).value)} ${String((p.value as NjNode).value)}` : `${from} ${String(p.value)} ${String(p.value)}`));
		};
		const top = new Set(kids(this.t.ast).filter((x) => x.typename === "FromImport" || x.typename === "Import").flatMap(bindings));
		return bindings(n).every((b) => top.has(b));
	}

	notTranslated(line: number | undefined, construct: string, message: string): void {
		this.report.add({ kind: "not-translated", file: this.t.name, line, construct, message });
	}

	body(nodes: NjNode[]): MNode[] {
		const depth = ++this.depth;
		const out: MNode[] = [];
		for (let i = 0; i < nodes.length; i++) {
			const n = nodes[i]!;
			if (this.pending) {
				this.interp(n, out);
				continue;
			}
			switch (n.typename) {
				case "Output":
					for (const c of kids(n)) {
						if (c.typename === "TemplateData") this.text(String(c.value ?? ""), out, lineOf(c));
						else if (this.pending) (this.pending as Pending).parts.push({ t: "out", node: c });
						else out.push({ k: "out", node: c });
					}
					break;
				case "If": {
					// Groups of sets in this chain that need a function around the rest of the body, from the if on
					const groups = (this.an.chains.get(n) ?? []).filter((s) => s.placement === "iife");
					if (groups.length && !this.wrapped.has(n)) {
						this.wrapped.add(n);
						out.push({ k: "iife", sets: groups.map((s) => s.node), body: this.body(nodes.slice(i)) });
						this.closeBody(depth, out);
						this.depth--;
						return out;
					}
					out.push(this.ifNode(n));
					break;
				}
				case "For": {
					const start = cloneState(this.state);
					const body = this.body(kids(n.body as NjNode));
					const after = this.state;
					let other: MNode[] | null = null;
					if (n.else_) {
						this.state = cloneState(start);
						other = this.body(kids(n.else_ as NjNode));
					}
					if (after.mode !== start.mode) this.notTranslated(lineOf(n), "for", "The loop body ends inside an HTML construct it did not start in.");
					this.state = after;
					out.push({ k: "for", node: n, body, else: other });
					break;
				}
				case "Set": {
					const plan = this.an.sets.get(n);
					if (plan?.placement === "iife" && !plan.group) {
						out.push({ k: "iife", sets: [n], body: this.body(nodes.slice(i + 1)) });
						this.closeBody(depth, out);
						this.depth--;
						return out;
					}
					out.push({ k: "set", node: n, pre: this.preDepth > 0 });
					break;
				}
				case "Include":
					out.push({ k: "include", node: n, name: String((n.template as NjNode).value) });
					break;
				case "Block": {
					const name = String((n.name as NjNode).value);
					this.blockStates.set(name, cloneState(this.state));
					out.push({ k: "block", name, body: this.body(kids(n.body as NjNode)) });
					break;
				}
				case "Extends":
					// only an extends at the top level makes this a child template
					if (!this.atTopLevel(n)) this.notTranslated(lineOf(n), "extends", "An extends inside another tag (an if, a loop or a block) is not translated: the layout would depend on run-time values.");
					break;
				// A macro definition prints nothing where it stands (its module holds it), and imports go in the frontmatter.
				// Both bind at the top level only (scope.mts), so one inside another tag is reported, unless it repeats an
				// import the top level makes (a page that imports the same macro again inside its block).
				case "Macro":
				case "FromImport":
				case "Import":
					if (!this.atTopLevel(n) && !this.repeatsTopLevelImport(n)) {
						const construct = n.typename === "Macro" ? "macro" : n.typename === "FromImport" ? "from" : "import";
						this.notTranslated(lineOf(n), construct, `A ${construct === "macro" ? "macro definition" : `{% ${construct} %}`} inside another tag (an if, a loop or a block) is not translated: macros and imports bind at a template's top level here, so its names are undefined. Move it to the top of the template.`);
					}
					break;
				default:
					this.notTranslated(lineOf(n), n.typename.toLowerCase(), `The Nunjucks ${n.typename} tag is not translated yet.`);
			}
		}
		this.closeBody(depth, out);
		this.depth--;
		return out;
	}

	/** A construct that started in this body and did not finish is emitted as it is, as raw HTML. */
	closeBody(depth: number, out: MNode[]): void {
		if (!this.pending || this.pendingDepth !== depth) return;
		const p = this.pending;
		this.pending = null;
		if (p.kind === "tag") this.notTranslated(p.line, `<${p.name}>`, "This HTML tag is not finished where its Nunjucks block ends, so it is copied as raw HTML.");
		out.push({ k: "raw", parts: p.parts });
	}

	ifNode(n: NjNode): MNode {
		const start = cloneState(this.state);
		const branches: Array<{ cond: NjNode | null; body: MNode[] }> = [];
		let end: LexState | null = null;
		const branch = (cond: NjNode | null, nodes: NjNode[]) => {
			this.state = cloneState(start);
			branches.push({ cond, body: this.body(nodes) });
			if (!end) end = this.state;
			else if (end.mode !== this.state.mode) this.notTranslated(lineOf(n), "if", "The branches of this if end in different HTML contexts.");
		};
		let hasElse = false;
		for (let c: NjNode | null = n; c; ) {
			branch(c.cond as NjNode, kids(c.body as NjNode));
			const other = c.else_ as NjNode | null;
			if (other?.typename === "If") c = other;
			else {
				if (other) branch(null, kids(other));
				hasElse = other !== null;
				c = null;
			}
		}
		// without an else, the template can also skip every branch
		if (!hasElse && end && (end as LexState).mode !== start.mode) this.notTranslated(lineOf(n), "if", "This if leaves the HTML in a different context when it runs than when it does not.");
		this.state = end ?? start;
		return { k: "if", branches, line: lineOf(n) };
	}

	/** A Nunjucks node inside a tag, comment or script: it becomes part of that construct. */
	interp(n: NjNode, out: MNode[]): void {
		const p = this.pending!;
		switch (n.typename) {
			case "Output":
				for (const c of kids(n)) {
					if (c.typename === "TemplateData") this.text(String(c.value ?? ""), out, lineOf(c));
					else if (this.pending) this.pending.parts.push({ t: "out", node: c });
					else out.push({ k: "out", node: c });
				}
				return;
			case "If": {
				const branches: Array<{ cond: NjNode | null; parts: Interp[] }> = [];
				const start = cloneState(this.state);
				let end: LexState | null = null;
				for (let c: NjNode | null = n; c; ) {
					this.state = cloneState(start);
					branches.push({ cond: c.cond as NjNode, parts: this.interpParts(kids(c.body as NjNode), lineOf(n)) });
					end ??= this.state;
					const other = c.else_ as NjNode | null;
					if (other?.typename === "If") c = other;
					else {
						if (other) {
							this.state = cloneState(start);
							branches.push({ cond: null, parts: this.interpParts(kids(other), lineOf(n)) });
						}
						c = null;
					}
				}
				this.state = end ?? start;
				p.parts.push({ t: "if", node: n, branches });
				return;
			}
			case "Block": {
				// A block in a start tag or attribute is text the extending template supplies ($blocks in emit-astro).
				// Anywhere else (a script, a style, a comment) the page passes nothing, so its override would be lost.
				if (p.kind !== "tag" || p.closing) {
					const where = p.kind === "element" ? `a <${p.name}> element` : p.kind === "tag" ? "an end tag" : "an HTML comment or other raw construct";
					this.notTranslated(lineOf(n), "block", `The block "${String((n.name as NjNode).value)}" sits inside ${where}, where a page that extends this template cannot replace it here: it prints this template's own text. Move the block out to a start tag's attribute or to the markup.`);
				}
				this.blockStates.set(String((n.name as NjNode).value), cloneState(this.state));
				const parts = this.interpParts(kids(n.body as NjNode), lineOf(n));
				p.parts.push({ t: "block", name: String((n.name as NjNode).value), parts });
				return;
			}
			case "For": {
				// In a start tag, a loop in an attribute value is part of the value, and one between attributes sends the
				// tag out as raw HTML (start-tags.mts)
				const start = cloneState(this.state);
				const parts = this.interpParts(kids(n.body as NjNode), lineOf(n));
				const after = this.state;
				let other: Interp[] | null = null;
				if (n.else_) {
					this.state = cloneState(start);
					other = this.interpParts(kids(n.else_ as NjNode), lineOf(n));
				}
				this.state = after;
				p.parts.push({ t: "for", node: n, parts, else: other });
				return;
			}
		}
		// A set prints nothing; one that moved to the frontmatter or a loop callback is translated wherever it sat.
		const placement = n.typename === "Set" ? this.an.sets.get(n)?.placement : undefined;
		if (placement === "top" || placement === "loop" || placement === "none") return;
		const where = p.kind === "tag" ? `an HTML tag (<${p.name}>)` : p.kind === "element" ? `a <${p.name}> element` : "an HTML comment or declaration";
		this.notTranslated(lineOf(n), n.typename.toLowerCase(), `A Nunjucks ${n.typename} tag inside ${where} is not translated.`);
	}

	/** The parts of an if branch or loop body inside a construct. The construct must not end inside it. */
	interpParts(nodes: NjNode[], line: number): Interp[] {
		const saved = this.pending!;
		const parts: Interp[] = [];
		this.pending = { ...saved, parts } as Pending;
		const stray: MNode[] = [];
		for (const n of nodes) {
			if (!this.pending) break;
			this.interp(n, stray);
		}
		if (!this.pending || stray.length) {
			this.notTranslated(line, "if", "An HTML tag or construct ends inside a Nunjucks branch, so it is copied as raw HTML.");
		}
		this.pending = saved;
		return parts;
	}

	text(s: string, out: MNode[], line: number): void {
		const r = tokenizeMarkup(s, this.state);
		const endState = r.state;
		const count = r.tokens.length;
		r.tokens.forEach((tok, idx) => {
			const last = idx === count - 1;
			const p = this.pending;
			if (p) {
				p.parts.push(tok.raw);
				if (p.kind === "tag") {
					if (!(last && endState.mode === "tag")) this.finishTag(out);
				} else if (p.kind === "construct") {
					if (!(last && endState.mode === p.mode)) {
						this.pending = null;
						out.push({ k: "raw", parts: p.parts });
					}
				} else if (tok.type === "close" && tok.name === p.name) {
					this.pending = null;
					out.push({ k: "raw", parts: p.parts });
				}
				return;
			}
			switch (tok.type) {
				case "text": {
					// A `<` or `</` that ends the chunk may open a tag whose name comes from Nunjucks (`<{{ tag }}>`).
					// Copied as raw HTML, the bytes stay the same and Astro does not read `<{...}` as its own syntax.
					const tail = last && endState.mode === "data" ? /<\/?$/.exec(tok.raw) : null;
					if (tail) {
						if (tail.index) out.push({ k: "text", text: tok.raw.slice(0, tail.index), rc: false });
						out.push({ k: "raw", parts: [tail[0]] });
					} else out.push({ k: "text", text: tok.raw, rc: false });
					return;
				}
				case "rawtext":
					out.push({ k: "text", text: tok.raw, rc: true });
					return;
				case "open":
					if (tok.name === "pre" && !tok.selfClosing) this.preDepth++;
					if (WHOLE_ELEMENTS.has(tok.name) && !tok.selfClosing) this.begin({ kind: "element", parts: [tok.raw], name: tok.name });
					else out.push({ k: "tag", close: false, name: tok.name, parts: [tok.raw], selfClosing: tok.selfClosing, line });
					return;
				case "close":
					if (tok.name === "pre") this.preDepth = Math.max(0, this.preDepth - 1);
					out.push({ k: "tag", close: true, name: tok.name, parts: [tok.raw], selfClosing: false, line });
					return;
				case "tag-partial":
					this.begin({ kind: "tag", parts: [tok.raw], name: tok.name, closing: tok.raw.startsWith("</"), foreign: endState.foreign > 0, line });
					return;
				case "tag-rest":
					this.notTranslated(line, "tag", "The end of an HTML tag was found without its start.");
					out.push({ k: "raw", parts: [tok.raw] });
					return;
				default:
					if (last && endState.mode === tok.type) this.begin({ kind: "construct", parts: [tok.raw], mode: endState.mode });
					else out.push({ k: "raw", parts: [tok.raw] });
			}
		});
		this.state = endState;
	}

	begin(p: Pending): void {
		this.pending = p;
		this.pendingDepth = this.depth;
	}

	finishTag(out: MNode[]): void {
		const p = this.pending as Extract<Pending, { kind: "tag" }>;
		this.pending = null;
		const lastPart = p.parts[p.parts.length - 1];
		const slashGt = typeof lastPart === "string" && /\/>$/.test(lastPart);
		const foreign = p.foreign || p.name === "svg" || p.name === "math";
		const selfClosing = !p.closing && (VOID.has(p.name) || (foreign && slashGt));
		if (p.name === "pre" && !selfClosing) this.preDepth = p.closing ? Math.max(0, this.preDepth - 1) : this.preDepth + 1;
		if (!p.closing && !selfClosing && WHOLE_ELEMENTS.has(p.name)) {
			this.begin({ kind: "element", parts: p.parts, name: p.name });
			return;
		}
		out.push({ k: "tag", close: p.closing, name: p.name, parts: p.parts, selfClosing, line: p.line });
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Balance: within each scope, a start tag and its end tag stay markup; anything without a partner becomes raw HTML.

export function markForced(list: MNode[], mayHoldSafe?: MayHoldSafe): void {
	for (const n of list) {
		if (n.k === "tag") {
			if (n.close) {
				n.force = !(n.parts.length === 1 && typeof n.parts[0] === "string" && /^<\/[^\s/>]+\s*>$/.test(n.parts[0]));
				continue;
			}
			const original = typeof n.parts[0] === "string" ? (/^<([^\s/>]+)/.exec(n.parts[0])?.[1] ?? "") : "";
			const parsed = parseTag(n.parts);
			// Astro markup only for plain element names: an uppercase first letter is a component to Astro, and a
			// custom element (a name with "-") goes through Astro's component path, which rewrites its attributes.
			let force = !parsed || !/^[a-z][a-zA-Z0-9]*$/.test(original) || n.name === "slot" || n.name === "fragment";
			if (parsed && !force) force = !attrsOk(parsed.attrs, mayHoldSafe);
			n.force = force;
			continue;
		}
		for (const child of childBodies(n)) markForced(child, mayHoldSafe);
	}
}

function childBodies(n: MNode): MNode[][] {
	switch (n.k) {
		case "if":
			return n.branches.map((b) => b.body);
		case "for":
			return n.else ? [n.body, n.else] : [n.body];
		case "iife":
		case "block":
			return [n.body];
		default:
			return [];
	}
}

export function balance(list: MNode[]): void {
	const stack: TagNode[] = [];
	for (const n of list) {
		if (n.k !== "tag") {
			for (const child of childBodies(n)) balance(child);
			continue;
		}
		if (!n.close) {
			if (n.selfClosing) n.raw = n.force;
			else stack.push(n);
			continue;
		}
		let k = stack.length - 1;
		while (k >= 0 && stack[k]!.name !== n.name) k--;
		if (k < 0) {
			n.raw = true;
			continue;
		}
		for (let j = stack.length - 1; j > k; j--) stack[j]!.raw = true;
		const open = stack[k]!;
		stack.length = k;
		n.partner = open;
		if (open.force || n.force) {
			open.raw = true;
			n.raw = true;
		}
	}
	for (const s of stack) s.raw = true;
}

// ---------------------------------------------------------------------------------------------------------------
// Whitespace: lines left blank by sets that moved, and the edges of a component.

/** Elements around which whitespace does not render (as in compare/normalize.mts). */
const BLOCK_LEVEL = new Set(
	(
		"address article aside blockquote body details dialog dd div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header " +
		"hgroup hr html li main nav ol p pre section table tbody thead tfoot tr td th caption ul title meta link script style template noscript option br"
	).split(" "),
);

/**
 * A set that moved out of the markup leaves its line behind. When that line is now blank, drop it: the whitespace
 * around it still renders the same, since a run of whitespace collapses (outside <pre>).
 */
export function tidy(list: MNode[]): void {
	list.forEach((n, i) => {
		for (const child of childBodies(n)) tidy(child);
		if (n.k !== "set" || n.pre) return;
		const prev = list[i - 1];
		const next = list[i + 1];
		if (prev?.k !== "text" || next?.k !== "text" || prev.rc || next.rc) return;
		if (!/\n[ \t]*$/.test(prev.text) || !/^[ \t]*\n/.test(next.text)) return;
		prev.text = prev.text.replace(/[ \t]*$/, "");
		next.text = next.text.replace(/^[ \t]*\n/, "");
	});
}

/**
 * Astro trims a component's leading and trailing whitespace. Where that whitespace renders (next to inline content),
 * it is kept as an expression; elsewhere it is left out of the source too.
 */
export function keepEdges(list: MNode[], markup: string): string {
	const edge = (fromStart: boolean): string => {
		const seq = fromStart ? list : [...list].reverse();
		const first = seq[0];
		if (!first || first.k !== "text") return "";
		const m = fromStart ? /^[ \t\n\r\f]+/.exec(first.text) : /[ \t\n\r\f]+$/.exec(first.text);
		if (!m) return "";
		if (m[0].length < first.text.length) return m[0];
		const next = seq.slice(1).find((n) => !(n.k === "text" && !n.text.trim()) && n.k !== "set");
		if (!next) return "";
		if (next.k === "tag" && BLOCK_LEVEL.has(next.name)) return "";
		if (next.k === "raw" && typeof next.parts[0] === "string" && /^<!doctype/i.test(next.parts[0])) return "";
		return m[0];
	};
	const lead = edge(true);
	const trail = edge(false);
	const body = markup.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, "");
	return `${lead ? `{${JSON.stringify(lead)}}` : ""}${body}${trail ? `{${JSON.stringify(trail)}}` : ""}\n`;
}

/** Finds the template where a block is declared at the top, following `extends` up to the root layout. */
export function rootLayoutState(t: Template, block: string, templates: Map<string, Template>, seen = new Set<string>()): LexState {
	if (seen.has(t.name)) return initialLexState();
	seen.add(t.name);
	if (t.extends) {
		const parent = templates.get(t.extends);
		return parent ? rootLayoutState(parent, block, templates, seen) : initialLexState();
	}
	const builder = new MarkupBuilder(t, analyze(t, templates), new Report());
	builder.body(kids(astOf(t)));
	return builder.blockStates.get(block) ?? initialLexState();
}

/** Blocks of a child template: each `{% block %}` that is not inside another block. */
export function childBlocks(root: NjNode): NjNode[] {
	const out: NjNode[] = [];
	const visit = (n: unknown) => {
		if (!n || typeof n !== "object") return;
		if (Array.isArray(n)) return n.forEach(visit);
		const x = n as NjNode;
		if (x.typename === "Block") {
			out.push(x);
			return;
		}
		for (const v of Object.values(x)) if (v && typeof v === "object") visit(v);
	};
	visit(kids(root));
	return out;
}
