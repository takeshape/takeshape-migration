/**
 * Sets of one name that run one after another in one frame: a page that sets one name before each of three
 * includes, or one that sets a name in two if chains. Each set after the first gets a name of its own,
 * `<name>__<n>`, every read the name of the set that ran last before it, and each include the names as they
 * stand where it sits (an Include node's `contextAliases`, which the analysis and the emitters read). The analysis
 * then sees each name set once and places it as usual. In a child template the layout calls the blocks after the
 * top level ran, so they read the last set. A branch of an if chain that sets nothing gets
 * `{% set <name>__<n> = <the name before> %}`, since Nunjucks kept the old value there.
 *
 * A name qualifies when its sets all sit in one frame (the top level or one block), each directly in it or in if
 * chains there, at most one per branch, none in a loop, a macro or another tag's body, none with a body or several
 * names, and no loop binds it. In a child template, a name set at the top level that a layout might read (any
 * mention in the layouts and their includes) keeps its sets as they are, and the analysis reports them.
 */
import { emitExpression } from "./expressions.mts";
import { Report } from "./report.mts";
import type { NjNode, Template } from "./templates.mts";

const kids = (n: NjNode | null | undefined): NjNode[] => ((n?.children as NjNode[] | undefined) ?? []);
type Frame = NjNode | null; // a Block, or null for the top level

/** Renames the reads in an expression, as emitExpression finds them, to the names in `names`. */
function renameReads(expr: unknown, names: ReadonlyMap<string, string>): void {
	if (!expr || typeof expr !== "object") return;
	const onRead = (s: NjNode): void => {
		const to = names.get(String(s.value));
		if (to !== undefined) s.value = to;
	};
	emitExpression(expr as NjNode, { locals: new Set(), free: new Set(), onRead }, new Report(), { file: "", line: 0 });
}

/** Each branch of an if chain: its condition (null for the else) and its nodes. */
function branchesOf(n: NjNode): Array<{ cond: NjNode | null; list: NjNode[] }> {
	const out: Array<{ cond: NjNode | null; list: NjNode[] }> = [];
	for (let c: NjNode | null = n; c; ) {
		out.push({ cond: c.cond as NjNode, list: kids(c.body as NjNode) });
		const other = c.else_ as NjNode | null;
		if (other?.typename === "If") c = other;
		else {
			if (other) out.push({ cond: null, list: kids(other) });
			c = null;
		}
	}
	return out;
}

/** The last If of a chain, whose else_ is the chain's else. */
function lastOf(n: NjNode): NjNode {
	let c = n;
	while ((c.else_ as NjNode | null)?.typename === "If") c = c.else_ as NjNode;
	return c;
}

/** Every name a Symbol anywhere in the template mentions. */
function mentioned(root: unknown, out: Set<string>): void {
	if (!root || typeof root !== "object") return;
	if (Array.isArray(root)) return root.forEach((v) => mentioned(v, out));
	const n = root as NjNode;
	if (n.typename === "Symbol" && typeof n.value === "string") out.add(n.value);
	for (const v of Object.values(n)) if (v && typeof v === "object") mentioned(v, out);
}

/** Names a child template's layouts, and the templates they include, might read. */
function layoutNames(t: Template, templates: Map<string, Template>): Set<string> {
	const out = new Set<string>();
	const seen = new Set<string>();
	const queue = t.extends ? [t.extends] : [];
	while (queue.length) {
		const name = queue.shift()!;
		if (seen.has(name)) continue;
		seen.add(name);
		const l = templates.get(name);
		if (!l?.ast) continue;
		mentioned(l.ast, out);
		queue.push(...l.includes, ...(l.extends ? [l.extends] : []));
	}
	return out;
}

