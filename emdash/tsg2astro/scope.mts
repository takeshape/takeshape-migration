/**
 * What a template is to the emitters: its file names (where it is written, how others import it) and its scope
 * analysis, which decides which binding each read of a name sees and where each `set` goes. emit-astro.mts and
 * emit-text.mts both use it, so both kinds of template agree on what every name means.
 */
import { posix } from "node:path";
import { emitExpression, jsName } from "./expressions.mts";
import type { MacroSig, Scope } from "./expressions.mts";
import { Report } from "./report.mts";
import type { NjNode, Template } from "./templates.mts";

/** Where the generated project keeps the runtime files (tsg2astro/runtime/*.ts). */
export const RUNTIME_DIR = "src/lib/takeshape";
export const TEMPLATES_DIR = "src/templates";

export const kids = (n: NjNode | null | undefined): NjNode[] => ((n?.children as NjNode[] | undefined) ?? []);
export const lineOf = (n: NjNode): number => n.lineno + 1;

/** Escapes text for a JavaScript template literal. */
export function tl(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** The path of a module, relative to another module's folder, as an import specifier. */
export function importPath(fromFile: string, toFile: string): string {
	const rel = posix.relative(posix.dirname(fromFile), toFile);
	return rel.startsWith(".") ? rel : `./${rel}`;
}

/** A template that an includer pulls in as a string (`?raw`) instead of as a component. */
export function isRawFile(t: Template): boolean {
	return t.kind === "raw" && !/\.html?$/i.test(t.name);
}

/** The folder, under src/templates/ and src/loaders/, for site files outside the templates folder. */
export const SITE_FILES_DIR = "_site";

/**
 * A template or query name as takeshape-ssg read it, `path.join(templatePath, name)`: a path from the templates
 * folder, normalized. `partials/../x.html`, `/x.html` and `./x.html` are all `x.html`. A name that leaves the
 * templates folder keeps its leading `../`.
 */
export function templateKey(name: string): string {
	return posix.normalize(name.replace(/^\/+/, ""));
}

/**
 * Where a template or query (by its templateKey) is written, under src/templates/ or src/loaders/. A name in the
 * templates folder keeps its path. One that leaves it but stays in the site folder (an SVG included from
 * `static/`) goes under `_site/`, by its path from the site root, apart from the templates. Null for a name outside
 * the site folder, which tsg2astro refuses to read.
 */
export function siteFileName(key: string, templatePath: string): string | null {
	if (key !== ".." && !key.startsWith("../")) return key;
	const fromSite = posix.normalize(posix.join(templateKey(templatePath), key));
	if (fromSite === "." || fromSite === ".." || fromSite.startsWith("../")) return null;
	return `${SITE_FILES_DIR}/${fromSite}`;
}

/** The file a template becomes: `.astro` for HTML, `.ts` for text templates, the file itself for raw includes. */
export function outPath(t: Template): string {
	const name = t.outName ?? t.name;
	if (isRawFile(t)) return `${TEMPLATES_DIR}/${name}`;
	if (t.kind === "text") return `${TEMPLATES_DIR}/${name}.ts`;
	return `${TEMPLATES_DIR}/${name.replace(/\.[^./]+$/, "")}.astro`;
}

/** The module a template's macros become: `macros/image.html` gives `src/templates/macros/image.macros.ts`. */
export function macroModulePath(t: Template): string {
	return `${outPath(t).replace(/\.(astro|ts)$/, "")}.macros.ts`;
}

/** The macros a template defines at its top level, with their parameters as Nunjucks splits them. */
export function macroSignatures(t: Template): Map<string, MacroSig> {
	const out = new Map<string, MacroSig>();
	if (!t.ast) return out;
	for (const n of kids(t.ast)) {
		if (n.typename !== "Macro") continue;
		const argNames: string[] = [];
		const kwargNames: string[] = [];
		for (const a of kids(n.args as NjNode)) {
			if (a.typename === "KeywordArgs") for (const pair of kids(a)) kwargNames.push(String((pair.key as NjNode).value));
			else argNames.push(String(a.value));
		}
		out.set(String((n.name as NjNode).value), { argNames, kwargNames });
	}
	return out;
}

/**
 * What a template's {% from %} and {% import %} tags bind, and its own macros: the import lines a module at `from`
 * needs, and the scope entries that let calls map their arguments. `self` is the module that defines `t`'s own
 * macros, which imports nothing for them. A name imported that is no macro (a template's exported {% set %}) is
 * reported, once per template, and bound to an empty value.
 */
export function macroBindings(t: Template, templates: Map<string, Template>, from: string, self = false, report?: Report): { lines: string[]; macros: Map<string, MacroSig>; namespaces: Map<string, Map<string, MacroSig>>; names: string[] } {
	const lines: string[] = [];
	const macros = new Map<string, MacroSig>();
	const namespaces = new Map<string, Map<string, MacroSig>>();
	const names: string[] = [];
	const own = macroSignatures(t);
	if (own.size && !self) {
		lines.push(`import { ${[...own.keys()].map(jsName).join(", ")} } from "${importPath(from, macroModulePath(t))}";`);
	}
	for (const [name, sig] of own) {
		macros.set(name, sig);
		names.push(name);
	}
	if (!t.ast) return { lines, macros, namespaces, names };
	// Macros a template's includers import at their top level are in the context it renders with, as Nunjucks puts
	// them there: a partial calls `image(...)` that the page imported. When every includer that imports the name
	// imports the same macro, the partial imports it too.
	const bound = new Set([...own.keys(), ...kids(t.ast).flatMap((n) => importedNames(n))]);
	for (const name of calledNames(t.ast)) {
		if (bound.has(name)) continue;
		const found = new Map<string, { target: Template; macro: string; sig: MacroSig }>();
		for (const a of includersOf(t, templates)) {
			for (const n of kids(a.ast ?? undefined)) {
				if (n.typename !== "FromImport") continue;
				const target = templates.get(String((n.template as NjNode).value));
				if (!target) continue;
				for (const item of kids(n.names as NjNode)) {
					const macro = String((item.typename === "Pair" ? (item.key as NjNode) : item).value);
					const alias = item.typename === "Pair" ? String((item.value as NjNode).value) : macro;
					const sig = macroSignatures(target).get(macro);
					if (alias === name && sig) found.set(`${target.name}\u0000${macro}`, { target, macro, sig });
				}
			}
		}
		if (found.size !== 1) continue;
		const { target, macro, sig } = [...found.values()][0]!;
		lines.push(`import { ${macro === name ? jsName(name) : `${jsName(macro)} as ${jsName(name)}`} } from "${importPath(from, macroModulePath(target))}";`);
		macros.set(name, sig);
		names.push(name);
	}
	for (const n of kids(t.ast)) {
		if (n.typename !== "FromImport" && n.typename !== "Import") continue;
		const target = templates.get(String((n.template as NjNode).value));
		if (!target) continue; // loadTemplates reported it
		const sigs = macroSignatures(target);
		const spec = importPath(from, macroModulePath(target));
		const notMacro = (name: string, alias: string, message: string): void => {
			lines.push(`const ${jsName(alias)}: any = ${n.typename === "Import" ? "{}" : "undefined"};`);
			names.push(alias);
			const key = `${t.name}\u0000${lineOf(n)}\u0000${name}`;
			if (!report || reportedImports.get(report)?.has(key)) return;
			(reportedImports.get(report) ?? reportedImports.set(report, new Set()).get(report)!).add(key);
			report.add({ kind: "not-translated", file: t.name, line: lineOf(n), construct: name, message });
		};
		if (n.typename === "Import") {
			const alias = String((n.target as NjNode).value);
			if (!sigs.size) {
				notMacro(alias, alias, `"${alias}" imports ${target.name}, which defines no macros. Only macros are translated, not the names it sets, so "${alias}" is empty.`);
				continue;
			}
			lines.push(`import * as ${jsName(alias)} from "${spec}";`);
			namespaces.set(alias, sigs);
			names.push(alias);
			continue;
		}
		const parts: string[] = [];
		for (const item of kids(n.names as NjNode)) {
			const name = String((item.typename === "Pair" ? (item.key as NjNode) : item).value);
			const alias = item.typename === "Pair" ? String((item.value as NjNode).value) : name;
			const sig = sigs.get(name);
			if (!sig) {
				notMacro(name, alias, `"${name}" from ${target.name} is not a macro. Only macros are translated, not the names a template sets, so "${alias}" is empty.`);
				continue;
			}
			parts.push(alias === name ? jsName(name) : `${jsName(name)} as ${jsName(alias)}`);
			macros.set(alias, sig);
			names.push(alias);
		}
		if (parts.length) lines.push(`import { ${parts.join(", ")} } from "${spec}";`);
	}
	return { lines, macros, namespaces, names };
}

/** The names a {% from %} or {% import %} tag binds. */
function importedNames(n: NjNode): string[] {
	if (n.typename === "Import") return [String((n.target as NjNode).value)];
	if (n.typename !== "FromImport") return [];
	return kids(n.names as NjNode).map((item) => String((item.typename === "Pair" ? (item.value as NjNode) : item).value));
}

/** Imports already reported, per report: a template's own component and its macro module both bind them. */
const reportedImports = new WeakMap<Report, Set<string>>();

/** The names a template calls as plain functions, `name(...)`. */
export function calledNames(root: NjNode): Set<string> {
	const out = new Set<string>();
	const visit = (v: unknown): void => {
		if (!v || typeof v !== "object") return;
		if (Array.isArray(v)) return v.forEach(visit);
		const x = v as NjNode;
		if (x.typename === "FunCall" && (x.name as NjNode)?.typename === "Symbol") out.add(String((x.name as NjNode).value));
		for (const c of Object.values(x)) if (c && typeof c === "object") visit(c);
	};
	visit(root);
	return out;
}

/**
 * The templates whose context `t` renders with: those that include it, directly or through other includes, and those
 * that extend any of them (a child's top-level imports are in the context its layout renders with).
 */
function includersOf(t: Template, templates: Map<string, Template>): Template[] {
	const out: Template[] = [];
	const seen = new Set<string>([t.name]);
	const queue = [t.name];
	while (queue.length) {
		const name = queue.shift()!;
		for (const a of templates.values()) {
			if (seen.has(a.name) || !a.ast) continue;
			let includes = false;
			const visit = (v: unknown): void => {
				if (includes || !v || typeof v !== "object") return;
				if (Array.isArray(v)) return v.forEach(visit);
				const x = v as NjNode;
				if (x.typename === "Include" && (x.template as NjNode)?.value === name) includes = true;
				for (const c of Object.values(x)) if (c && typeof c === "object") visit(c);
			};
			visit(a.ast);
			if (!includes && a.extends !== name) continue;
			seen.add(a.name);
			out.push(a);
			queue.push(a.name);
		}
	}
	return out;
}

/** The parse tree, or a one-text-node tree for a template with no Nunjucks syntax. */
export function astOf(t: Template): NjNode {
	if (t.ast) return t.ast;
	const data: NjNode = { typename: "TemplateData", lineno: 0, colno: 0, value: t.source };
	return { typename: "Root", lineno: 0, colno: 0, children: [{ typename: "Output", lineno: 0, colno: 0, children: [data] }] };
}

/** Every name a template uses anywhere (reads, loop variables, sets), so generated names never collide with one. */
export function symbols(root: NjNode): Set<string> {
	const out = new Set<string>();
	const visit = (n: unknown) => {
		if (!n || typeof n !== "object") return;
		if (Array.isArray(n)) return n.forEach(visit);
		const x = n as NjNode;
		if (x.typename === "Symbol") out.add(String(x.value));
		for (const v of Object.values(x)) if (v && typeof v === "object") visit(v);
	};
	visit(root);
	return out;
}

export function pascal(s: string): string {
	const out = s
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((w) => w[0]!.toUpperCase() + w.slice(1))
		.join("");
	return /^[A-Za-z]/.test(out) ? out : `T${out}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Scope analysis: which binding each read of a name sees, decided once per template.
//
// Nunjucks 3.2.0 looks a name up at run time: the innermost frame that holds it, then the context. A loop pushes a
// frame, a block or an include pushes an isolated one, and a set writes into the nearest frame that already holds
// the name. Isolation only stops the first hop (runtime.js Frame.resolve does not pass forWrite on), so a set inside
// a loop that sits in an include or a block can still write into the includer's or the layout's variable.

type BodyKind = "root" | "block" | "if" | "loop" | "loop-else";
export type ABody = { kind: BodyKind; start: number; end: number; parent: ABody | null; frame: AFrame; block?: string };
export type AFrame = { kind: "root" | "block" | "loop"; vars: string[] };
/** `previous`: the old value a group of sets keeps where no branch sets it, read from the context. */
type ARead = { name: string; pos: number; body: ABody; previous?: boolean };
/** An if/elif/else chain: the body it sits in, its positions, and one body per branch (the else's cond is null). */
export type AChain = { node: NjNode; body: ABody; start: number; end: number; branches: Array<{ cond: NjNode | null; body: ABody }> };
export type Placement = "top" | "loop" | "iife" | "none";

/** Whether an expression calls anything: a function, a method or a macro. */
function callsAnything(root: unknown): boolean {
	if (!root || typeof root !== "object") return false;
	if (Array.isArray(root)) return root.some(callsAnything);
	const n = root as NjNode;
	if (n.typename === "FunCall") return true;
	return Object.values(n).some((v) => v && typeof v === "object" && callsAnything(v));
}
export type SetPlan = {
	node: NjNode;
	name: string;
	pos: number;
	body: ABody;
	frame: AFrame;
	placement: Placement;
	/** Why the set could not be placed, for the report. */
	why?: string;
	valueReads: string[];
	/** The group this set is one branch of, when the sets of its name in one if chain become one value. */
	group?: SetGroup;
};
/** What a name holds after an if chain, per branch: one set's value, a nested chain's, or null for the old value. */
export type ChainValue = { chain: AChain; branches: Array<{ cond: NjNode | null; value: SetPlan | ChainValue | null }> };
/**
 * The sets of one name in the branches of one if/elif/else chain (nested chains included), translated as one value
 * declared at the chain: `a ? x : b ? y : z`. Nunjucks runs at most one branch, and a branch without a set leaves
 * the name as it was. With no other set of the name in the template, that is the context's value.
 */
export type SetGroup = {
	name: string;
	/** The head of the chain. */
	chain: NjNode;
	value: ChainValue;
	/** Some run sets nothing, so the old value is part of the value. */
	previous: boolean;
	/** In source order. The first one stands for the group in `top` and in loop plans. */
	members: SetPlan[];
	start: number;
	end: number;
	/** The body the chain sits in. */
	body: ABody;
};
export type LoopPlan = { usesLoop: boolean; reads: Set<string>; sets: SetPlan[] };
export type Analysis = {
	child: boolean;
	parent: string | null;
	sets: Map<NjNode, SetPlan>;
	loops: Map<NjNode, LoopPlan>;
	/** Per if chain (by its head), the groups declared there, by their first member, in the order to declare them. */
	chains: Map<NjNode, SetPlan[]>;
	/** Frontmatter `const`s, in the order they must be declared. */
	top: SetPlan[];
	/** Names the template reads from its props, including what its includes and its layout read through it. */
	contextReads: Set<string>;
	/** For a child template: the top-level sets its layout reads. */
	passToParent: string[];
	/** For a child template: per block, the names it reads from its props or from its own top-level sets. */
	blockReads: Map<string, Set<string>>;
	/** Names read where the binding is one of this template's top-level sets (a layout may hold them too). */
	rootReads: Set<string>;
	/** Names set at the top level (they reach every block through the context). */
	rootSetNames: Set<string>;
	/**
	 * Names a set inside a loop here (or in an include) may write into an outer frame that holds the same name, each
	 * with whether a read in this template can see the written value.
	 */
	leaks: Map<string, boolean>;
	/** Every name read here, bound or not. */
	readNames: Set<string>;
	/** Per block declared here: names this template's frames hold where the block is called. */
	blockScope: Map<string, Set<string>>;
	/** Per block declared here: the block it sits in, or null. */
	enclosingBlock: Map<string, string | null>;
	/** Per block: names its loops (and the includes inside it) may write outward, as in `leaks`. */
	blockLeaks: Map<string, Map<string, boolean>>;
	/** Includes whose loop sets may write into a variable this template holds where it includes them. */
	includeLeaks: Array<{ node: NjNode; names: string[] }>;
};

export const SKIP_NAMES = new Set(["super", "caller"]);

/** Names an expression reads, as emitExpression sees them. */
function readsOf(expr: NjNode, file: string): string[] {
	const scope: Scope = { locals: new Set(), free: new Set() };
	emitExpression(expr, scope, new Report(), { file, line: lineOf(expr) });
	return [...scope.free].filter((n) => !SKIP_NAMES.has(n));
}

function ancestors(body: ABody): ABody[] {
	const out: ABody[] = [];
	for (let b: ABody | null = body; b; b = b.parent) out.push(b);
	return out;
}

/** Whether a loop variable (or `loop`) of an enclosing loop binds `name` at `body`. */
function loopBinds(body: ABody, name: string): boolean {
	return ancestors(body).some((b) => b.kind === "loop" && b.frame.vars.includes(name));
}

const inBlock = (body: ABody): boolean => ancestors(body).some((b) => b.kind === "block");

// Analyses depend on the analyses of included templates and of the layout. Include cycles (a tree partial that
// includes itself) are solved to a fixed point: every analysis of the cycle is recomputed until what the others
// read from it (contextReads, leaks) stops growing. Both only grow, so this ends.
const finished = new WeakMap<Template, Analysis>();
let round: { provisional: Map<Template, Analysis>; active: Set<Template>; seen: Set<Template>; cycle: boolean; changed: boolean } | null = null;

export function analyze(t: Template, templates: Map<string, Template>): Analysis {
	const done = finished.get(t);
	if (done) return done;
	if (round) {
		if (round.active.has(t)) {
			round.cycle = true;
			return round.provisional.get(t) ?? emptyAnalysis();
		}
		if (round.seen.has(t)) return round.provisional.get(t)!;
		return computeInRound(t, templates);
	}
	const provisional = new Map<Template, Analysis>();
	try {
		for (let n = 0; n < 50; n++) {
			round = { provisional, active: new Set(), seen: new Set(), cycle: false, changed: false };
			computeInRound(t, templates);
			if (!round.cycle || !round.changed) break;
		}
	} finally {
		round = null;
	}
	for (const [k, v] of provisional) finished.set(k, v);
	return provisional.get(t)!;
}

function computeInRound(t: Template, templates: Map<string, Template>): Analysis {
	const r = round!;
	r.active.add(t);
	const result = computeAnalysis(t, templates);
	r.active.delete(t);
	r.seen.add(t);
	const before = r.provisional.get(t);
	const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
	const sameLeaks = (a: Map<string, boolean>, b: Map<string, boolean>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
	if (!before || !same(before.contextReads, result.contextReads) || !sameLeaks(before.leaks, result.leaks)) r.changed = true;
	r.provisional.set(t, result);
	return result;
}

function computeAnalysis(t: Template, templates: Map<string, Template>): Analysis {
	const ast = astOf(t);
	const extendsNode = kids(ast).find((n) => n.typename === "Extends");
	const parentName = t.extends && extendsNode ? t.extends : null;
	const parent = parentName ? templates.get(parentName) ?? null : null;
	const child = parentName !== null;

	let pos = 0;
	const reads: ARead[] = [];
	const sets: SetPlan[] = [];
	const loops = new Map<NjNode, LoopPlan>();
	const loopBodies = new Map<NjNode, ABody>();
	const blockBodies: ABody[] = [];
	const chains: AChain[] = [];
	/** The chain each if branch body belongs to. */
	const branchOf = new Map<ABody, AChain>();
	const includes: Array<{ node: NjNode; pos: number; body: ABody; leaks: Map<string, boolean> }> = [];
	const rootFrame: AFrame = { kind: "root", vars: [] };
	const rootBody: ABody = { kind: "root", start: pos++, end: 0, parent: null, frame: rootFrame };

	const addReads = (names: Iterable<string>, body: ABody) => {
		const at = pos++;
		for (const name of names) reads.push({ name, pos: at, body });
	};
	const walkBody = (nodes: NjNode[], body: ABody) => {
		for (const n of nodes) walk(n, body);
		body.end = pos++;
	};
	const newBody = (kind: BodyKind, parentBody: ABody, frame: AFrame): ABody => ({ kind, start: pos++, end: 0, parent: parentBody, frame });
	const walkIf = (n: NjNode, body: ABody) => {
		const chain: AChain = { node: n, body, start: pos, end: 0, branches: [] };
		const branch = (cond: NjNode | null, nodes: NjNode[]) => {
			const b = newBody("if", body, body.frame);
			chain.branches.push({ cond, body: b });
			branchOf.set(b, chain);
			walkBody(nodes, b);
		};
		for (let c: NjNode | null = n; c; ) {
			addReads(readsOf(c.cond as NjNode, t.name), body);
			branch(c.cond as NjNode, kids(c.body as NjNode));
			const other = c.else_ as NjNode | null;
			if (other?.typename === "If") c = other;
			else {
				if (other) branch(null, kids(other));
				c = null;
			}
		}
		chain.end = pos++;
		chains.push(chain);
	};
	const walk = (n: NjNode, body: ABody): void => {
		switch (n.typename) {
			case "Output":
				// a child template prints nothing outside its blocks
				if (child && !inBlock(body)) return;
				for (const c of kids(n)) if (c.typename !== "TemplateData") addReads(readsOf(c, t.name), body);
				return;
			case "If":
				walkIf(n, body);
				return;
			case "For": {
				addReads(readsOf(n.arr as NjNode, t.name), body);
				const name = n.name as NjNode;
				const vars = name.typename === "Array" ? kids(name).map((c) => String(c.value)) : [String(name.value)];
				const frame: AFrame = { kind: "loop", vars: [...vars, "loop"] };
				const loopBody = newBody("loop", body, frame);
				loopBodies.set(n, loopBody);
				walkBody(kids(n.body as NjNode), loopBody);
				if (n.else_) walkBody(kids(n.else_ as NjNode), newBody("loop-else", body, { kind: "loop", vars: [] }));
				return;
			}
			case "Set": {
				const value = n.value as NjNode | null;
				const valueReads = value ? readsOf(value, t.name) : [];
				if (value) addReads(valueReads, body);
				else if (n.body) walkBody(kids((n.body as NjNode).body as NjNode), newBody("if", body, body.frame));
				for (const target of n.targets as NjNode[]) {
					sets.push({ node: n, name: String(target.value), pos: pos++, body, frame: body.frame, placement: "none", valueReads });
				}
				return;
			}
			case "Include": {
				const name = (n.template as NjNode).value;
				const inc = typeof name === "string" ? templates.get(name) : undefined;
				if (child && !inBlock(body)) return;
				if (inc && !isRawFile(inc)) {
					const a = analyze(inc, templates);
					// A name set again further down reaches the include as it stands here (versions.mts)
					const aliases = n.contextAliases as Record<string, string> | undefined;
					addReads([...a.contextReads].map((r) => aliases?.[r] ?? r), body);
					includes.push({ node: n, pos: pos - 1, body, leaks: a.leaks });
				}
				return;
			}
			case "Block": {
				const frame: AFrame = { kind: "block", vars: [] };
				const blockBody = newBody("block", body, frame);
				blockBody.block = String((n.name as NjNode).value);
				blockBodies.push(blockBody);
				walkBody(kids(n.body as NjNode), blockBody);
				return;
			}
			// A macro's body runs in its own frame when it is called (its module has its own analysis), and imports
			// bind names the template's own code doesn't set
			case "Macro":
			case "FromImport":
			case "Import":
				return;
			default:
				for (const v of Object.values(n)) {
					if (v && typeof v === "object" && "typename" in (v as object) && (v as NjNode).typename === "NodeList") walkBody(kids(v as NjNode), newBody("if", body, body.frame));
				}
		}
	};
	walkBody(kids(ast), rootBody);

	const parentAnalysis = parent ? analyze(parent, templates) : null;
	const parentReadPos = Number.MAX_SAFE_INTEGER;
	/**
	 * The frames whose variables a position in `body` can reach, as far as this template goes. In a child template the
	 * layout calls the blocks, and its top-level render runs on the child's own frame, so at run time the child's
	 * top-level sets are on its blocks' chain too, under whatever the layouts set or loop over there. That frame is left
	 * out here: a set directly in a block stops at the block's isolated frame, and the reads and loop-set writes that
	 * reach the child's top level are checked against the layouts in emit-astro.mts (blockReads, rootReads, layoutNames).
	 */
	const framesAt = (body: ABody): Set<AFrame> => new Set(ancestors(body).filter((b) => !(child && b.kind === "root" && body !== b && inBlock(body))).map((b) => b.frame));
	/** Names held in this template's frames at `at` inside `body`: loop variables and sets that ran before. */
	const boundAt = (body: ABody, at: number): Set<string> => {
		const frames = framesAt(body);
		const out = new Set<string>();
		for (const b of ancestors(body)) if (b.kind === "loop") for (const v of b.frame.vars) out.add(v);
		for (const s of sets) if (s.pos < at && frames.has(s.frame)) out.add(s.name);
		return out;
	};

	// Decide where each set goes, in source order (a later set never encloses an earlier one).
	const topNames = new Set<string>();
	const enclosing = (p: SetPlan, at: number) => (p.placement === "loop" || p.placement === "iife") && at > (p.group?.start ?? p.pos) && at <= (p.group?.body ?? p.body).end;
	// Two sets of a name share one variable when one's frame is on the other's chain (the same frame or an outer
	// one). Sets in sibling loops each stay in their own loop's frame.
	const shares = (a: SetPlan, b: SetPlan) => a !== b && a.name === b.name && (framesAt(a.body).has(b.frame) || framesAt(b.body).has(a.frame));
	const frameBodyOf = (frame: AFrame, body: ABody): ABody | undefined =>
		frame.kind === "root" ? rootBody : ancestors(body).find((b) => b.frame === frame && (b.kind === "block" || b.kind === "loop" || b.kind === "loop-else"));
	const plainSet = (s: SetPlan): string | null => {
		if (s.node.body) return "A set with a body ({% set %}...{% endset %}) is not translated.";
		if ((s.node.targets as NjNode[]).length > 1) return "A set with several names is not translated.";
		if (loopBinds(s.body, s.name)) return `"${s.name}" is also a loop variable here.`;
		if (s.valueReads.includes(s.name)) return `The new value of "${s.name}" reads its old value.`;
		return null;
	};

	/** The chains around a body, innermost first, as long as each sits directly in a branch of the next. */
	const chainsAround = (body: ABody): AChain[] => {
		const out: AChain[] = [];
		for (let c = branchOf.get(body); c; c = branchOf.get(c.body)) out.push(c);
		return out;
	};
	const within = (outer: ABody, at: number) => at > outer.start && at <= outer.end;
	/**
	 * The sets of a name as one group on the innermost chain that holds them all, or null where they are not one: each
	 * branch may set the name once, directly or through one nested chain that sits directly in the branch.
	 */
	const chainGroup = (members: SetPlan[]): SetGroup | null => {
		if (members.some((m) => plainSet(m) !== null)) return null;
		const around = members.map((m) => chainsAround(m.body));
		const chain = around[0]!.find((c) => around.every((a) => a.includes(c)));
		if (!chain) return null;
		let previous = false;
		const valueOf = (c: AChain): ChainValue | null => {
			const branches: ChainValue["branches"] = [];
			for (const b of c.branches) {
				const inside = members.filter((m) => within(b.body, m.pos));
				if (!inside.length) {
					previous = true;
					branches.push({ cond: b.cond, value: null });
					continue;
				}
				if (inside.length === 1 && inside[0]!.body === b.body) {
					branches.push({ cond: b.cond, value: inside[0]! });
					continue;
				}
				const nested = chains.find((d) => d.body === b.body && inside.every((m) => chainsAround(m.body).includes(d)));
				const value = nested ? valueOf(nested) : null;
				if (!value) return null;
				branches.push({ cond: b.cond, value });
			}
			if (c.branches[c.branches.length - 1]!.cond) previous = true;
			return { chain: c, branches };
		};
		const value = valueOf(chain);
		if (!value) return null;
		return { name: members[0]!.name, chain: chain.node, value, previous, members, start: chain.start, end: chain.end, body: chain.body };
	};

	/** Whether a read inside a group's chain sees the group's value: it sits in a branch, after that branch's set. */
	const readSeesGroup = (r: ARead, value: ChainValue): boolean => {
		const k = value.chain.branches.findIndex((b) => within(b.body, r.pos));
		if (k < 0) return false; // in a condition, which runs before any set of the chain
		const v = value.branches[k]!.value;
		if (v === null) return true;
		if ("node" in v) return r.pos > v.pos;
		if (r.pos > v.chain.end) return true;
		return r.pos >= v.chain.start && readSeesGroup(r, v);
	};
	/** What a group's conditions and values read, each with the position it is read at. */
	const groupUses = (value: ChainValue, out: Array<{ name: string; at: number }> = []) => {
		for (const b of value.chain.branches) if (b.cond) for (const name of readsOf(b.cond, t.name)) out.push({ name, at: value.chain.start });
		for (const b of value.branches) {
			if (b.value && "node" in b.value) for (const name of b.value.valueReads) out.push({ name, at: b.value.pos });
			else if (b.value) groupUses(b.value, out);
		}
		return out;
	};

	/** Whether a group's conditions, its nested chains' included, call a function. */
	const conditionsCall = (value: ChainValue): boolean =>
		value.chain.branches.some((b) => b.cond !== null && callsAnything(b.cond)) || value.branches.some((b) => b.value !== null && !("node" in b.value) && conditionsCall(b.value));

	/** Where a group goes, or why it cannot be translated. */
	const placeGroup = (g: SetGroup): Placement | string => {
		// The value repeats the chain's conditions and the markup runs them again, where Nunjucks ran them once: a call
		// (a joiner, loop.cycle) can answer differently the second time
		if (conditionsCall(g.value)) return `The conditions of the if that sets "${g.name}" call a function, which Nunjucks ran once and the translation would run twice.`;
		const frame = g.body.frame;
		const all = reads.filter((r) => r.name === g.name && !loopBinds(r.body, g.name));
		if (child && frame.kind === "root" && parentAnalysis?.contextReads.has(g.name)) all.push({ name: g.name, pos: parentReadPos, body: rootBody });
		const inChain = (r: ARead) => r.pos >= g.start && r.pos <= g.end;
		if (all.some((r) => inChain(r) && !readSeesGroup(r, g.value))) return `"${g.name}" is read inside the if before a branch sets it.`;
		if (g.previous && sets.some((o) => o.name === g.name && !g.members.includes(o))) {
			return `"${g.name}" is also set outside this if, so where no branch sets it, its value depends on the order the template runs in.`;
		}
		if (g.previous && frame.kind === "loop") return `Where no branch of this if sets "${g.name}", it keeps the value of the loop's previous run.`;
		const frameBody = frameBodyOf(frame, g.body);
		const frameEnd = frameBody?.end ?? rootBody.end;
		const outside = all.filter((r) => !inChain(r));
		const inRegion = (r: ARead): boolean => (frame.kind === "root" ? r.pos > g.end || (child && inBlock(r.body)) : r.pos > g.end && r.pos <= frameEnd);
		const readsIn = outside.filter(inRegion);
		const readsOut = outside.filter((r) => !inRegion(r));
		const uses = groupUses(g.value);
		const valueFromScope = uses.some(({ name }) => loopBinds(g.body, name) || sets.some((o) => o.name === name && !g.members.includes(o) && enclosing(o, g.start)));
		// a name set earlier inside the chain, which the value can read only through an earlier group of the chain
		const chainDeps = uses.flatMap(({ name, at }) => sets.filter((o) => o.name === name && o.pos > g.start && o.pos < at && !g.members.includes(o)));
		const readsBeforeInLoop = frame.kind === "loop" && frameBody ? readsOut.some((r) => r.pos >= frameBody.start && r.pos <= frameBody.end) : false;
		const direct = g.body.kind === "root" || g.body.kind === "block" || g.body.kind === "loop";
		let placement: Placement | null = null;
		if (direct && (frame.kind === "root" || frame.kind === "block") && !readsOut.length && !topNames.has(g.name) && !valueFromScope) placement = "top";
		else if (direct && g.body.kind === "loop" && !readsBeforeInLoop) placement = "loop";
		else if (!(child && frame.kind === "root") && !readsBeforeInLoop && readsIn.every((r) => r.pos <= g.body.end)) placement = "iife";
		if (!placement) return `"${g.name}" is read where the translator cannot follow its value.`;
		if (chainDeps.some((o) => o.group?.chain !== g.chain || o.placement !== placement)) return `The value of "${g.name}" reads a name set earlier in the same if, which the translator cannot follow.`;
		return placement;
	};
	const groupAt = new Map<NjNode, SetPlan[]>();
	const tryGroup = (s: SetPlan, members: SetPlan[]): boolean => {
		const g = chainGroup(members);
		if (!g) return false;
		const placement = placeGroup(g);
		for (const m of members) {
			m.group = g;
			if (placement === "top" || placement === "loop" || placement === "iife") m.placement = placement;
			else {
				m.placement = "none";
				m.why = placement;
			}
		}
		if (s.placement === "none") return true;
		if (s.placement === "top") topNames.add(s.name);
		groupAt.set(g.chain, [...(groupAt.get(g.chain) ?? []), s]);
		return true;
	};

	for (const s of sets) {
		if (s.group) continue; // placed with its group
		const fail = (why: string) => {
			s.placement = "none";
			s.why = why;
		};
		const sharing = sets.filter((x) => shares(s, x));
		const undecided = sharing.every((x) => x.placement === "none" && x.why === undefined);
		if (sharing.length && undecided && tryGroup(s, [s, ...sharing])) continue;
		if (s.node.body) {
			fail("A set with a body ({% set %}...{% endset %}) is not translated.");
			continue;
		}
		if ((s.node.targets as NjNode[]).length > 1) {
			fail("A set with several names is not translated.");
			continue;
		}
		if (sharing.length) {
			fail(`"${s.name}" is set more than once in the same scope, so its value depends on the order the template runs in.`);
			continue;
		}
		if (loopBinds(s.body, s.name)) {
			fail(`"${s.name}" is also a loop variable here.`);
			continue;
		}
		if (s.valueReads.includes(s.name)) {
			fail(`The new value of "${s.name}" reads its old value.`);
			continue;
		}
		const all = reads.filter((r) => r.name === s.name && !loopBinds(r.body, s.name));
		if (child && s.frame.kind === "root" && parentAnalysis?.contextReads.has(s.name)) all.push({ name: s.name, pos: parentReadPos, body: rootBody });
		const frameBody = s.frame.kind === "root" ? rootBody : ancestors(s.body).find((b) => b.frame === s.frame && (b.kind === "block" || b.kind === "loop" || b.kind === "loop-else"));
		const frameEnd = frameBody?.end ?? rootBody.end;
		const inRegion = (r: ARead): boolean => {
			if (s.frame.kind === "root") return r.pos > s.pos || (child && inBlock(r.body));
			return r.pos > s.pos && r.pos <= frameEnd;
		};
		const readsIn = all.filter(inRegion);
		const readsOut = all.filter((r) => !inRegion(r));
		const direct = s.body.kind === "root" || s.body.kind === "block" || s.body.kind === "loop";
		const valueFromScope = s.valueReads.some((n) => loopBinds(s.body, n) || sets.some((o) => o !== s && o.name === n && enclosing(o, s.pos)));
		const loopFrame = s.frame.kind === "loop";
		const readsBeforeInLoop = loopFrame && frameBody ? readsOut.some((r) => r.pos >= frameBody.start && r.pos <= frameBody.end) : false;
		if (direct && (s.frame.kind === "root" || s.frame.kind === "block") && !readsOut.length && !topNames.has(s.name) && !valueFromScope) {
			s.placement = "top";
			topNames.add(s.name);
		} else if (direct && s.body.kind === "loop" && !readsBeforeInLoop) {
			s.placement = "loop";
		} else if (!(child && s.frame.kind === "root") && !readsBeforeInLoop && readsIn.every((r) => r.pos > s.pos && r.pos <= s.body.end)) {
			s.placement = "iife";
		} else if (!tryGroup(s, [s])) {
			// a set in an if branch that is read after the if: the if may still give one value
			fail(`"${s.name}" is read where the translator cannot follow its value.`);
		}
	}

	// A group that keeps the old value somewhere reads it where its chain starts.
	for (const [, leads] of groupAt) for (const s of leads) if (s.group!.previous) reads.push({ name: s.name, pos: s.group!.start, body: s.group!.body, previous: true });
	/** Whether a set or its group is the one that declares the value (a group declares it once, for its first set). */
	const declares = (s: SetPlan) => !s.group || s.group.members[0] === s;
	/** Whether a read sees the value a loop or IIFE declaration holds. */
	const sees = (r: ARead, s: SetPlan) => r.pos > (s.group?.start ?? s.pos) && r.pos <= (s.group?.body ?? s.body).end;

	for (const [node, body] of loopBodies) {
		const inside = (r: ARead) => r.pos > body.start && r.pos <= body.end;
		// the innermost loop around the read is this one
		const own = (r: ARead) => ancestors(r.body).find((b) => b.kind === "loop") === body;
		const loopReads = reads.filter((r) => inside(r));
		loops.set(node, {
			usesLoop: loopReads.some((r) => r.name === "loop" && own(r)),
			reads: new Set(loopReads.map((r) => r.name)),
			sets: sets.filter((x) => x.placement === "loop" && declares(x) && (x.group?.body ?? x.body) === body),
		});
	}

	const bound = (r: ARead): boolean => {
		if (r.previous) return false;
		if (loopBinds(r.body, r.name)) return true;
		return sets.some((s) => {
			if (s.name !== r.name) return false;
			if (s.placement === "top") return true;
			return (s.placement === "loop" || s.placement === "iife") && sees(r, s);
		});
	};
	const contextReads = new Set<string>();
	for (const r of reads) if (!bound(r)) contextReads.add(r.name);
	const rootTop = sets.filter((s) => s.placement === "top" && s.frame.kind === "root" && declares(s));
	if (parentAnalysis) for (const n of parentAnalysis.contextReads) if (!rootTop.some((s) => s.name === n)) contextReads.add(n);

	// Write-through from loops: a set inside a loop writes into the nearest outer frame that holds the name, even
	// past an include or a block. It matters when a read can see the new value.
	const unboundReadAfter = (name: string, at: number, outer: ABody | null) => reads.some((r) => r.name === name && r.pos > at && (!outer || within(outer, r.pos)) && !bound(r));
	const anyReadAfter = (name: string, at: number) => reads.some((r) => r.name === name && r.pos > at && !loopBinds(r.body, name));
	const includeLeaks: Analysis["includeLeaks"] = [];
	const leaksWithin = (outer: ABody | null): Map<string, boolean> => {
		const out = new Map<string, boolean>();
		const add = (n: string, seen: boolean) => out.set(n, (out.get(n) ?? false) || seen);
		for (const s of sets) if (s.frame.kind === "loop" && (!outer || within(outer, s.pos))) add(s.name, unboundReadAfter(s.name, s.pos, outer));
		for (const inc of includes) {
			if (outer && !within(outer, inc.pos)) continue;
			const held = boundAt(inc.body, inc.pos);
			for (const [n, seen] of inc.leaks) if (!held.has(n)) add(n, seen || unboundReadAfter(n, inc.pos, outer));
		}
		return out;
	};
	const leaks = leaksWithin(null);
	for (const inc of includes) {
		const held = boundAt(inc.body, inc.pos);
		const names = [...inc.leaks].filter(([n, seen]) => held.has(n) && (seen || anyReadAfter(n, inc.pos))).map(([n]) => n).sort();
		if (names.length) includeLeaks.push({ node: inc.node, names });
	}

	/** Bound by a loop variable or by a set below the top level (in a block or a loop), not by a top-level set. */
	const boundBelowRoot = (r: ARead): boolean =>
		!r.previous &&
		(loopBinds(r.body, r.name) || sets.some((s) => s.name === r.name && s.frame.kind !== "root" && (s.placement === "top" || ((s.placement === "loop" || s.placement === "iife") && sees(r, s)))));
	const rootNames = new Set(sets.filter((s) => s.frame.kind === "root").map((s) => s.name));
	const rootReads = new Set(reads.filter((r) => !r.previous && rootNames.has(r.name) && !boundBelowRoot(r)).map((r) => r.name));
	const blockReads = new Map<string, Set<string>>();
	const blockScope = new Map<string, Set<string>>();
	const enclosingBlock = new Map<string, string | null>();
	const blockLeaks = new Map<string, Map<string, boolean>>();
	for (const body of blockBodies) {
		const name = body.block!;
		blockScope.set(name, boundAt(body.parent!, body.start));
		enclosingBlock.set(name, ancestors(body.parent!).find((b) => b.kind === "block")?.block ?? null);
		blockLeaks.set(name, leaksWithin(body));
		if (child) {
			const names = blockReads.get(name) ?? new Set<string>();
			for (const r of reads) if (within(body, r.pos) && !boundBelowRoot(r)) names.add(r.name);
			blockReads.set(name, names);
		}
	}
	const top = child
		? [...rootTop, ...sets.filter((s) => s.placement === "top" && s.frame.kind !== "root" && declares(s))]
		: sets.filter((s) => s.placement === "top" && declares(s));
	return {
		child,
		parent: parentName,
		sets: new Map(sets.map((s) => [s.node, s])),
		loops,
		chains: groupAt,
		top,
		contextReads,
		passToParent: parentAnalysis ? rootTop.map((s) => s.name).filter((n) => parentAnalysis.contextReads.has(n)) : [],
		blockReads,
		rootSetNames: rootNames,
		rootReads,
		leaks,
		readNames: new Set(reads.map((r) => r.name)),
		blockScope,
		enclosingBlock,
		blockLeaks,
		includeLeaks,
	};
}

