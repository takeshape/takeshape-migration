/**
 * Turns a Nunjucks template into an Astro component whose markup follows the original template: the HTML stays
 * as written, `{{ }}` becomes `{nj.text(...)}`, `if` and `for` become expressions, `extends` and `block` become a
 * layout component with named slots, and `include` becomes a component.
 *
 * Astro compiles markup, so anything it cannot hold as markup goes through `<Fragment set:html={...} />` with the
 * exact text Nunjucks printed: a tag whose partner is not in the same scope (a stray `</article>`, `<main>` opened in
 * a header include and closed in a footer include, an omitted `</li>`), doctypes, comments, `<?xml ?>`, and whole
 * `<script>` and `<style>` elements (Astro would bundle them). A scope is the component body, a slot, an `if` branch
 * or a loop body. Astro 7.4.0 behavior this relies on, seen in test builds: a stray end tag in markup makes the
 * compiler drop the rest of the component, a lone `}` in text and an omitted `</li>` are compile errors, and a
 * component's leading and trailing whitespace is trimmed. test/tsg/differential.mts holds the cases that pin it.
 *
 * Nunjucks scoping is reproduced at translate time. Names a template reads become props. A `set` becomes a
 * frontmatter `const` when every read of it comes after it, a `const` in the loop callback when it sits directly in
 * a loop body, or an IIFE around the rest of its `if` branch. The sets of one name in the branches of an
 * if/elif/else chain become one `const` with a condition per branch, placed the same ways (an IIFE then starts at the
 * if); a branch that sets nothing keeps the prop. An include receives the includer's props plus the locals it reads;
 * a layout receives the child's props plus the child's top-level sets it reads. Whatever does not fit is reported
 * as not translated.
 *
 * scope.mts holds the analysis and the file names, markup-tree.mts the HTML tree and the balance pass, and
 * start-tags.mts the attribute parser. This file writes the component.
 */
import { emitExpression, isMacroCall, jsName, loopParams, splitOutput } from "./expressions.mts";
import type { Scope } from "./expressions.mts";
import { initialLexState } from "./markup.mts";
import type { LexState } from "./markup.mts";
import { balance, childBlocks, keepEdges, MarkupBuilder, markForced, rootLayoutState, tidy, VOID } from "./markup-tree.mts";
import type { MNode, TagNode } from "./markup-tree.mts";
import type { Report } from "./report.mts";
import {
	analyze,
	astOf,
	importPath,
	isRawFile,
	kids,
	layoutChain,
	layoutNames,
	lineOf,
	macroBindings,
	outPath,
	pascal,
	reportUnplacedSets,
	RUNTIME_DIR,
	setValue,
	SKIP_NAMES,
	symbols,
	tl,
} from "./scope.mts";
import type { Analysis, SetPlan } from "./scope.mts";
import { booleanish, decodeAttr, parseTag } from "./start-tags.mts";
import type { Attr, Interp, ValPart } from "./start-tags.mts";
import type { NjNode, Template } from "./templates.mts";

export type EmittedFile = { path: string; source: string };

class AstroEmitter {
	readonly scope: Scope = { locals: new Set(), free: new Set() };
	readonly imports = new Map<string, { id: string; spec: string }>();
	readonly taken = new Set<string>();
	readonly file: string;
	usedNj = false;
	usedTs = false;
	/** Names some {% set %} gives a macro's result, which Nunjucks printed unescaped like the call itself. */
	macroResults = new Set<string>();

	readonly t: Template;
	readonly templates: Map<string, Template>;
	readonly an: Analysis;
	readonly report: Report;

	constructor(t: Template, templates: Map<string, Template>, an: Analysis, report: Report) {
		this.t = t;
		this.templates = templates;
		this.an = an;
		this.report = report;
		this.file = outPath(t);
		for (const n of ["Astro", "Fragment", "nj", "ts"]) this.taken.add(n);
		// every name the template uses, so an import never shadows one
		for (const s of symbols(astOf(t))) this.taken.add(jsName(s));
		for (const s of an.contextReads) this.taken.add(jsName(s));
	}

