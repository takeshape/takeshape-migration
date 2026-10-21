/**
 * Turns a non-HTML Nunjucks template (an XML sitemap, an RSS feed, a JSON or plain text file) into a TypeScript
 * module whose `render(ctx)` builds the same text by concatenation. A route's endpoint calls it.
 *
 * Expressions follow the same rules as the Astro components (emitExpression), and autoescape carries over: every
 * `{{ }}` goes through `nj.escape` unless its last filter is `safe`. Sets are placed by the same scope analysis as
 * the Astro emitter, so both kinds of template agree on what each name means.
 */
import type { EmittedFile } from "./emit-astro.mts";
import { emitExpression, jsName, loopParams, splitOutput } from "./expressions.mts";
import type { Scope } from "./expressions.mts";
import type { Report } from "./report.mts";
import { analyze, astOf, calledNames, importPath, isRawFile, kids, lineOf, macroBindings, macroModulePath, macroSignatures, outPath, pascal, reportUnplacedSets, RUNTIME_DIR, setValue, SKIP_NAMES, symbols, tl } from "./scope.mts";
import type { SetPlan } from "./scope.mts";
import type { NjNode, Template } from "./templates.mts";

class TextEmitter {
	readonly t: Template;
	readonly templates: Map<string, Template>;
	readonly report: Report;
	readonly an: ReturnType<typeof analyze>;
	readonly scope: Scope = { locals: new Set(), free: new Set() };
	readonly file: string;
	readonly names: Set<string>;
	readonly out: string;
	readonly ctx: string;
	readonly imports = new Map<string, { id: string; line: string }>();
	readonly lines: string[] = [];
	literal: string[] = [];
	/** If chains already inside the block that declares their groups. */
	readonly wrapped = new Set<NjNode>();
	depth = 1;
	usedNj = false;
	usedTs = false;

	/** `file`: where the module goes, when that is not the template's own output (a macro module). */
	constructor(t: Template, templates: Map<string, Template>, report: Report, file = outPath(t)) {
		this.t = t;
		this.templates = templates;
		this.report = report;
		this.an = analyze(t, templates);
		this.file = file;
		this.names = symbols(astOf(t));
		this.out = this.names.has("out") ? "out$" : "out";
		this.ctx = this.names.has("ctx") ? "ctx$" : "ctx";
	}

	notTranslated(line: number | undefined, construct: string, message: string): void {
		this.report.add({ kind: "not-translated", file: this.t.name, line, construct, message });
	}

	expr(node: NjNode): string {
		const js = emitExpression(node, this.scope, this.report, { file: this.t.name, line: lineOf(node) });
		if (/\bnj\./.test(js)) this.usedNj = true;
		if (/\bts\./.test(js)) this.usedTs = true;
		return js;
	}

	nj(fn: string): string {
		this.usedNj = true;
		return `nj.${fn}`;
	}

	flush(): void {
		if (!this.literal.length) return;
		const text = this.literal.join("");
		this.literal = [];
		this.lines.push(`${"\t".repeat(this.depth)}${this.out} += \`${text}\`;`);
	}

	line(s: string): void {
		this.flush();
		this.lines.push(`${"\t".repeat(this.depth)}${s}`);
	}

	block(open: string, fn: () => void, close = "}"): void {
		this.line(open);
		this.depth++;
		fn();
		this.flush();
		this.depth--;
		this.line(close);
	}

	withLocals(names: string[], fn: () => void): void {
		const saved = new Set(this.scope.locals);
		for (const n of names) this.scope.locals.add(n);
		try {
			fn();
		} finally {
			this.scope.locals = saved;
		}
	}

	/** `const x = ...;` for a set, or for a group of sets in one if chain. The group's old value comes from the context. */
	decl(s: SetPlan): void {
		const old = /^[A-Za-z_$][\w$]*$/.test(s.name) ? `${this.ctx}.${s.name}` : `${this.ctx}[${JSON.stringify(s.name)}]`;
		this.line(`const ${jsName(s.name)} = ${setValue(s, (n) => this.expr(n), old)};`);
		this.scope.locals.add(s.name);
	}