function emptyAnalysis(): Analysis {
	return {
		child: false,
		parent: null,
		sets: new Map(),
		loops: new Map(),
		chains: new Map(),
		top: [],
		contextReads: new Set(),
		passToParent: [],
		blockReads: new Map(),
		rootSetNames: new Set(),
		rootReads: new Set(),
		leaks: new Map(),
		readNames: new Set(),
		blockScope: new Map(),
		enclosingBlock: new Map(),
		blockLeaks: new Map(),
		includeLeaks: [],
	};
}

/**
 * Names a child's block sees from its layouts at run time, over its props and over the child's own top-level sets:
 * every middle layout's top-level sets (they run before any block, on the frame the blocks are called from) and what
 * the frames hold where the block is called (loop variables, the root layout's top-level sets made before the call,
 * sets in enclosing blocks).
 */
export function layoutNames(chain: Template[], block: string, templates: Map<string, Template>): Set<string> {
	const out = new Set<string>();
	for (const a of chain) {
		const an = analyze(a, templates);
		if (an.child) for (const n of an.rootSetNames) out.add(n);
	}
	const callSite = (from: number, name: string): void => {
		for (let k = from; k < chain.length; k++) {
			const an = analyze(chain[k]!, templates);
			const scope = an.blockScope.get(name);
			if (!scope) continue;
			const outer = an.enclosingBlock.get(name) ?? null;
			// a top-level override in a middle layout is not where the block is called
			if (an.child && outer === null) continue;
			for (const n of scope) out.add(n);
			if (an.child && outer) callSite(k + 1, outer);
			return;
		}
	};
	callSite(0, block);
	return out;
}