	notTranslated(line: number | undefined, construct: string, message: string): void {
		this.report.add({ kind: "not-translated", file: this.t.name, line, construct, message });
	}

	expr(node: NjNode): string {
		const bad = findCall(node, SKIP_NAMES);
		if (bad) {
			this.notTranslated(lineOf(node), `${bad}()`, `Nunjucks's ${bad}() is not translated yet.`);
			return "undefined";
		}
		const js = emitExpression(node, this.scope, this.report, { file: this.t.name, line: lineOf(node) });
		if (/\bnj\./.test(js)) this.usedNj = true;
		if (/\bts\./.test(js)) this.usedTs = true;
		return js;
	}

	nj(call: string): string {
		this.usedNj = true;
		return `nj.${call}`;
	}

	/** `const x = ...;` for a set, or for a group of sets in one if chain. The group's old value is the prop. */
	decl(s: SetPlan): string {
		const prop = /^[A-Za-z_$][\w$]*$/.test(s.name) ? `Astro.props.${s.name}` : `Astro.props[${JSON.stringify(s.name)}]`;
		return `const ${jsName(s.name)} = ${setValue(s, (n) => this.expr(n), prop)};`;
	}

	withLocals<T>(names: string[], fn: () => T): T {
		const saved = new Set(this.scope.locals);
		for (const n of names) this.scope.locals.add(n);
		try {
			return fn();
		} finally {
			this.scope.locals = saved;
		}
	}

	importFor(target: Template): string {
		const known = this.imports.get(target.name);
		if (known) return known.id;
		const raw = isRawFile(target);
		const segments = target.name.split("/");
		const base = segments[segments.length - 1]!;
		let id = "";
		for (let k = segments.length - 1; k >= 0; k--) {
			const words = [...segments.slice(k, -1), raw ? base : base.replace(/\.[^.]+$/, "")];
			const p = pascal(words.join("-"));
			id = raw ? p[0]!.toLowerCase() + p.slice(1) : p;
			if (!this.taken.has(id)) break;
		}
		for (let n = 2; this.taken.has(id); n++) id = `${id.replace(/\d+$/, "")}${n}`;
		this.taken.add(id);
		const spec = importPath(this.file, outPath(target)) + (raw ? "?raw" : "");
		this.imports.set(target.name, { id, spec });
		return id;
	}

	// ----- markup

	nodes(list: MNode[]): string {
		return list.map((n) => this.node(n)).join("");
	}

	node(n: MNode): string {
		switch (n.k) {
			case "text": {
				let s = n.text.replace(/[{}]/g, (c) => `{"${c}"}`);
				if (n.rc) s = s.replace(/</g, "&lt;");
				return s;
			}
			case "out": {
				const { inner, html } = splitOutput(n.node);
				// A value that may hold a macro's result (a name set from one, a filter it went through) is escaped unless it
				// does, as Nunjucks printed a SafeString as it was
				if (!html && !isMacroCall(inner, this.scope) && this.mayBeSafe(inner)) {
					return `<Fragment set:html={${this.nj("escape")}(${this.expr(inner)})} />`;
				}
				const js = `${this.nj("text")}(${this.expr(inner)})`;
				// A macro's output is HTML, which Nunjucks printed unescaped
				return html || isMacroCall(inner, this.scope) ? `<Fragment set:html={${js}} />` : `{${js}}`;
			}
			case "tag":
				return this.tag(n);
			case "raw":
				return this.rawHtml(n.parts);
			case "if": {
				// an if whose branches only set names (declared elsewhere now) prints nothing
				if (n.branches.every((b) => b.body.every((x) => x.k === "set"))) return "";
				let out = "";
				for (const b of n.branches) {
					const body = b.body.length ? `(<>${this.nodes(b.body)}</>)` : "null";
					out += b.cond ? `${this.expr(b.cond)} ? ${body} : ` : body;
				}
				if (n.branches[n.branches.length - 1]!.cond) out += "null";
				return `{${out}}`;
			}
			case "for":
				return `{${this.loop(n.node, () => `(<>${this.nodes(n.body)}</>)`, n.else ? () => `(<>${this.nodes(n.else!)}</>)` : null)}}`;
			case "iife":
				return this.withLocals([], () => {
					const decls: string[] = [];
					for (const s of n.sets) {
						const plan = this.an.sets.get(s)!;
						decls.push(this.decl(plan));
						this.scope.locals.add(plan.name);
					}
					return `{(() => { ${decls.join(" ")} return (<>${this.nodes(n.body)}</>); })()}`;
				});
			case "set":
				return "";
			case "include":
				return this.include(n.node, n.name);
			case "block": {
				const body = this.nodes(n.body);
				return body ? `<slot name="${n.name}">${body}</slot>` : `<slot name="${n.name}" />`;
			}
		}
	}