/** The names that qualify, each with the frame its sets sit in. */
function qualifying(ast: NjNode, child: boolean, layoutReads: Set<string>): Map<string, Frame> {
	const bad = new Set<string>();
	const frameOf = new Map<string, Frame>();
	const units = new Map<string, Set<NjNode>>();
	const record = (name: string, frame: Frame, unit: NjNode, nested: boolean): void => {
		if (nested) bad.add(name);
		if (frameOf.has(name) && frameOf.get(name) !== frame) bad.add(name);
		frameOf.set(name, frame);
		(units.get(name) ?? units.set(name, new Set()).get(name)!).add(unit);
	};
	/** Counts each name's units in a list; in a branch (`head` set), a second one disqualifies it. */
	const visit = (list: NjNode[], frame: Frame, head: NjNode | null, nested: boolean): Set<string> => {
		const counts = new Map<string, number>();
		const bump = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
		for (const n of list) {
			switch (n.typename) {
				case "Set": {
					const targets = n.targets as NjNode[];
					if (n.body || targets.length !== 1) {
						for (const target of targets) bad.add(String(target.value));
						break;
					}
					const name = String(targets[0]!.value);
					bump(name);
					record(name, frame, head ?? n, nested);
					break;
				}
				case "If": {
					const names = new Set<string>();
					for (const b of branchesOf(n)) for (const name of visit(b.list, frame, head ?? n, nested)) names.add(name);
					for (const name of names) bump(name);
					break;
				}
				case "For": {
					const target = n.name as NjNode;
					for (const v of target.typename === "Array" ? kids(target) : [target]) bad.add(String(v.value));
					visit(kids(n.body as NjNode), frame, head ?? n, true);
					if (n.else_) visit(kids(n.else_ as NjNode), frame, head ?? n, true);
					break;
				}
				case "Block":
					visit(kids(n.body as NjNode), n, null, nested);
					break;
				case "Macro":
				case "Caller":
				case "FromImport":
				case "Import":
					break;
				default:
					for (const v of Object.values(n)) {
						if (v && typeof v === "object" && (v as NjNode).typename === "NodeList") visit(kids(v as NjNode), frame, head ?? n, true);
					}
			}
		}
		if (head) for (const [name, count] of counts) if (count > 1) bad.add(name);
		return new Set(counts.keys());
	};
	visit(kids(ast), null, null, false);
	const out = new Map<string, Frame>();
	for (const [name, set] of units) {
		const frame = frameOf.get(name) ?? null;
		if (bad.has(name) || set.size < 2) continue;
		if (child && frame === null && layoutReads.has(name)) continue;
		out.set(name, frame);
	}
	return out;
}

const isBlank = (n: NjNode): boolean => n.typename === "Output" && kids(n).every((c) => c.typename === "TemplateData" && !String(c.value ?? "").trim());
/** The name a plain set (one name, a value) sets, or null. */
const plainSetName = (n: NjNode | undefined): string | null =>
	n?.typename === "Set" && !n.body && (n.targets as NjNode[]).length === 1 ? String((n.targets as NjNode[])[0]!.value) : null;
const sym = (at: NjNode, value: string): NjNode => ({ typename: "Symbol", lineno: at.lineno, colno: at.colno, value });
const lit = (at: NjNode, value: unknown): NjNode => ({ typename: "Literal", lineno: at.lineno, colno: at.colno, value });

/** Whether a set of `name` sits anywhere in `root`, `skip` aside. */
function setsAnywhere(root: unknown, name: string, skip: NjNode): boolean {
	if (!root || typeof root !== "object") return false;
	if (Array.isArray(root)) return root.some((v) => setsAnywhere(v, name, skip));
	const n = root as NjNode;
	if (n !== skip && n.typename === "Set" && (n.targets as NjNode[]).some((target) => target.value === name)) return true;
	return Object.values(n).some((v) => v && typeof v === "object" && setsAnywhere(v, name, skip));
}

