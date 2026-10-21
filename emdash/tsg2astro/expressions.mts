/**
 * Translates Nunjucks expressions (the inside of `{{ }}` and of `{% if %}`, `{% for %}` and `{% set %}`) into
 * JavaScript expression source for the generated Astro components. The generated code calls two namespaces the
 * component imports: `nj` (tsg2astro/runtime/nunjucks.ts) and `ts` (the TakeShape filters).
 *
 * Operators are emitted the way Nunjucks 3.2.0's own compiler emits them, flat and without extra parentheses,
 * because that is what the original site ran. That includes its quirks: `a ~ b` is `a + "" + b` (so `none ~ "x"`
 * prints "nullx"), and `not a == b` is `(!a) == b`. Only a `( )` group in the source adds parentheses.
 */
import type { Report } from "./report.mts";
// The image endpoint's own rules. imgix.ts imports nothing, so the translator loads no other runtime code.
import { imageParamProblem, IMGIX_PARAMS } from "./runtime/imgix.ts";
import type { NjNode } from "./templates.mts";

/**
 * A macro's parameters, as Nunjucks 3.2.0 splits them: `argNames` without a default, then `kwargNames` with one
 * (macro m(a, b, c="x") has argNames [a, b] and kwargNames [c]).
 */
export type MacroSig = { argNames: string[]; kwargNames: string[] };
/**
 * `macros`: the macros a template can call by name ({% from %} imports and its own), each with its signature.
 * `namespaces`: the names {% import "x" as m %} binds, each to the macros of x.
 */
export type Scope = {
	locals: Set<string>;
	free: Set<string>;
	macros?: Map<string, MacroSig>;
	namespaces?: Map<string, Map<string, MacroSig>>;
	/** Called with each Symbol node read from the context, the reads `free` collects. */
	onRead?: (symbol: NjNode) => void;
};
export type SourceAt = { file: string; line: number };

/** Filters the runtime implements, by the name the template uses. `d` and `e` are Nunjucks aliases. */
const STOCK_FILTERS: Record<string, string> = {
	length: "length",
	lower: "lower",
	upper: "upper",
	title: "title",
	sort: "sort",
	striptags: "striptags",
	replace: "replace",
	dump: "dump",
	urlencode: "urlencode",
	default: "default",
	d: "default",
	join: "join",
	first: "first",
	last: "last",
	trim: "trim",
	escape: "escape",
	e: "escape",
};

/** Positional parameter names for filters whose Nunjucks version takes keyword arguments (makeMacro). */
const KWARG_NAMES: Record<string, string[]> = { sort: ["reverse", "case_sensitive", "attribute"] };

/**
 * Stock filters whose result is a plain string or value in Nunjucks even when the input is a SafeString
 * (they never call copySafeness), so an `escape` feeding them gives the same output here.
 */
const DROPS_SAFENESS = new Set(["upper", "lower", "join", "first", "last", "length", "dump", "urlencode", "sort"]);

/** TakeShape filters the translator writes. */
const TS_FILTERS = new Set(["image", "asset", "route", "date"]);

/** The imgix parameters the generated image endpoint honors, for report messages. */
const HONORED_IMAGE_PARAMS = `${IMGIX_PARAMS.slice(0, -1).join(", ")} and ${IMGIX_PARAMS.at(-1)}`;
/** TakeShape filters nobody has translated yet. */
const TS_PENDING = new Set(["md", "number", "numberFormat", "code", "pluralize", "union", "intersection"]);
/** Nunjucks globals with no translation. `now` is a TakeShape global and prints nothing here. */
const UNSUPPORTED_GLOBALS = new Set(["range", "cycler"]);
/** Nunjucks globals the runtime implements. */
const RUNTIME_GLOBALS = new Set(["joiner"]);

const RESERVED = new Set([
	"break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export", "extends", "false",
	"finally", "for", "function", "if", "import", "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
	"typeof", "var", "void", "while", "with", "yield", "let", "static", "implements", "interface", "package", "private", "protected", "public",
	"await", "async", "arguments", "eval", "undefined", "NaN", "Infinity",
	// names the generated code itself uses
	"nj", "ts", "Math", "Astro",
]);