	nodes(list: NjNode[]): void {
		for (let i = 0; i < list.length; i++) {
			const n = list[i]!;
			if (n.typename === "If" && !this.wrapped.has(n)) {
				// Groups of sets in this chain are declared before it; those that need it, in a block of their own
				const groups = this.an.chains.get(n) ?? [];
				for (const s of groups) if (s.placement === "top" || s.placement === "loop") this.decl(s);
				const iife = groups.filter((s) => s.placement === "iife");
				if (iife.length) {
					this.wrapped.add(n);
					this.block("{", () =>
						this.withLocals([], () => {
							for (const s of iife) this.decl(s);
							this.nodes(list.slice(i));
						}),
					);
					return;
				}
			}
			const plan = n.typename === "Set" ? this.an.sets.get(n) : undefined;
			if (plan?.placement === "iife" && !plan.group) {
				// a block of its own, so reads before the set still see the old value
				this.block("{", () => {
					this.line(`const ${jsName(plan.name)} = ${this.expr(n.value as NjNode)};`);
					this.withLocals([plan.name], () => this.nodes(list.slice(i + 1)));
				});
				return;
			}
			this.node(n);
		}
	}

	node(n: NjNode): void {
		switch (n.typename) {
			case "Output":
				for (const c of kids(n)) {
					if (c.typename === "TemplateData") this.literal.push(tl(String(c.value ?? "")));
					else {
						const { inner, html } = splitOutput(c);
						const js = this.expr(inner);
						this.literal.push(`\${${this.nj(html ? "text" : "escape")}(${js})}`);
					}
				}
				return;
			case "If": {
				// an if whose branches only set names (declared before it now) prints nothing
				const branches: NjNode[][] = [];
				for (let c: NjNode | null = n; c; c = (c.else_ as NjNode | null)?.typename === "If" ? (c.else_ as NjNode) : null) {
					branches.push(kids(c.body as NjNode));
					if (c.else_ && (c.else_ as NjNode).typename !== "If") branches.push(kids(c.else_ as NjNode));
				}
				if (branches.every((b) => b.every((x) => x.typename === "Set"))) return;
				let first = true;
				for (let c: NjNode | null = n; c; ) {
					const cond = this.expr(c.cond as NjNode);
					const body = kids(c.body as NjNode);
					if (first) this.line(`if (${cond}) {`);
					else this.line(`} else if (${cond}) {`);
					first = false;
					this.depth++;
					this.nodes(body);
					this.flush();
					this.depth--;
					const other = c.else_ as NjNode | null;
					if (other?.typename === "If") c = other;
					else {
						if (other) {
							this.line("} else {");
							this.depth++;
							this.nodes(kids(other));
							this.flush();
							this.depth--;
						}
						c = null;
					}
				}
				this.line("}");
				return;
			}
			case "For":
				this.loop(n);
				return;
			case "Set": {
				const plan = this.an.sets.get(n);
				if (plan && !plan.group && (plan.placement === "top" || plan.placement === "loop")) {
					this.line(`const ${jsName(plan.name)} = ${this.expr(n.value as NjNode)};`);
					this.scope.locals.add(plan.name);
				}
				return;
			}
			case "Include":
				this.include(n);
				return;
			case "Block":
				this.block("{", () => this.nodes(kids(n.body as NjNode)));
				return;
			case "Extends":
				this.notTranslated(lineOf(n), "extends", "A text template that extends another is not translated yet.");
				return;
			// A macro definition prints nothing where it stands, and imports become the module's imports
			case "Macro":
			case "FromImport":
			case "Import":
				return;
			default:
				this.notTranslated(lineOf(n), n.typename.toLowerCase(), `The Nunjucks ${n.typename} tag is not translated yet.`);
		}
	}