/** The templates a template extends, nearest first. */
export function layoutChain(t: Template, templates: Map<string, Template>): Template[] {
	const out: Template[] = [];
	for (let p = t.extends ? templates.get(t.extends) : undefined; p && !out.includes(p); p = p.extends ? templates.get(p.extends) : undefined) out.push(p);
	return out;
}

/**
 * The value a set gives its name: its own expression, or for a group one condition per branch, with `previous` (the
 * context's value) where no branch sets it.
 */
export function setValue(s: SetPlan, expr: (n: NjNode) => string, previous: string): string {
	if (!s.group) return expr(s.node.value as NjNode);
	const chain = (v: ChainValue): string => {
		let out = "";
		for (const b of v.branches) {
			const value = b.value === null ? previous : "node" in b.value ? expr(b.value.node.value as NjNode) : `(${chain(b.value)})`;
			out += b.cond ? `${expr(b.cond)} ? ${value} : ` : value;
		}
		return v.branches[v.branches.length - 1]!.cond ? out + previous : out;
	};
	return chain(s.group.value);
}

/** Reports every set the analysis could not place. */
export function reportUnplacedSets(t: Template, an: Analysis, report: Report): void {
	const seen = new Set<NjNode>();
	for (const s of an.sets.values()) {
		if (s.placement !== "none" || seen.has(s.node)) continue;
		seen.add(s.node);
		report.add({ kind: "not-translated", file: t.name, line: lineOf(s.node), construct: "set", message: `${s.why ?? ""} The set is left out.`.trim() });
	}
}