/** The JavaScript identifier for a Nunjucks variable name. Reserved words and the generated code's own names get a `$` suffix. */
/**
 * The index and list parameters of a loop callback: `i` and `all`, or with `$` added until they clear the loop's own
 * names (its variable, `loop`, its sets) and every name its body reads. A loop over `i` once declared `i` twice.
 */
export function loopParams(own: Iterable<string>, reads: Iterable<string> = []): { i: string; all: string } {
	const taken = new Set<string>();
	for (const n of [...own, ...reads]) {
		taken.add(n);
		taken.add(jsName(n));
	}
	const free = (base: string): string => {
		let n = base;
		while (taken.has(n)) n += "$";
		taken.add(n);
		return n;
	};
	return { i: free("i"), all: free("all") };
}

export function jsName(name: string): string {
	return RESERVED.has(name) ? `${name}$` : name;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const children = (n: NjNode | undefined): NjNode[] => ((n?.children as NjNode[] | undefined) ?? []);

/**
 * Splits off an outermost `| safe` (the emitter turns it into `set:html`) or `| escape` (Astro already escapes
 * text, so the filter is dropped). `inner` is what to pass to `emitExpression`.
 */
export function splitOutput(node: NjNode): { inner: NjNode; html: boolean } {
	if (node.typename === "Filter") {
		const name = (node.name as NjNode).value;
		const first = children(node.args as NjNode)[0];
		if (first && name === "safe") return { inner: first, html: true };
		if (first && (name === "escape" || name === "e")) return { inner: first, html: false };
	}
	return { inner: node, html: false };
}

/** Whether an output is a call to a macro the scope knows, whose result Nunjucks printed unescaped. */
export function isMacroCall(node: NjNode, scope: Scope): boolean {
	if (node.typename !== "FunCall") return false;
	const callee = node.name as NjNode;
	if (callee.typename === "Symbol") return scope.macros?.has(String(callee.value)) ?? false;
	if (callee.typename === "LookupVal" && (callee.target as NjNode).typename === "Symbol" && (callee.val as NjNode).typename === "Literal") {
		return scope.namespaces?.get(String((callee.target as NjNode).value))?.has(String((callee.val as NjNode).value)) ?? false;
	}
	return false;
}

export function emitExpression(node: NjNode, scope: Scope, report: Report, at: SourceAt): string {
	const fail = (construct: string, message: string): string => {
		report.add({ kind: "not-translated", file: at.file, line: at.line, construct, message });
		return "undefined";
	};
	const emit = (n: NjNode): string => expr(n);
	/** `escape` filters whose parent turns the result into a plain string in Nunjucks, so no report is needed. */
	const harmless = new Set<NjNode>();
	const peel = (n: NjNode | undefined): NjNode | undefined => (n?.typename === "Group" && children(n).length === 1 ? peel(children(n)[0]) : n);
	const markHarmless = (n: NjNode | undefined): void => {
		const f = peel(n);
		if (f?.typename === "Filter" && ["escape", "e"].includes((f.name as NjNode).value as string)) harmless.add(f);
	};

	const binary = (n: NjNode, op: string): string => `${emit(n.left as NjNode)}${op}${emit(n.right as NjNode)}`;

	function key(n: NjNode): string | null {
		if (n.typename === "Symbol") return IDENT.test(n.value as string) ? (n.value as string) : JSON.stringify(n.value);
		if (n.typename === "Literal" && typeof n.value === "string") return IDENT.test(n.value) ? n.value : JSON.stringify(n.value);
		return null;
	}

	function args(list: NjNode[], construct: string, kwNames?: string[]): string[] | null {
		const positional = list.filter((a) => a.typename !== "KeywordArgs");
		const kw = list.find((a) => a.typename === "KeywordArgs");
		const out = positional.map(emit);
		if (!kw) return out;
		if (!kwNames) {
			fail(construct, "Keyword arguments have no JavaScript equivalent here. Rewrite the call with positional arguments.");
			return null;
		}
		for (const pair of children(kw)) {
			const name = (pair.key as NjNode).value as string;
			const at0 = kwNames.indexOf(name);
			if (at0 === -1) {
				fail(construct, `Unknown keyword argument "${name}".`);
				return null;
			}
			const index = positional.length + at0; // keyword names continue after the positional arguments
			while (out.length < index) out.push("undefined");
			out[index] = emit(pair.value as NjNode);
		}
		return out;
	}

	function filter(n: NjNode): string {
		const name = (n.name as NjNode).value as string;
		const list = children(n.args as NjNode);
		if (name === "safe") {
			// splitOutput strips the outermost safe. Nunjucks keeps this value safe through later steps; the runtime cannot.
			report.add({
				kind: "not-translated",
				file: at.file,
				line: at.line,
				construct: "safe",
				message: "A `| safe` that is not the last step is not translated: the output is escaped. Move `| safe` to the end or rewrite by hand.",
			});
			return list[0] ? emit(list[0]) : "undefined";
		}
		const stock = STOCK_FILTERS[name];
		if (stock === "escape" && !harmless.has(n)) {
			report.add({
				kind: "not-translated",
				file: at.file,
				line: at.line,
				construct: "escape",
				message: "An `| escape` that is not the last step is not translated: Nunjucks keeps its result safe, so this output may be escaped twice. Rewrite by hand.",
			});
		}
		if (stock && DROPS_SAFENESS.has(stock)) markHarmless(list[0]);
		if (stock) {
			const a = args(list, name, KWARG_NAMES[stock]);
			return a ? `nj.filters.${stock}(${a.join(", ")})` : "undefined";
		}
		if (TS_FILTERS.has(name)) {
			const a = args(list, name);
			if (a && name === "image") imageParams(list[1]);
			return a ? `ts.${name}(${a.join(", ")})` : "undefined";
		}
		if (TS_PENDING.has(name)) return fail(name, `The TakeShape filter "${name}" is not translated yet. Rewrite the expression by hand.`);
		return fail(name, `The filter "${name}" has no translation. Rewrite the expression by hand.`);
	}

	/**
	 * Reports the image filter's parameters that the image endpoint can't honor, or that a variable hides. A value
	 * the template computes (`fit: crop` with `crop` a variable) isn't reported: whatever it holds reaches the
	 * endpoint as it reached imgix, and when nothing defines it, neither got the parameter.
	 */
	function imageParams(params: NjNode | undefined): void {
		if (!params) return;
		const item = (construct: string, message: string) => report.add({ kind: "image-param", file: at.file, line: at.line, construct, message });
		if (params.typename !== "Dict") {
			item("image", `The image filter's parameters are not written out here, so tsg2astro could not read them. The image endpoint ignores any parameter but ${HONORED_IMAGE_PARAMS}.`);
			return;
		}
		for (const pair of children(params)) {
			const key = (pair.key as NjNode).value;
			if (typeof key !== "string") continue;
			const value = pair.value as NjNode;
			const problem = imageParamProblem(key, value.typename === "Literal" ? value.value : undefined);
			if (problem) item(key, `The image filter passes "${key}": the image endpoint ${problem}.`);
		}
	}

	/**
	 * A macro call's arguments in the macro's parameter order, as Nunjucks 3.2.0's makeMacro passes them: positional
	 * arguments first, then the remaining parameters from keyword arguments by name. Positional arguments past the
	 * plain ones fill the parameters with defaults, and keyword arguments the macro does not declare are dropped.
	 * Undefined where nothing was passed, which the macro reads as "use the default".
	 */
	/**
	 * A macro call with its arguments in parameter order. Nunjucks evaluates the arguments in the order written, unused
	 * ones too, so when that order differs and an argument calls anything, the values are taken in that order first.
	 */
	function macroCall(js: string, list: NjNode[], sig: MacroSig): string {
		const written: string[] = [];
		const positional: number[] = [];
		const kw = new Map<string, number>();
		for (const a of list) {
			if (a.typename === "KeywordArgs") {
				for (const pair of children(a)) {
					kw.set(String((pair.key as NjNode).value), written.length);
					written.push(emit(pair.value as NjNode));
				}
			} else {
				positional.push(written.length);
				written.push(emit(a));
			}
		}
		const slots: Array<number | null> = [];
		sig.argNames.forEach((name, i) => slots.push(i < positional.length ? positional[i]! : kw.get(name) ?? null));
		sig.kwargNames.forEach((name, i) => slots.push(positional[sig.argNames.length + i] ?? kw.get(name) ?? null));
		while (slots.length && slots[slots.length - 1] === null) slots.pop();
		const used = slots.filter((s): s is number => s !== null);
		const inOrder = used.every((s, i) => i === 0 || s > used[i - 1]!) && used.length === written.length;
		if (inOrder || !written.some((w) => w.includes("("))) return `${js}(${slots.map((s) => (s === null ? "undefined" : written[s]!)).join(", ")})`;
		const params = written.map((_, i) => `$a${i}`);
		return `((${params.join(", ")}) => ${js}(${slots.map((s) => (s === null ? "undefined" : params[s]!)).join(", ")}))(${written.join(", ")})`;
	}

	/** The macro a call names, with how to call it in JavaScript, or null when it names none. */
	function macroOf(callee: NjNode): { js: string; sig: MacroSig } | null {
		if (callee.typename === "Symbol") {
			const name = callee.value as string;
			const sig = scope.macros?.get(name);
			return sig ? { js: jsName(name), sig } : null;
		}
		if (callee.typename === "LookupVal" && (callee.target as NjNode).typename === "Symbol" && (callee.val as NjNode).typename === "Literal") {
			const ns = scope.namespaces?.get(String((callee.target as NjNode).value));
			const name = String((callee.val as NjNode).value);
			const sig = ns?.get(name);
			// The macro module exports each macro under its JavaScript name (emit-text.mts emitMacroModule)
			return sig && IDENT.test(jsName(name)) ? { js: `${jsName(String((callee.target as NjNode).value))}.${jsName(name)}`, sig } : null;
		}
		return null;
	}

	function call(n: NjNode): string {
		const callee = n.name as NjNode;
		const label = callee.typename === "Symbol" ? (callee.value as string) : callee.typename === "LookupVal" && (callee.val as NjNode).typename === "Literal" ? String((callee.val as NjNode).value) : "call";
		const macro = macroOf(callee);
		if (macro) return macroCall(macro.js, children(n.args as NjNode), macro.sig);
		if (callee.typename === "Symbol" && !scope.locals.has(callee.value as string) && UNSUPPORTED_GLOBALS.has(callee.value as string)) {
			return fail(callee.value as string, `The Nunjucks global "${callee.value}" has no translation.`);
		}
		const a = args(children(n.args as NjNode), label);
		if (!a) return "undefined";
		if (callee.typename === "LookupVal") {
			const target = emit(callee.target as NjNode);
			const val = callee.val as NjNode;
			if (val.typename === "Literal" && typeof val.value === "string" && IDENT.test(val.value)) return `${target}?.${val.value}(${a.join(", ")})`;
			return `${target}?.[${emit(val)}]?.(${a.join(", ")})`;
		}
		return `${emit(callee)}?.(${a.join(", ")})`;
	}

	function expr(n: NjNode): string {
		switch (n.typename) {
			case "Symbol": {
				const name = n.value as string;
				if (scope.locals.has(name)) return jsName(name);
				if (name === "now") return "undefined";
				if (RUNTIME_GLOBALS.has(name)) return `nj.${name}`;
				if (UNSUPPORTED_GLOBALS.has(name)) return fail(name, `The Nunjucks global "${name}" has no translation.`);
				scope.free.add(name);
				scope.onRead?.(n);
				return jsName(name);
			}
			case "Literal": {
				const v = n.value;
				if (typeof v === "string") return JSON.stringify(v);
				if (v === null) return "null";
				return String(v);
			}
			case "Group":
				return `(${children(n).map(emit).join(", ")})`;
			case "Array":
				return `[${children(n).map(emit).join(", ")}]`;
			case "Dict": {
				const parts: string[] = [];
				for (const pair of children(n)) {
					const k = key(pair.key as NjNode);
					if (k === null) return fail("Dict", "Dictionary keys must be names or strings.");
					parts.push(`${k}: ${emit(pair.value as NjNode)}`);
				}
				return parts.length ? `{ ${parts.join(", ")} }` : "{}";
			}
			case "LookupVal": {
				const target = emit(n.target as NjNode);
				const val = n.val as NjNode;
				if (val.typename === "Literal" && typeof val.value === "string" && IDENT.test(val.value)) return `${target}?.${val.value}`;
				return `${target}?.[${emit(val)}]`;
			}
			case "FunCall":
				return call(n);
			case "Filter":
				return filter(n);
			case "Compare": {
				let out = emit(n.expr as NjNode);
				for (const op of n.ops as NjNode[]) out += ` ${op.type as string} ${emit(op.expr as NjNode)}`;
				return out;
			}
			case "And":
				return binary(n, " && ");
			case "Or":
				return binary(n, " || ");
			case "Not":
				return `!${emit(n.target as NjNode)}`;
			case "Add":
				return binary(n, " + ");
			case "Sub":
				return binary(n, " - ");
			case "Mul":
				return binary(n, " * ");
			case "Div":
				return binary(n, " / ");
			case "Mod":
				return binary(n, " % ");
			case "Concat":
				markHarmless(n.left as NjNode);
				markHarmless(n.right as NjNode);
				return binary(n, ' + "" + ');
			case "Pow":
				return `Math.pow(${emit(n.left as NjNode)}, ${emit(n.right as NjNode)})`;
			case "FloorDiv":
				return `nj.floorDiv(${emit(n.left as NjNode)}, ${emit(n.right as NjNode)})`;
			case "Neg":
			case "Pos": {
				const sign = n.typename === "Neg" ? "-" : "+";
				const target = emit(n.target as NjNode);
				return target.startsWith(sign) ? `${sign}(${target})` : `${sign}${target}`;
			}
			case "In":
				return `nj.inOp(${emit(n.left as NjNode)}, ${emit(n.right as NjNode)})`;
			// versions.mts writes this for a loop that only appends to a list: {% set x = x.concat([e]) %}
			case "TsFlatMap": {
				const name = String((n.target as NjNode).value);
				const had = scope.locals.has(name);
				scope.locals.add(name);
				const body = emit(n.body as NjNode);
				if (!had) scope.locals.delete(name);
				return `nj.iterate(${emit(n.arr as NjNode)}).flatMap(({ value: ${jsName(name)} }) => ${body})`;
			}
			// versions.mts writes this for an if in a loop that keeps the last run's value where no branch sets it:
			// each run's value, the previous run's under `prev`, the first run's from `initial`
			case "TsScan": {
				const name = String((n.target as NjNode).value);
				const prev = String(n.prev);
				const initial = emit(n.initial as NjNode);
				const had = [name, prev].filter((x) => scope.locals.has(x));
				scope.locals.add(name);
				scope.locals.add(prev);
				const body = emit(n.body as NjNode);
				for (const x of [name, prev]) if (!had.includes(x)) scope.locals.delete(x);
				const arr = emit(n.arr as NjNode);
				// The accumulator's name collides with nothing the loop names or reads
				const mentions = (id: string) => new RegExp(`(?<![\\w$])${id.replace(/\$/g, "\\$")}(?![\\w$])`).test(`${body} ${initial} ${arr}`);
				let runs = "runs";
				while (runs === jsName(name) || runs === jsName(prev) || mentions(runs)) runs += "$";
				return `nj.iterate(${arr}).reduce((${runs}: any[], { value: ${jsName(name)} }) => (${runs}.push(((${jsName(prev)}: any) => ${body})(${runs}.length ? ${runs}[${runs}.length - 1] : ${initial})), ${runs}), [])`;
			}
			case "InlineIf": {
				const otherwise = n.else_ ? emit(n.else_ as NjNode) : '""';
				return `(${emit(n.cond as NjNode)} ? ${emit(n.body as NjNode)} : ${otherwise})`;
			}
			case "Is": {
				const right = n.right as NjNode;
				const name = String(right.name ? (right.name as NjNode).value : right.value);
				return fail(`is ${name}`, `The test "is ${name}" has no translation. Rewrite the condition by hand.`);
			}
			default:
				return fail(n.typename, `Nunjucks expression type ${n.typename} has no translation.`);
		}
	}

	return expr(node);
}