	loop(n: NjNode): void {
		const name = n.name as NjNode;
		if (name.typename === "Array") {
			this.notTranslated(lineOf(n), "for", "A for loop with several variables is not translated yet.");
			return;
		}
		const v = String(name.value);
		const list = `${this.nj("iterate")}(${this.expr(n.arr as NjNode)})`;
		const plan = this.an.loops.get(n);
		const usesLoop = plan?.usesLoop ?? false;
		const body = (items: string) =>
			this.withLocals([v, ...(usesLoop ? ["loop"] : [])], () => {
				if (!usesLoop) {
					this.block(`for (const { value: ${jsName(v)} } of ${items}) {`, () => this.nodes(kids(n.body as NjNode)));
					return;
				}
				const { i, all } = loopParams([v, "loop"], plan?.reads);
				this.block(
					`${items}.forEach(({ value: ${jsName(v)} }, ${i}, ${all}) => {`,
					() => {
						this.line(`const loop = ${this.nj("loop")}(${i}, ${all}.len);`);
						this.nodes(kids(n.body as NjNode));
					},
					"});",
				);
			});
		if (!n.else_) {
			body(list);
			return;
		}
		// Nunjucks evaluated the list once, for the else and the runs alike: a joiner or a macro in it runs once here too.
		// Its else runs when the length it read is falsy (iterate's `len`). `$list` can't be a template's name, since
		// Nunjucks names hold no `$`; the block keeps each loop's own
		this.block("{", () => {
			this.line(`const $list = ${list};`);
			this.block("if ($list.len) {", () => body("$list"), "} else {");
			this.depth++;
			this.nodes(kids(n.else_ as NjNode));
			this.flush();
			this.depth--;
			this.line("}");
		});
	}

	include(n: NjNode): void {
		const name = String((n.template as NjNode).value);
		const target = this.templates.get(name);
		if (!target) return; // loadTemplates reported it
		if (target.kind === "html") {
			this.notTranslated(lineOf(n), "include", `"${name}" is also included by an HTML template, and the translator writes one form of each template. Copy it to a second file for one of them.`);
			return;
		}
		if (target.kind === "raw" && !isRawFile(target)) {
			// An HTML partial with no Nunjucks in it becomes an Astro component for the pages, which a text module cannot
			// call. Nunjucks prints it as it is, so its text goes in here.
			this.line(`// ${name}, which has no Nunjucks in it`);
			this.literal.push(tl(target.source));
			return;
		}
		const leak = this.an.includeLeaks.find((l) => l.node === n);
		if (leak) {
			const names = leak.names.map((v) => `"${v}"`).join(", ");
			this.notTranslated(lineOf(n), "include", `"${name}" sets ${names} inside a loop. Nunjucks then changes this template's ${names} too.`);
		}
		let id = this.imports.get(name)?.id;
		if (!id) {
			const raw = isRawFile(target);
			const base = pascal(name.replace(/\.[^./]+$/, "")) || "Include";
			id = raw ? `${base[0]!.toLowerCase()}${base.slice(1)}${pascal(name.replace(/^.*\./, ""))}` : `render${base}`;
			for (let k = 2; this.names.has(id) || [...this.imports.values()].some((x) => x.id === id); k++) id = `${id.replace(/\d+$/, "")}${k}`;
			const spec = importPath(this.file, outPath(target));
			this.imports.set(name, { id, line: raw ? `import ${id} from "${spec}?raw";` : `import { render as ${id} } from "${spec}";` });
		}
		if (isRawFile(target)) {
			this.line(`${this.out} += ${id};`);
			return;
		}
		const reads = analyze(target, this.templates).contextReads;
		// A name set again further down is passed as it stands here (versions.mts)
		const as = (r: string) => (n.contextAliases as Record<string, string> | undefined)?.[r] ?? r;
		const pass = [...reads].filter((r) => this.scope.locals.has(as(r))).sort();
		const arg = pass.length ? `{ ...${this.ctx}, ${pass.map((p) => (jsName(as(p)) === p ? p : `${p}: ${jsName(as(p))}`)).join(", ")} }` : this.ctx;
		this.line(`${this.out} += ${id}(${arg});`);
	}
}