	/** `nj.iterate(xs).map(...)`, with the loop's own sets declared in the callback. */
	loop(node: NjNode, body: () => string, otherwise: (() => string) | null, join = ""): string {
		const name = node.name as NjNode;
		if (name.typename === "Array") {
			this.notTranslated(lineOf(node), "for", "A for loop with several variables is not translated yet.");
			return "null";
		}
		const v = String(name.value);
		const list = `${this.nj("iterate")}(${this.expr(node.arr as NjNode)})`;
		const plan = this.an.loops.get(node);
		const own = plan?.sets ?? [];
		const usesLoop = plan?.usesLoop ?? false;
		const names = [v, ...(usesLoop ? ["loop"] : []), ...own.map((s) => s.name)];
		const text = this.withLocals(names, () => {
			const { i, all } = loopParams(names, plan?.reads);
			const params = usesLoop ? `({ value: ${jsName(v)} }, ${i}, ${all})` : `({ value: ${jsName(v)} })`;
			const decls: string[] = [];
			if (usesLoop) decls.push(`const loop = ${this.nj("loop")}(${i}, ${all}.len);`);
			for (const s of own) decls.push(this.decl(s));
			const b = body();
			return decls.length ? `${params} => { ${decls.join(" ")} return ${b}; }` : `${params} => ${b}`;
		});
		if (!otherwise) return `${list}.map(${text})${join}`;
		// Nunjucks evaluated the list once, for the else and the runs alike: a joiner or a macro in it runs once here too.
		// Its else runs when the length it read is falsy (iterate's `len`). `$list` can't be a template's name, since
		// Nunjucks names hold no `$`
		return `(($list) => $list.len ? $list.map(${text})${join} : ${otherwise()})(${list})`;
	}

	include(node: NjNode, name: string): string {
		const target = this.templates.get(name);
		if (!target) return ""; // loadTemplates reported it
		if (isRawFile(target)) return `<Fragment set:html={${this.importFor(target)}} />`;
		if (target.kind === "text") {
			this.notTranslated(lineOf(node), "include", `"${name}" is also included by a text template, and the translator writes one form of each template. Copy it to a second file for one of them.`);
			return "";
		}
		const leak = this.an.includeLeaks.find((l) => l.node === node);
		if (leak) {
			const names = leak.names.map((n) => `"${n}"`).join(", ");
			this.notTranslated(lineOf(node), "include", `"${name}" sets ${names} inside a loop. Nunjucks then changes this template's ${names} too, which a component cannot do.`);
		}
		const id = this.importFor(target);
		const reads = analyze(target, this.templates).contextReads;
		// A name set again further down is passed as it stands here (versions.mts)
		const as = (r: string) => (node.contextAliases as Record<string, string> | undefined)?.[r] ?? r;
		const pass = [...reads].filter((r) => this.scope.locals.has(as(r))).sort();
		return `<${id} {...Astro.props}${pass.map((p) => ` ${p}={${jsName(as(p))}}`).join("")} />`;
	}