/** Renames the reads of names in a list of nodes, as `rewrite` in versionSets does, with nothing set again. */
function renameIn(list: NjNode[], names: ReadonlyMap<string, string>): void {
	for (const n of list) {
		switch (n.typename) {
			case "Set":
				renameReads(n.value, names);
				break;
			case "If":
				for (const b of branchesOf(n)) {
					renameReads(b.cond, names);
					renameIn(b.list, names);
				}
				break;
			case "For": {
				renameReads(n.arr, names);
				// A loop variable of the same name hides the outer one
				const target = n.name as NjNode;
				const bound = new Set((target.typename === "Array" ? kids(target) : [target]).map((v) => String(v.value)));
				const inner = new Map([...names].filter(([from]) => !bound.has(from)));
				renameIn(kids(n.body as NjNode), inner);
				if (n.else_) renameIn(kids(n.else_ as NjNode), names);
				break;
			}
			case "Output":
				for (const c of kids(n)) if (c.typename !== "TemplateData") renameReads(c, names);
				break;
			case "Include": {
				const aliases = Object.fromEntries([...names].filter(([from, to]) => from !== to));
				if (Object.keys(aliases).length) n.contextAliases = { ...(n.contextAliases as Record<string, string> | undefined), ...aliases };
				break;
			}
			case "Macro":
			case "Caller":
				break;
			default:
				for (const v of Object.values(n)) if (v && typeof v === "object" && (v as NjNode).typename === "NodeList") renameIn(kids(v as NjNode), names);
		}
	}
}

/**
 * Nunjucks has no list comprehension or counter, so templates build both with a set inside a loop, which writes the
 * variable outside it. Two shapes are rewritten into plain sets before the versions:
 *   - a counter: `{% set c = 1 %}` before the loop and `{% set c = c + d %}` as the loop body's last tag, read only
 *     inside the loop. Each run reads `c + loop.index0 * d`, under a name of its own.
 *   - a list: `{% set x = [...] %}` (a list literal) right before a loop whose body only does `{% set x = x.concat(e) %}`. That is
 *     `x = [...].concat(<e for each item>)`, written as a TsFlatMap node, which expressions.mts emits as a flatMap
 *     (a navigation partial can build its links this way).
 *   - a value an if in the loop body sets in some branches only, set nowhere else: where no branch runs, the loop's
 *     frame keeps the last run's value. Each run's value is computed before the loop (a TsScan node over the items),
 *     and the run reads its own (pages can pick each banner's background this way).
 */
/**
 * `outer`: names set earlier in the lists around this one; `loops`: the loops around it, outermost first.
 */