/** The emitter's nodes as a `(ctx) => string` function named `name`, its free names read from the context. */
function renderFunction(em: TextEmitter, name: string, exported: boolean): string {
	const free = [...em.scope.free];
	const body: string[] = [];
	if (free.length) body.push(`\tconst { ${free.map((n) => (jsName(n) === n ? n : `${n}: ${jsName(n)}`)).join(", ")} } = ${em.ctx};`);
	body.push(`\tlet ${em.out} = "";`, ...em.lines, `\treturn ${em.out};`);
	const ctxUsed = free.length || em.lines.some((l) => l.includes(em.ctx));
	const param = ctxUsed ? em.ctx : `_${em.ctx}`;
	return `${exported ? "export " : ""}function ${name}(${param}: Record<string, any>): string {\n${body.join("\n")}\n}\n`;
}

/** The runtime imports and include imports an emitter used. */
function headLines(em: TextEmitter, file: string): string[] {
	const head: string[] = [];
	if (em.usedNj) head.push(`import * as nj from "${importPath(file, `${RUNTIME_DIR}/nunjucks.ts`)}";`);
	if (em.usedTs) head.push(`import * as ts from "${importPath(file, `${RUNTIME_DIR}/filters.ts`)}";`);
	for (const { line } of em.imports.values()) head.push(line);
	return head;
}

export function emitTextModule(t: Template, templates: Map<string, Template>, report: Report): EmittedFile {
	if (isRawFile(t)) return { path: outPath(t), source: t.source };
	const em = new TextEmitter(t, templates, report);
	const macros = macroBindings(t, templates, em.file, false, report);
	em.scope.macros = macros.macros;
	em.scope.namespaces = macros.namespaces;
	for (const n of macros.names) em.scope.locals.add(n);
	reportUnplacedSets(t, em.an, report);
	em.nodes(kids(astOf(t)));
	em.flush();
	const head = [...headLines(em, em.file), ...macros.lines];
	return {
		path: em.file,
		source: `// Translated from the Nunjucks template ${t.name}.\n${head.join("\n")}${head.length ? "\n\n" : ""}${renderFunction(em, "render", true)}`,
	};
}

/**
 * The macros a template defines, as functions in one module (macroModulePath). A call passes the arguments in
 * parameter order (expressions.mts maps keyword arguments), the body renders with only those in its context, as a
 * Nunjucks macro sees only its arguments, and the result comes back as SafeHtml, as Nunjucks returned a SafeString.
 * A macro can call the others in its file and the macros its file imports. Null when the template defines none.
 */