	tag(n: TagNode): string {
		if (n.raw) return this.rawHtml(n.parts);
		const src = n.parts.length === 1 && typeof n.parts[0] === "string" ? n.parts[0] : null;
		// An end tag takes its start tag's spelling (`<div>..</DIV>`, `<linearGradient>..</lineargradient>`): HTML names are
		// case-insensitive, browsers fix the case of SVG names, and Astro only pairs tags spelled the same.
		if (n.close) return `</${/^<([^\s/>]+)/.exec(typeof n.partner?.parts[0] === "string" ? n.partner.parts[0] : "")?.[1] ?? n.name}>`;
		const parsed = parseTag(n.parts)!;
		const foreignSelf = n.selfClosing && !VOID.has(n.name);
		const end = foreignSelf ? " />" : ">";
		if (src && !/[{}]/.test(src) && !(parsed.slash && !n.selfClosing)) return src;
		return `<${parsed.name}${parsed.attrs.map((a) => a.ws + this.attr(a)).join("")}${parsed.trailing}${end}`;
	}

	attr(a: Attr): string {
		if (a.kind === "static") {
			if (a.value === null) return a.name;
			const q = a.quote || (a.value.includes('"') ? "'" : '"');
			return `${a.name}=${q}${a.value}${q}`;
		}
		if (a.kind === "dynamic") return `${a.name}={${this.valueExpr(a.parts)}}`;
		return `{...(${this.condExpr(a.branches)})}`;
	}

	condExpr(branches: Array<{ cond: NjNode | null; attrs: Attr[] }>): string {
		let out = "";
		for (const b of branches) {
			const entries = b.attrs.map((a) => this.entry(a));
			const obj = entries.length ? `{ ${entries.join(", ")} }` : "{}";
			out += b.cond ? `${this.expr(b.cond)} ? ${obj} : ` : obj;
		}
		if (branches[branches.length - 1]!.cond) out += "{}";
		return out;
	}

	entry(a: Attr): string {
		if (a.kind === "cond") return `...(${this.condExpr(a.branches)})`;
		const key = /^[A-Za-z_$][\w$]*$/.test(a.name) ? a.name : JSON.stringify(a.name);
		if (a.kind === "dynamic") return `${key}: ${this.valueExpr(a.parts)}`;
		if (a.value === null || (a.value === "" && booleanish(a.name))) return `${key}: ${booleanish(a.name) ? "true" : '""'}`;
		return `${key}: ${JSON.stringify(decodeAttr(a.value))}`;
	}

	valueExpr(parts: ValPart[]): string {
		if (!parts.length) return '""';
		if (parts.every((p) => typeof p === "string")) return JSON.stringify(decodeAttr(parts.join("")));
		if (parts.length === 1) {
			const p = parts[0] as Exclude<ValPart, string>;
			if (p.t === "out") return `${this.nj("text")}(${this.expr(splitOutput(p.node).inner)})`;
			if (p.t === "block") return this.blockValue(p.name, this.valueExpr(p.parts), true);
			if (p.t === "for") return this.valueFor(p);
			return this.valueIf(p.branches);
		}
		return `\`${parts
			.map((p) => {
				if (typeof p === "string") return tl(decodeAttr(p)!);
				if (p.t === "out") return `\${${this.nj("text")}(${this.expr(splitOutput(p.node).inner)})}`;
				if (p.t === "block") return `\${${this.blockValue(p.name, this.valueExpr(p.parts), true)}}`;
				if (p.t === "for") return `\${${this.valueFor(p)}}`;
				return `\${${this.valueIf(p.branches)}}`;
			})
			.join("")}\``;
	}

	/**
	 * A block the layout places inside a start tag: the text the extending template gave it ($blocks, the most derived
	 * template's), else the layout's own content. A slot cannot sit in an attribute.
	 */
	blockValue(name: string, fallback: string, native = false): string {
		const given = `Astro.props.$blocks?.[${JSON.stringify(name)}]`;
		// A native attribute escapes its value, so it takes the printed text decoded, and escaping happens once
		return native ? `(${this.nj("unescapeHtml")}(${given}) ?? ${fallback})` : `(${given} ?? ${fallback})`;
	}

	/** For markForced: an output in an attribute that may print a macro's result sends its tag out as raw HTML. */
	readonly mayHoldSafe = (node: NjNode): boolean => isMacroCall(node, this.scope) || this.mayBeSafe(node);