function loopIdioms(list: NjNode[], seq: Names, root: NjNode, templates: Map<string, Template>, outer = new Set<string>(), loops: NjNode[] = []): void {
	list.forEach((n, i) => {
		const here = new Set([...outer, ...list.slice(0, i).flatMap((x) => plainSetName(x) ?? [])]);
		if (n.typename === "If") for (const b of branchesOf(n)) loopIdioms(b.list, seq, root, templates, here, loops);
		else if (n.typename === "For") {
			loopIdioms(kids(n.body as NjNode), seq, root, templates, here, [...loops, n]);
			if (n.else_) loopIdioms(kids(n.else_ as NjNode), seq, root, templates, here, loops);
		} else if (n.typename === "Block" || n.typename === "Macro") loopIdioms(kids(n.body as NjNode), seq, root, templates);
		else for (const v of Object.values(n)) if (v && typeof v === "object" && (v as NjNode).typename === "NodeList") loopIdioms(kids(v as NjNode), seq, root, templates, here, loops);
	});
	for (let i = 0; i < list.length; i++) {
		const loop = list[i]!;
		if (loop.typename !== "For") continue;
		const body = kids(loop.body as NjNode);
		const live = body.filter((x) => !isBlank(x));
		const target = loop.name as NjNode;
		const loopVars = new Set((target.typename === "Array" ? kids(target) : [target]).map((v) => String(v.value)));
		// The set of a name right before the loop, past blank text
		let p = i - 1;
		while (p >= 0 && isBlank(list[p]!)) p--;
		const before = (name: string) => outer.has(name) || list.slice(0, i).some((x) => plainSetName(x) === name);

		// A counter
		const last = live[live.length - 1];
		const c = plainSetName(last);
		const step = last?.value as NjNode | undefined;
		if (
			c &&
			!loopVars.has(c) &&
			step?.typename === "Add" &&
			(step.left as NjNode).typename === "Symbol" &&
			(step.left as NjNode).value === c &&
			(step.right as NjNode).typename === "Literal" &&
			typeof (step.right as NjNode).value === "number" &&
			!setsAnywhere(loop, c, last!)
		) {
			// It starts at a number set right here (a string would concatenate: "1" + 1 is "11"), so each outer run
			// starts it again, and nothing after the loop reads the last count, through an include either
			const init = list.slice(0, i).reverse().find((x) => plainSetName(x) === c)?.value as NjNode | undefined;
			const numeric = init?.typename === "Literal" && typeof init.value === "number";
			if (numeric && !readAfter(root, loop, c, templates)) {
				const name = seq.fresh(`${c}__run${++seq.n}`);
				body.splice(body.indexOf(last!), 1);
				renameIn(body, new Map([[c, name]]));
				const at = loop;
				const index0: NjNode = { typename: "LookupVal", lineno: at.lineno, colno: at.colno, target: sym(at, "loop"), val: lit(at, "index0") };
				const value: NjNode = { typename: "Add", lineno: at.lineno, colno: at.colno, left: sym(at, c), right: { typename: "Mul", lineno: at.lineno, colno: at.colno, left: index0, right: step.right } };
				body.unshift({ typename: "Set", lineno: at.lineno, colno: at.colno, targets: [sym(at, name)], value, body: null });
				continue;
			}
		}

		// A list built with concat
		const only = live.length === 1 ? live[0] : undefined;
		const x = plainSetName(only);
		const call = only?.value as NjNode | undefined;
		const callee = call?.name as NjNode | undefined;
		const args = call?.typename === "FunCall" ? kids(call.args as NjNode) : [];
		const element = args[0];
		if (
			x &&
			!loop.else_ &&
			target.typename === "Symbol" &&
			!loopVars.has(x) &&
			callee?.typename === "LookupVal" &&
			(callee.target as NjNode).typename === "Symbol" &&
			(callee.target as NjNode).value === x &&
			(callee.val as NjNode).typename === "Literal" &&
			(callee.val as NjNode).value === "concat" &&
			args.length === 1 &&
			element &&
			element.typename !== "KeywordArgs" &&
			p >= 0 &&
			plainSetName(list[p]) === x &&
			// A list literal: concat on a string joins text, which the flatMap would turn into a list
			(list[p]!.value as NjNode | undefined)?.typename === "Array"
		) {
			const reads = new Set<string>();
			mentioned(element, reads);
			if (reads.has(x) || reads.has("loop")) continue;
			const init = list[p]!;
			const at = loop;
			const each: NjNode = { typename: "TsFlatMap", lineno: at.lineno, colno: at.colno, arr: loop.arr, target, body: element };
			init.value = {
				typename: "FunCall",
				lineno: at.lineno,
				colno: at.colno,
				name: { typename: "LookupVal", lineno: at.lineno, colno: at.colno, target: init.value, val: lit(at, "concat") },
				args: { typename: "NodeList", lineno: at.lineno, colno: at.colno, children: [each] },
			};
			list.splice(i, 1);
			i--;
			continue;
		}

		// A name set before the loop and again inside it, read in the loop only after that set and never after the loop:
		// the loop's set writes the outer name (Nunjucks resolves up), and nothing sees the difference if it gets its own
		for (const name of setNamesOutsideLoops(body)) {
			if (!before(name) || loopVars.has(name)) continue;
			const found = findSets(body, name);
			if (found.length !== 1 || found[0]!.nested) continue;
			const { list: within, index } = found[0]!;
			const set = within[index]!;
			const rest = within.slice(index + 1);
			const readsAfterSet = countReads(rest, name);
			// Inside other loops, a later run of the outermost one would read the name before this loop sets it again
			const scope = loops[0] ?? loop;
			if (findSets(kids(scope.body as NjNode), name).length !== 1) continue;
			if (countReads(set.value, name) || countReads(kids(scope.body as NjNode), name) !== readsAfterSet) continue;
			const outsideRest = (n: NjNode) => !rest.some((r) => contains(r, n));
			if (includesReading(scope, name, templates, outsideRest) || readAfter(root, scope, name, templates)) continue;
			const own = seq.fresh(`${name}__in${++seq.n}`);
			(set.targets as NjNode[])[0]!.value = own;
			renameIn(rest, new Map([[name, own]]));
		}

		// A value an if sets in some branches only
		if (target.typename !== "Symbol") continue;
		const setInBody = new Set<string>();
		for (const x of body) mentionedSets(x, setInBody);
		for (const chain of [...body]) {
			if (chain.typename !== "If") continue;
			const branches = branchesOf(chain);
			const names = new Set(branches.flatMap((b) => b.list.map(plainSetName).filter((x): x is string => x !== null)));
			for (const name of names) {
				const valueOf = (b: { list: NjNode[] }) => b.list.filter((x) => plainSetName(x) === name);
				const keeps = branches.some((b) => !valueOf(b).length) || branches[branches.length - 1]!.cond !== null;
				if (!keeps || loopVars.has(name) || branches.some((b) => valueOf(b).length > 1)) continue;
				// Set nowhere but here, and computed from the item and names from outside the loop only
				const own = new Set(branches.flatMap(valueOf));
				if (setsAnywhereBut(root, name, own)) continue;
				const reads = new Set<string>();
				for (const b of branches) {
					mentioned(b.cond, reads);
					for (const x of valueOf(b)) mentioned(x.value, reads);
				}
				if (reads.has("loop") || reads.has(name) || [...reads].some((r) => r !== target.value && setInBody.has(r))) continue;
				// Every run's value is worked out before the loop body runs, so it must not call anything (a joiner
				// would count its calls in another order)
				if (branches.some((b) => callsAnything(b.cond) || valueOf(b).some((x) => callsAnything(x.value)))) continue;
				const at = chain;
				const prev = seq.fresh(`${name}__last`);
				let step: NjNode = sym(at, prev);
				for (const b of [...branches].reverse()) {
					const value = valueOf(b)[0]?.value as NjNode | undefined;
					const v = value ? clone(value) : sym(at, prev);
					step = b.cond ? { typename: "InlineIf", lineno: at.lineno, colno: at.colno, cond: clone(b.cond), body: v, else_: step } : v;
				}
				const runs = seq.fresh(`${name}__runs${++seq.n}`);
				list.splice(i, 0, {
					typename: "Set",
					lineno: at.lineno,
					colno: at.colno,
					targets: [sym(at, runs)],
					value: { typename: "TsScan", lineno: at.lineno, colno: at.colno, arr: clone(loop.arr as NjNode), target: clone(target), prev, initial: sym(at, name), body: step },
					body: null,
				});
				i++;
				for (const b of branches) for (const x of valueOf(b)) b.list.splice(b.list.indexOf(x), 1);
				const index0: NjNode = { typename: "LookupVal", lineno: at.lineno, colno: at.colno, target: sym(at, "loop"), val: lit(at, "index0") };
				const read: NjNode = { typename: "Set", lineno: at.lineno, colno: at.colno, targets: [sym(at, name)], value: { typename: "LookupVal", lineno: at.lineno, colno: at.colno, target: sym(at, runs), val: index0 }, body: null };
				body.splice(body.indexOf(chain), 0, read);
			}
			// An if left with nothing to do goes
			if (branchesOf(chain).every((b) => b.list.every(isBlank))) body.splice(body.indexOf(chain), 1);
		}
	}
}