export function emitMacroModule(t: Template, templates: Map<string, Template>, report: Report): EmittedFile | null {
	const sigs = macroSignatures(t);
	if (!sigs.size || !t.ast) return null;
	const file = macroModulePath(t);
	const bindings = macroBindings(t, templates, file, true, report);
	const head = new Set<string>([`import * as nj from "${importPath(file, `${RUNTIME_DIR}/nunjucks.ts`)}";`, ...bindings.lines]);
	const seen = templateContext(t);
	// Each macro's render helper gets a name no export, import or other helper has
	const taken = new Set<string>([...[...sigs.keys()].map(jsName), ...bindings.names.map(jsName)]);
	const helperOf = new Map<string, string>();
	for (const name of sigs.keys()) {
		let helper = `render${pascal(name)}`;
		for (let k = 2; taken.has(helper); k++) helper = `render${pascal(name)}${k}`;
		taken.add(helper);
		helperOf.set(name, helper);
	}
	const parts: string[] = [];
	for (const n of kids(t.ast)) {
		if (n.typename !== "Macro") continue;
		const name = String((n.name as NjNode).value);
		const sig = sigs.get(name)!;
		const params = [...sig.argNames, ...sig.kwargNames];
		const body: Template = { ...t, extends: null, ast: { typename: "Root", lineno: n.lineno, colno: n.colno, children: kids(n.body as NjNode) } };
		const em = new TextEmitter(body, templates, report, file);
		em.scope.macros = bindings.macros;
		em.scope.namespaces = bindings.namespaces;
		for (const b of bindings.names) em.scope.locals.add(b);
		reportUnplacedSets(body, em.an, report);
		em.nodes(kids(body.ast as NjNode));
		em.flush();
		for (const line of headLines(em, file)) head.add(line);
		const render = helperOf.get(name)!;
		parts.push(renderFunction(em, render, false));
		// Defaults are set in order where the macro runs, as Nunjucks set them, so each sees the parameters before it
		const at = { file: t.name, line: lineOf(n) };
		const defaultReads = new Set<string>();
		const defaults: string[] = [];
		const kw = kids(n.args as NjNode).find((a) => a.typename === "KeywordArgs");
		for (const pair of kids(kw)) {
			const scope: Scope = { locals: new Set([...params, ...bindings.names]), free: defaultReads, macros: bindings.macros, namespaces: bindings.namespaces };
			const code = emitExpression(pair.value as NjNode, scope, report, { file: t.name, line: lineOf(pair) });
			if (/\bts\./.test(code)) head.add(`import * as ts from "${importPath(file, `${RUNTIME_DIR}/filters.ts`)}";`);
			defaults.push(`\tif (${jsName(String((pair.key as NjNode).value))} === undefined) ${jsName(String((pair.key as NjNode).value))} = ${code};`);
		}
		// Anything else a Nunjucks macro read came from its template's context, which this function doesn't have
		for (const read of new Set([...em.scope.free, ...defaultReads])) {
			if (params.includes(read) || SKIP_NAMES.has(read) || !(seen.sets.has(read) || seen.calls.has(name))) continue;
			report.add({
				kind: "not-translated",
				file: t.name,
				line: at.line,
				construct: read,
				message: `The macro "${name}" reads "${read}" from its template's context, which the translated macro doesn't see, so it is empty there. Pass it as an argument.`,
			});
		}
		const fields = params.map((p) => {
			const key = /^[A-Za-z_$][\w$]*$/.test(p) ? p : JSON.stringify(p);
			return jsName(p) === p ? p : `${key}: ${jsName(p)}`;
		});
		const lines = [...[...defaultReads].map((r) => `\tlet ${jsName(r)}: any;`), ...defaults, `\treturn nj.markSafe(${render}({ ${fields.join(", ")} }));`];
		parts.push(`export function ${jsName(name)}(${params.map((p) => `${jsName(p)}?: any`).join(", ")}): nj.SafeHtml {\n${lines.join("\n")}\n}\n`);
	}
	return { path: file, source: `// Macros translated from the Nunjucks template ${t.name}.\n${[...head].join("\n")}\n\n${parts.join("\n")}` };
}

/**
 * What a template's macros saw of its context in Nunjucks, beyond their arguments: the names it sets at its top level
 * (if branches included, as they run in the top frame), and, for a macro the template calls itself, the context the
 * template renders with. An imported template renders with an empty context.
 */
function templateContext(t: Template): { sets: Set<string>; calls: Set<string> } {
	const sets = new Set<string>();
	const visit = (list: NjNode[]): void => {
		for (const n of list) {
			if (n.typename === "Set") for (const target of n.targets as NjNode[]) sets.add(String(target.value));
			else if (n.typename === "If") {
				visit(kids(n.body as NjNode));
				visit(n.else_ ? ((n.else_ as NjNode).typename === "If" ? [n.else_ as NjNode] : kids(n.else_ as NjNode)) : []);
			}
		}
	};
	const top = kids(t.ast ?? undefined);
	visit(top);
	return { sets, calls: calledNames({ typename: "Root", lineno: 0, colno: 0, children: top.filter((n) => n.typename !== "Macro") }) };
}