	/** Whether an expression may hold a macro's SafeHtml: it calls a macro or reads a name set from one. */
	mayBeSafe(node: NjNode): boolean {
		const visit = (v: unknown): boolean => {
			if (!v || typeof v !== "object") return false;
			if (Array.isArray(v)) return v.some(visit);
			const n = v as NjNode;
			if (n.typename === "FunCall" && isMacroCall(n, this.scope)) return true;
			if (n.typename === "Symbol" && this.macroResults.has(String(n.value))) return true;
			return Object.values(n).some((x) => x && typeof x === "object" && visit(x));
		};
		return visit(node);
	}

	/** A loop inside an attribute value: each run's text, joined. */
	valueFor(p: Extract<ValPart, { t: "for" }>): string {
		return this.loop(p.node, () => this.valueExpr(p.parts), p.else ? () => this.valueExpr(p.else!) : null, '.join("")');
	}

	valueIf(branches: Array<{ cond: NjNode | null; parts: ValPart[] }>): string {
		let out = "";
		for (const b of branches) out += b.cond ? `${this.expr(b.cond)} ? ${this.valueExpr(b.parts)} : ` : this.valueExpr(b.parts);
		if (branches[branches.length - 1]!.cond) out += '""';
		return out;
	}

	/**
	 * A block's body as the text Nunjucks printed (a template literal), for a layout that places the block inside a
	 * start tag. Text, {{ }} outputs and if chains of them only; null for anything else.
	 */
	/**
	 * Whether a block's override could end the attribute the layout places it in. Nunjucks printed the override's own
	 * text raw, and a native Astro attribute escapes it: a literal quote of the attribute's (in an unquoted value, also
	 * a space or `>`), or a `| safe` output or a macro's result, made a second attribute there. Escaped outputs stay
	 * inside in both.
	 */
	blockBreaksOut(nodes: NjNode[], state: LexState): boolean {
		const ends = state.quote ? (t: string) => t.includes(state.quote!) : state.attr === "unquoted" ? (t: string) => /[\s"'>`=<]/.test(t) : () => false;
		const walk = (list: NjNode[]): boolean =>
			list.some((n) => {
				if (n.typename === "If") {
					const other = n.else_ as NjNode | null;
					return walk(kids(n.body as NjNode)) || (other ? walk(other.typename === "If" ? [other] : kids(other)) : false);
				}
				if (n.typename !== "Output") return false;
				return kids(n).some((c) => {
					if (c.typename === "TemplateData") return ends(String(c.value ?? ""));
					// `| safe`, and a macro's result (a SafeString), print as they stand
					const { inner, html } = splitOutput(c);
					return html || this.mayHoldSafe(inner);
				});
			});
		return walk(nodes);
	}

	blockText(nodes: NjNode[]): string | null {
		let out = "";
		for (const n of nodes) {
			if (n.typename === "If") {
				let chain = "";
				let c: NjNode | null = n;
				for (; c; ) {
					const text = this.blockText(kids(c.body as NjNode));
					if (text === null) return null;
					chain += `${this.expr(c.cond as NjNode)} ? ${text} : `;
					const other = c.else_ as NjNode | null;
					if (other?.typename === "If") c = other;
					else {
						const rest = other ? this.blockText(kids(other)) : '""';
						if (rest === null) return null;
						chain += rest;
						c = null;
					}
				}
				out += `\${${chain}}`;
				continue;
			}
			if (n.typename !== "Output") return null;
			for (const c of kids(n)) {
				if (c.typename === "TemplateData") out += tl(String(c.value ?? ""));
				else {
					const { inner, html } = splitOutput(c);
					out += `\${${this.nj(html ? "text" : "escape")}(${this.expr(inner)})}`;
				}
			}
		}
		return `\`${out}\``;
	}

	/** A start tag that Astro cannot hold, or raw HTML, as `set:html` with the text Nunjucks printed. */
	rawHtml(parts: Interp[]): string {
		return `<Fragment set:html={${this.rawLiteral(parts)}} />`;
	}

	rawLiteral(parts: Interp[]): string {
		if (!parts.length) return '""';
		return `\`${parts.map((p) => (typeof p === "string" ? tl(p) : `\${${this.rawPart(p)}}`)).join("")}\``;
	}

	rawPart(p: Exclude<Interp, string>): string {
		if (p.t === "out") {
			const { inner, html } = splitOutput(p.node);
			return `${this.nj(html ? "text" : "escape")}(${this.expr(inner)})`;
		}
		if (p.t === "if") {
			let out = "";
			for (const b of p.branches) out += b.cond ? `${this.expr(b.cond)} ? ${this.rawLiteral(b.parts)} : ` : this.rawLiteral(b.parts);
			if (p.branches[p.branches.length - 1]!.cond) out += '""';
			return out;
		}
		if (p.t === "block") return this.blockValue(p.name, this.rawLiteral(p.parts));
		return this.loop(p.node, () => this.rawLiteral(p.parts), p.else ? () => this.rawLiteral(p.else!) : null, '.join("")');
	}
}

function findCall(node: NjNode, names: Set<string>): string | null {
	let found: string | null = null;
	const visit = (n: unknown) => {
		if (found || !n || typeof n !== "object") return;
		if (Array.isArray(n)) return n.forEach(visit);
		const x = n as NjNode;
		if (x.typename === "FunCall" && (x.name as NjNode)?.typename === "Symbol" && names.has(String((x.name as NjNode).value))) found = String((x.name as NjNode).value);
		for (const v of Object.values(x)) if (v && typeof v === "object") visit(v);
	};
	visit(node);
	return found;
}

export function emitAstroComponent(t: Template, templates: Map<string, Template>, report: Report): EmittedFile {
	if (isRawFile(t)) return { path: outPath(t), source: t.source };
	const an = analyze(t, templates);
	const em = new AstroEmitter(t, templates, an, report);
	const builder = new MarkupBuilder(t, an, report);
	const ast = astOf(t);
	reportUnplacedSets(t, an, report);
	// Top-level sets are frontmatter consts, so the whole component sees them.
	for (const s of an.top) em.scope.locals.add(s.name);
	// The macros it imports and defines are module imports, and calls map their arguments
	const macros = macroBindings(t, templates, em.file, false, report);
	em.scope.macros = macros.macros;
	em.scope.namespaces = macros.namespaces;
	for (const n of macros.names) em.scope.locals.add(n);
	const visit = (v: unknown): void => {
		if (!v || typeof v !== "object") return;
		if (Array.isArray(v)) return v.forEach(visit);
		const x = v as NjNode;
		if (x.typename === "Macro") return; // a macro's body is text, printed with nj.escape already
		if (x.typename === "Set" && x.value && isMacroCall(x.value as NjNode, em.scope)) for (const target of x.targets as NjNode[]) em.macroResults.add(String(target.value));
		for (const c of Object.values(x)) if (c && typeof c === "object") visit(c);
	};
	visit(ast);

	let body: string;
	if (an.child) {
		const chain = layoutChain(t, templates);
		const parent = chain[0];
		const layout = parent ? em.importFor(parent) : null;
		// A template that others extend keeps a slot in each override, so a deeper override still wins.
		const extended = [...templates.values()].some((x) => x.extends === t.name);
		const fragments: string[] = [];
		const stringBlocks: string[] = [];
		for (const b of childBlocks(ast)) {
			const name = String((b.name as NjNode).value);
			if (parent && !parent.blocks.includes(name) && chain.slice(1).some((x) => x.blocks.includes(name))) {
				em.notTranslated(lineOf(b), "block", `The block "${name}" is declared further up than the layout this template extends, and that layout does not pass it on.`);
			}
			const fromLayout = layoutNames(chain, name, templates);
			const quoted = (names: Iterable<string>) => [...new Set(names)].sort().map((n) => `"${n}"`).join(", ");
			const seen = quoted([...(an.blockReads.get(name) ?? [])].filter((n) => fromLayout.has(n)));
			if (seen) em.notTranslated(lineOf(b), "block", `The block "${name}" reads ${seen}, which a layout sets or loops over where the block is called. A slot cannot see the layout's variables.`);
			// A loop set in a block writes into whatever holds the name on the frame the block is called from: a layout's
			// variable, or this template's own top-level set.
			const layoutReads = (n: string) => chain.some((x) => analyze(x, templates).readNames.has(n));
			const leaked = [...(an.blockLeaks.get(name) ?? new Map<string, boolean>())].filter(
				([n, seen]) => (fromLayout.has(n) && (seen || layoutReads(n))) || (an.rootSetNames.has(n) && (seen || an.rootReads.has(n) || layoutReads(n))),
			);
			const written = quoted(leaked.map(([n]) => n));
			if (written) em.notTranslated(lineOf(b), "block", `The block "${name}" sets ${written} inside a loop. Nunjucks then changes the variable the layout or this template's top level holds, which a slot cannot do.`);
			builder.state = parent ? rootLayoutState(parent, name, templates) : initialLexState();
			if (builder.state.mode === "tag") {
				// A slot cannot fill an attribute: the block goes to the layout as the text Nunjucks printed ($blocks)
				const text = em.blockText(kids(b.body as NjNode));
				if (text === null) em.notTranslated(lineOf(b), "block", `The layout places the block "${name}" inside an HTML tag, and the block holds more than text, {{ }} outputs and if chains of them.`);
				else if (em.blockBreaksOut(kids(b.body as NjNode), builder.state)) {
					em.notTranslated(lineOf(b), "block", `The layout places the block "${name}" inside an attribute, and this override's text could end that attribute (a quote, a | safe output or a macro's result), which Nunjucks printed as it stands and Astro's attribute escapes. Rewrite the override without it.`);
				} else stringBlocks.push(`${JSON.stringify(name)}: ${text}`);
				continue;
			}
			const list = builder.body(kids(b.body as NjNode));
			markForced(list, em.mayHoldSafe);
			balance(list);
			tidy(list);
			const markup = em.nodes(list);
			const inner = extended ? (markup ? `<slot name="${name}">${markup}</slot>` : `<slot name="${name}" />`) : markup;
			fragments.push(`<Fragment${layout ? ` slot="${name}"` : ""}>${inner}</Fragment>`);
		}
		const extendsNodes = kids(ast).filter((n) => n.typename === "Extends");
		for (const n of extendsNodes.slice(1)) em.notTranslated(lineOf(n), "extends", "Only the first extends in a template is translated.");
		if (layout) {
			const pass = an.passToParent.map((p) => ` ${p}={${jsName(p)}}`).join("");
			// A template that extends this one gave its blocks first, and the most derived template's block wins
			const blocks = stringBlocks.length ? ` $blocks={{ ${stringBlocks.join(", ")}, ...Astro.props.$blocks }}` : "";
			body = `<${layout} {...Astro.props}${pass}${blocks}>\n${fragments.join("\n")}\n</${layout}>\n`;
		} else body = `${fragments.join("\n")}\n`;
	} else {
		const list = builder.body(kids(ast));
		markForced(list, em.mayHoldSafe);
		balance(list);
		tidy(list);
		body = keepEdges(list, em.nodes(list));
	}
	const decls = an.top.map((s) => em.decl(s));

	const lines: string[] = [];
	if (em.usedNj) lines.push(`import * as nj from "${importPath(em.file, `${RUNTIME_DIR}/nunjucks.ts`)}";`);
	if (em.usedTs) lines.push(`import * as ts from "${importPath(em.file, `${RUNTIME_DIR}/filters.ts`)}";`);
	for (const { id, spec } of em.imports.values()) lines.push(`import ${id} from "${spec}";`);
	lines.push(...macros.lines);
	const free = [...em.scope.free];
	if (free.length) lines.push(`const { ${free.map((n) => (jsName(n) === n ? n : `${n}: ${jsName(n)}`)).join(", ")} } = Astro.props;`);
	lines.push(...decls);
	return { path: em.file, source: `---\n// Translated from the Nunjucks template ${t.name}.\n${lines.map((l) => `${l}\n`).join("")}---\n${body}` };
}