/** The names a plain set sets in a list, through if branches but not inside loops. */
function setNamesOutsideLoops(list: NjNode[]): Set<string> {
	const out = new Set<string>();
	for (const n of list) {
		const name = plainSetName(n);
		if (name) out.add(name);
		else if (n.typename === "If") for (const b of branchesOf(n)) for (const x of setNamesOutsideLoops(b.list)) out.add(x);
	}
	return out;
}

/** Every set of `name` under a list: the list that holds it, its index, and whether it sits in a nested loop. */
function findSets(list: NjNode[], name: string, nested = false): Array<{ list: NjNode[]; index: number; nested: boolean }> {
	const out: Array<{ list: NjNode[]; index: number; nested: boolean }> = [];
	list.forEach((n, index) => {
		if (n.typename === "Set" && (n.targets as NjNode[]).some((t) => t.value === name)) out.push({ list, index, nested: nested || plainSetName(n) !== name });
		if (n.typename === "If") for (const b of branchesOf(n)) out.push(...findSets(b.list, name, nested));
		else if (n.typename === "For") {
			out.push(...findSets(kids(n.body as NjNode), name, true));
			if (n.else_) out.push(...findSets(kids(n.else_ as NjNode), name, true));
		} else if (n.typename !== "Macro") for (const v of Object.values(n)) if (v && typeof v === "object" && (v as NjNode).typename === "NodeList") out.push(...findSets(kids(v as NjNode), name, true));
	});
	return out;
}

/** How many Symbols name `name` under `root`, set targets and loop variables aside. */
function countReads(root: unknown, name: string): number {
	if (!root || typeof root !== "object") return 0;
	if (Array.isArray(root)) return root.reduce((sum: number, v) => sum + countReads(v, name), 0);
	const n = root as NjNode;
	if (n.typename === "Symbol") return n.value === name ? 1 : 0;
	let sum = 0;
	for (const [k, v] of Object.entries(n)) {
		if ((n.typename === "Set" && k === "targets") || (n.typename === "For" && k === "name")) continue;
		if (v && typeof v === "object") sum += countReads(v, name);
	}
	return sum;
}

/** Whether `inner` is `root` or sits under it. */
function contains(root: unknown, inner: NjNode): boolean {
	if (root === inner) return true;
	if (!root || typeof root !== "object") return false;
	return Object.values(root as NjNode).some((v) => v && typeof v === "object" && (Array.isArray(v) ? v.some((x) => contains(x, inner)) : contains(v, inner)));
}

/** Whether a template, or one it includes, mentions `name`. */
function templateMentions(name: string, templateName: string, templates: Map<string, Template>, seen = new Set<string>()): boolean {
	if (seen.has(templateName)) return false;
	seen.add(templateName);
	const t = templates.get(templateName);
	if (!t?.ast) return false;
	const names = new Set<string>();
	mentioned(t.ast, names);
	return names.has(name) || t.includes.some((i) => templateMentions(name, i, templates, seen));
}

/** Whether an include under `root` that `where` accepts reaches a template mentioning `name`. */
function includesReading(root: unknown, name: string, templates: Map<string, Template>, where: (n: NjNode) => boolean): boolean {
	if (!root || typeof root !== "object") return false;
	if (Array.isArray(root)) return root.some((v) => includesReading(v, name, templates, where));
	const n = root as NjNode;
	if (n.typename === "Include" && where(n) && templateMentions(name, String((n.template as NjNode).value), templates)) return true;
	return Object.values(n).some((v) => v && typeof v === "object" && includesReading(v, name, templates, where));
}

const before_ = (a: NjNode, b: { lineno: number; colno: number }) => a.lineno > b.lineno || (a.lineno === b.lineno && a.colno > b.colno);

/** Whether anything after `loop` in the template reads `name`, directly or through an include. */
function readAfter(root: NjNode, loop: NjNode, name: string, templates: Map<string, Template>): boolean {
	let end = { lineno: loop.lineno, colno: loop.colno };
	const last = (v: unknown): void => {
		if (!v || typeof v !== "object") return;
		if (Array.isArray(v)) return v.forEach(last);
		const n = v as NjNode;
		if (typeof n.lineno === "number" && before_(n, end)) end = { lineno: n.lineno, colno: n.colno };
		for (const x of Object.values(n)) if (x && typeof x === "object") last(x);
	};
	last(loop);
	let found = false;
	const visit = (v: unknown): void => {
		if (found || !v || typeof v !== "object") return;
		if (Array.isArray(v)) return v.forEach(visit);
		const n = v as NjNode;
		if (n === loop) return;
		if (typeof n.lineno === "number" && before_(n, end)) {
			if (n.typename === "Symbol" && n.value === name) found = true;
			// An include that already reads a name of its own for it (an earlier rewrite) doesn't read this one
			const aliased = (n.contextAliases as Record<string, string> | undefined)?.[name] !== undefined;
			if (n.typename === "Include" && !aliased && templateMentions(name, String((n.template as NjNode).value), templates)) found = true;
		}
		for (const [k, x] of Object.entries(n)) {
			// What a set sets, and a loop's variables, are no reads
			if ((n.typename === "Set" && k === "targets") || (n.typename === "For" && k === "name")) continue;
			if (x && typeof x === "object") visit(x);
		}
	};
	visit(root);
	return found;
}

/** Whether an expression calls a function or macro anywhere. */
function callsAnything(root: unknown): boolean {
	if (!root || typeof root !== "object") return false;
	if (Array.isArray(root)) return root.some(callsAnything);
	const n = root as NjNode;
	if (n.typename === "FunCall") return true;
	return Object.values(n).some((v) => v && typeof v === "object" && callsAnything(v));
}

/** The names any set in `root` sets. */
function mentionedSets(root: unknown, out: Set<string>): void {
	if (!root || typeof root !== "object") return;
	if (Array.isArray(root)) return root.forEach((v) => mentionedSets(v, out));
	const n = root as NjNode;
	if (n.typename === "Set") for (const target of n.targets as NjNode[]) out.add(String(target.value));
	for (const v of Object.values(n)) if (v && typeof v === "object") mentionedSets(v, out);
}

/** Whether a set of `name` sits anywhere in `root` other than the sets in `skip`. */
function setsAnywhereBut(root: unknown, name: string, skip: ReadonlySet<NjNode>): boolean {
	if (!root || typeof root !== "object") return false;
	if (Array.isArray(root)) return root.some((v) => setsAnywhereBut(v, name, skip));
	const n = root as NjNode;
	if (!skip.has(n) && n.typename === "Set" && (n.targets as NjNode[]).some((target) => target.value === name)) return true;
	return Object.values(n).some((v) => v && typeof v === "object" && setsAnywhereBut(v, name, skip));
}

/** A copy of a parse tree node; Nunjucks keeps `typename` on the prototype, so it is copied by hand. */
function clone<T>(v: T): T {
	if (!v || typeof v !== "object") return v;
	if (Array.isArray(v)) return v.map(clone) as T;
	const n = v as unknown as NjNode;
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(n)) out[k] = clone(x);
	if (typeof n.typename === "string") out.typename = n.typename;
	return out as T;
}

/** The names the translator makes: numbered per template, each clear of every name a template mentions. */
type Names = { n: number; fresh: (base: string) => string };

/**
 * Every name a template mentions. A name the translator makes must be none of them: with `x__2` in the context,
 * `{% set x = 1 %}{% set x = 2 %}{{ x__2 }}` printed the second set where Nunjucks printed 99.
 */
export function namesInUse(templates: Map<string, Template>): Set<string> {
	const out = new Set<string>();
	for (const t of templates.values()) if (t.ast) mentioned(t.ast, out);
	return out;
}

/**
 * Gives the repeated sets of qualifying names names of their own in `t`'s tree, and its reads and includes with them.
 * `taken` holds the names in use (namesInUse), and gets each name made here.
 */
export function versionSets(t: Template, templates: Map<string, Template>, taken: Set<string> = namesInUse(templates)): void {
	if (!t.ast) return;
	const fresh = (base: string): string => {
		let name = base;
		while (taken.has(name)) name += "_";
		taken.add(name);
		return name;
	};
	loopIdioms(kids(t.ast), { n: 0, fresh }, t.ast, templates);
	const child = t.extends !== null;
	const names = qualifying(t.ast, child, child ? layoutNames(t, templates) : new Set());
	if (!names.size) return;
	const counter = new Map<string, number>();
	const next = (name: string): string => {
		const n = (counter.get(name) ?? 0) + 1;
		counter.set(name, n);
		return n === 1 ? name : fresh(`${name}__${n}`);
	};
	const deferred: Array<{ block: NjNode }> = [];
	const synthSet = (at: NjNode, name: string, from: string): NjNode => {
		const sym = (value: string): NjNode => ({ typename: "Symbol", lineno: at.lineno, colno: at.colno, value });
		return { typename: "Set", lineno: at.lineno, colno: at.colno, targets: [sym(name)], value: sym(from), body: null };
	};
	const setsName = (list: NjNode[], name: string): boolean =>
		list.some((n) => (n.typename === "Set" && String((n.targets as NjNode[])[0]?.value) === name) || (n.typename === "If" && branchesOf(n).some((b) => setsName(b.list, name))));
	/** Makes every path through `list` set `name`, from `from` where the template set nothing. */
	const ensure = (list: NjNode[], at: NjNode, name: string, from: string): void => {
		if (list.some((n) => n.typename === "Set" && String((n.targets as NjNode[])[0]?.value) === name)) return;
		const chain = list.find((n) => n.typename === "If" && setsName(branchesOf(n).flatMap((b) => b.list), name));
		if (!chain) {
			list.push(synthSet(at, name, from));
			return;
		}
		for (const b of branchesOf(chain)) ensure(b.list, at, name, from);
		const last = lastOf(chain);
		if (!last.else_) last.else_ = { typename: "NodeList", lineno: at.lineno, colno: at.colno, children: [synthSet(at, name, from)] };
	};
	const aliasesOf = (cur: Map<string, string>): Record<string, string> | null => {
		const out = Object.fromEntries([...cur].filter(([from, to]) => from !== to));
		return Object.keys(out).length ? out : null;
	};
	/**
	 * Renames through `cur` down a list, in run order. `own` maps the names set here to the name a set of them takes:
	 * null for a frame list, where each set takes the next version, or the chain's new names in a branch.
	 */
	const rewrite = (list: NjNode[], cur: Map<string, string>, frame: Frame, own: Map<string, string> | null): void => {
		for (const n of list) {
			switch (n.typename) {
				case "Set": {
					renameReads(n.value, cur);
					const target = (n.targets as NjNode[])[0];
					const name = String(target?.value);
					if (!target || n.body || names.get(name) !== frame || !names.has(name)) break;
					const to = own ? own.get(name) : next(name);
					if (to === undefined) break;
					target.value = to;
					cur.set(name, to);
					break;
				}
				case "If": {
					const before = new Map(cur);
					const after = new Map<string, string>();
					const branches = branchesOf(n);
					for (const [name, f] of names) {
						if (f !== frame || !branches.some((b) => setsName(b.list, name))) continue;
						after.set(name, own?.get(name) ?? next(name));
					}
					for (const b of branches) {
						renameReads(b.cond, before);
						rewrite(b.list, new Map(before), frame, after);
					}
					// Where no branch runs a set, the name keeps its value from before the chain
					for (const [name, to] of after) {
						if (to === name || own) continue;
						ensure([n], n, to, before.get(name) ?? name);
					}
					for (const [name, to] of after) cur.set(name, to);
					break;
				}
				case "For":
					renameReads(n.arr, cur);
					rewrite(kids(n.body as NjNode), new Map(cur), frame, new Map());
					if (n.else_) rewrite(kids(n.else_ as NjNode), new Map(cur), frame, new Map());
					break;
				case "Output":
					for (const c of kids(n)) if (c.typename !== "TemplateData") renameReads(c, cur);
					break;
				case "Include": {
					const aliases = aliasesOf(cur);
					if (aliases) n.contextAliases = aliases;
					break;
				}
				case "Block":
					// A child template's blocks run when the layout calls them, after its top level
					if (child && frame === null) deferred.push({ block: n });
					else rewrite(kids(n.body as NjNode), new Map(cur), n, null);
					break;
				case "Macro":
				case "Caller":
				case "FromImport":
				case "Import":
					break;
				default:
					for (const v of Object.values(n)) {
						if (v && typeof v === "object" && (v as NjNode).typename === "NodeList") rewrite(kids(v as NjNode), new Map(cur), frame, new Map());
					}
			}
		}
	};
	const top = new Map<string, string>();
	rewrite(kids(t.ast), top, null, null);
	for (const { block } of deferred) rewrite(kids(block.body as NjNode), new Map(top), block, null);
}
