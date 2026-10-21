import assert from "node:assert/strict";
import { test } from "node:test";
import nunjucks from "nunjucks";
import { emitExpression, jsName, splitOutput } from "../../tsg2astro/expressions.mts";
import type { Scope } from "../../tsg2astro/expressions.mts";
import { Report } from "../../tsg2astro/report.mts";
import type { NjNode } from "../../tsg2astro/templates.mts";
import * as nj from "../../tsg2astro/runtime/nunjucks.ts";

const at = { file: "t.html", line: 1 };
const parse = (nunjucks as unknown as { parser: { parse: (src: string) => NjNode } }).parser.parse;

/** The expression inside the first `{{ }}` of a template. */
function parseOutput(template: string): NjNode {
	const root = parse(template);
	const output = (root.children as NjNode[])[0] as NjNode;
	assert.equal(output.typename, "Output");
	return (output.children as NjNode[])[0] as NjNode;
}

function emit(expr: string, locals: string[] = [], report = new Report()) {
	const scope: Scope = { locals: new Set(locals), free: new Set() };
	const js = emitExpression(splitOutput(parseOutput(`{{ ${expr} }}`)).inner, scope, report, at);
	return { js, scope, report };
}

type Case = {
	template: string;
	context?: Record<string, unknown>;
	/** Evaluate the emitted JS with `loop = nj.loop(...)`, and render the template inside a Nunjucks loop. */
	loopAt?: number;
};

const CASES: Case[] = [
	{ template: "{{ a.b.c }}", context: {} },
	{ template: "{{ a.b.c }}", context: { a: { b: { c: "<x>" } } } },
	{ template: "{{ posts.items.slice(0,3) | length }}", context: { posts: { items: [1, 2, 3, 4, 5] } } },
	{ template: "{{ pagination.currentPage == 1 }}", context: { pagination: { currentPage: 1 } } },
	{ template: "{{ pagination.currentPage == 1 }}", context: { pagination: { currentPage: "1" } } },
	{ template: "{{ not loop.first }}", loopAt: 1 },
	{ template: "{{ not loop.first }}", loopAt: 0 },
	{ template: "{{ loop.revindex0 }} of {{ loop.length }}", loopAt: 1 },
	{ template: "{{ a or 'x' }}", context: {} },
	{ template: "{{ a or 'x' }}", context: { a: "y" } },
	{ template: "{{ (a + 1) * 2 - b // 3 }}", context: { a: 2, b: 10 } },
	{ template: '{{ "a" ~ 1 ~ none }}' },
	{ template: '{{ x ~ "a" }}', context: {} },
	{ template: '{{ "a" ~ 1 + 2 }}' },
	{ template: "{{ 2 in [1,2] }}" },
	{ template: '{{ "ab" in s }}', context: { s: "cabd" } },
	{ template: '{{ "k" in o }}', context: { o: { k: 1 } } },
	{ template: '{{ "x" if c else "y" }}', context: { c: true } },
	{ template: '{{ "x" if c else "y" }}', context: { c: 0 } },
	{ template: '{{ "x" if c }}', context: { c: 0 } },
	{ template: "{{ title | title }}", context: { title: "the lion, the witch" } },
	{ template: "{{ t | upper }}", context: { t: "abc<" } },
	{ template: "{{ t | lower }}", context: {} },
	{ template: "{{ obj | dump }}", context: { obj: { b: 1, a: [1, "x"] } } },
	{ template: "{{ obj | dump(2) }}", context: { obj: { b: 1 } } },
	{ template: '{{ missing | default("d") }}', context: {} },
	{ template: '{{ f | default("d") }}', context: { f: false } },
	{ template: '{{ f | default("d", true) }}', context: { f: false } },
	{ template: '{{ list | join(", ") }}', context: { list: ["a", "b&c"] } },
	{ template: "{{ people | join(', ', 'n') }}", context: { people: [{ n: "A" }, { n: "B" }] } },
	{ template: "{{ html | striptags }}", context: { html: "<p>Hello   <b>there</b></p><!-- c -->" } },
	{ template: '{{ s | replace("a", "b") }}', context: { s: "banana" } },
	{ template: '{{ s | replace("a", "b", 2) }}', context: { s: "banana" } },
	{ template: '{{ s | urlencode }}', context: { s: "a b&c" } },
	{ template: "{{ o | urlencode }}", context: { o: { a: "b c", d: 1 } } },
	{ template: '{{ "<b>" }}' },
	{ template: '{{ "<b>" | safe }}' },
	{ template: "{{ h | safe }}", context: { h: "<i>x</i>" } },
	{ template: "{{ h | safe }}", context: {} },
	{ template: "{{ h | escape }}", context: { h: "<i>x</i>" } },
	{ template: "{{ h | e }}", context: { h: "a & b" } },
	{ template: "{{ h | escape | upper }}", context: { h: "a & b" } },
	{ template: "{{ list | first }}/{{ list | last }}", context: { list: [1, 2, 3] } },
	{ template: "{{ list | sort | join }}", context: { list: ["b", "A", "c"] } },
	{ template: "{{ list | sort(true) | join }}", context: { list: ["b", "A", "c"] } },
	{ template: '{{ list | sort(attribute="n") | join(",", "n") }}', context: { list: [{ n: "b" }, { n: "a" }] } },
	{ template: "{{ s | trim }}", context: { s: "  hi  " } },
	{ template: "{{ s | length }}", context: { s: "four" } },
	{ template: "{{ o | length }}", context: { o: { a: 1, b: 2 } } },
	{ template: "{{ s | length }}", context: {} },
	{ template: "{{ a / b }} {{ a % b }} {{ a ** b }} {{ -a }} {{ +a }}", context: { a: 7, b: 2 } },
	{ template: "{{ a < b }} {{ a >= b }} {{ a != b }} {{ a === b }} {{ a !== b }}", context: { a: 1, b: 2 } },
	{ template: "{{ not 1 == 2 }}" },
	{ template: "{{ a and b }}", context: { a: 1, b: "z" } },
	{ template: "{{ [1, 'a', none, true] }}" },
	{ template: "{{ {a: 1, 'b': 2}.b }}" },
	{ template: "{{ d['k-1'] }} {{ d[key] }} {{ l[0] }}", context: { d: { "k-1": "v" }, key: "k-1", l: ["z"] } },
	{ template: "{{ s.toUpperCase() }}", context: { s: "abc" } },
	{ template: "{{ items | length > 2 }}", context: { items: [1, 2, 3] } },
	{ template: '{{ "Page " ~ (n + 1) }}', context: { n: 1 } },
	{ template: "{{ -(-1) }}" },
	{ template: "{{ 1.5 + 2 }}" },
	{ template: "{{ now }}", context: {} },
];

function render(env: nunjucks.Environment, c: Case): string {
	if (c.loopAt === undefined) return env.renderString(c.template, c.context ?? {});
	// Wrap the template in a loop of three items and keep only the output of the iteration at `loopAt`.
	const wrapped = `{% for i in [0, 1, 2] %}{% if i == ${c.loopAt} %}${c.template}{% endif %}{% endfor %}`;
	return env.renderString(wrapped, c.context ?? {});
}

function evaluate(c: Case): string {
	return evaluateLoose(c, true);
}

function evaluateLoose(c: Case, strict = false): string {
	// Re-parse the whole template and emit each Output expression in turn.
	const root = parse(c.template);
	const report = new Report();
	let out = "";
	for (const output of root.children as NjNode[]) {
		for (const node of output.children as NjNode[]) {
			if (node.typename === "TemplateData") {
				out += node.value as string;
				continue;
			}
			const { inner, html } = splitOutput(node);
			const scope: Scope = { locals: new Set(c.loopAt === undefined ? [] : ["loop"]), free: new Set() };
			const js = emitExpression(inner, scope, report, at);
			const names = [...scope.free].map(jsName);
			const values = [...scope.free].map((n) => (c.context ?? {})[n]);
			const fn = new Function("nj", "ts", "loop", ...names, `return nj.text(${js});`);
			const value = fn(nj, {}, c.loopAt === undefined ? undefined : nj.loop(c.loopAt, 3), ...values) as string;
			out += html ? value : nj.escape(value);
		}
	}
	if (strict) assert.deepEqual(report.items(), [], `unexpected report for ${c.template}`);
	return out;
}

const env = new nunjucks.Environment(null, { autoescape: true });
for (const c of CASES) {
	test(`differential ${c.template} ${JSON.stringify(c.context ?? {})}${c.loopAt === undefined ? "" : ` loop@${c.loopAt}`}`, () => {
		assert.equal(evaluate(c), render(env, c));
	});
}

test("emitted shapes", () => {
	assert.equal(emit("a.b.c").js, "a?.b?.c");
	assert.equal(emit('a["b"]').js, "a?.b");
	assert.equal(emit('a["b-c"]').js, 'a?.["b-c"]');
	assert.equal(emit("a[i]").js, "a?.[i]");
	assert.equal(emit("a.slice(0, 3)").js, "a?.slice(0, 3)");
	assert.equal(emit("post.title | title").js, "nj.filters.title(post?.title)");
	assert.equal(emit("a and not b or c").js, "a && !b || c");
	assert.equal(emit("2 in [1, 2]").js, "nj.inOp(2, [1, 2])");
	assert.equal(emit("a // b").js, "nj.floorDiv(a, b)");
	assert.equal(emit("a ** 2").js, "Math.pow(a, 2)");
	assert.equal(emit('"x" if c else "y"').js, '(c ? "x" : "y")');
	assert.equal(emit("loop.first", ["loop"]).js, "loop?.first");
	assert.equal(emit("d | d('z')").js, 'nj.filters.default(d, "z")');
});

test("ts filters become ts.name(value, args)", () => {
	assert.equal(emit("post | route('posts')").js, 'ts.route(post, "posts")');
	assert.equal(emit("img | image({ width: 600 })").js, "ts.image(img, { width: 600 })");
	assert.equal(emit("when | date('YYYY')").js, 'ts.date(when, "YYYY")');
	assert.equal(emit("a | asset").js, "ts.asset(a)");
});

test("image parameters the image endpoint ignores are reported", () => {
	const literal = emit("img | image({w: 400, h: 300, fit: 'crop', blur: 20, crop: 'faces,car', fm: 'jxl'})");
	assert.equal(literal.js, 'ts.image(img, { w: 400, h: 300, fit: "crop", blur: 20, crop: "faces,car", fm: "jxl" })');
	assert.deepEqual(
		literal.report.items().map((i) => [i.kind, i.file, i.line, i.construct, i.message]),
		[
			["image-param", "t.html", 1, "blur", 'The image filter passes "blur": the image endpoint ignores it.'],
			["image-param", "t.html", 1, "crop", 'The image filter passes "crop": the image endpoint ignores "car" in it.'],
			["image-param", "t.html", 1, "fm", 'The image filter passes "fm": the image endpoint ignores "jxl" and sends WebP.'],
		],
	);

	// A value the template computes reaches the endpoint as it reached imgix, so only its name is checked
	assert.deepEqual(emit("img | image({w: 400, fit: crop})").report.items(), []);
	assert.deepEqual(
		emit("img | image({w: 400, blur: amount})").report.items().map((i) => i.construct),
		["blur"],
	);

	// Parameters in a variable can't be read when the site is translated
	const variable = emit("img | image(params)");
	assert.equal(variable.js, "ts.image(img, params)");
	assert.deepEqual(
		variable.report.items().map((i) => [i.kind, i.file, i.line, i.construct]),
		[["image-param", "t.html", 1, "image"]],
	);
	assert.match(variable.report.items()[0]!.message, /could not read/);

	// No parameters, or only ones the endpoint honors: nothing to report
	assert.deepEqual(emit("img | image").report.items(), []);
	assert.deepEqual(emit("img | image({w: 1, h: 2, q: 3, fm: 'png', fit: 'crop', crop: 'faces', dpr: 2, auto: 'compress,format'})").report.items(), []);
	assert.deepEqual(emit("img | image({})").report.items(), []);
});

test("free names and locals", () => {
	const { js, scope } = emit("post.title ~ other ~ loop.index", ["loop"]);
	assert.deepEqual([...scope.free].sort(), ["other", "post"]);
	assert.ok(js.includes("loop?.index"));
	const mangled = emit("class.x ~ nj ~ Math");
	assert.equal(mangled.js, "class$?.x + \"\" + nj$ + \"\" + Math$");
	assert.deepEqual([...mangled.scope.free].sort(), ["Math", "class", "nj"]);
	assert.equal(jsName("class"), "class$");
	assert.equal(jsName("title"), "title");
});

test("TakeShape filters that are not translated yet are reported", () => {
	for (const f of ["md", "number", "numberFormat", "code", "pluralize", "union", "intersection"]) {
		const { js, report } = emit(`x | ${f}(1)`);
		assert.equal(js, "undefined");
		assert.deepEqual(report.items(), [{ kind: "not-translated", file: "t.html", line: 1, construct: f, message: report.items()[0]?.message ?? "" }]);
		assert.match(report.items()[0]?.message ?? "", /not translated|TakeShape/i);
	}
});

test("unknown filters, tests, globals, keyword args and node types are reported and emit undefined", () => {
	for (const [expr, construct] of [
		["x | frobnicate", "frobnicate"],
		["x | nl2br", "nl2br"],
		["x is defined", "is defined"],
		["x is divisibleby(3)", "is divisibleby"],
		["range(3)", "range"],
		["f(a=1)", "f"],
		["x | default(boolean=true)", "default"],
	] as const) {
		const { js, report } = emit(expr);
		assert.ok(/undefined/.test(js), `${expr} -> ${js}`);
		const item = report.items()[0];
		assert.equal(item?.kind, "not-translated", expr);
		assert.equal(item?.construct, construct, expr);
		assert.equal(item?.file, "t.html");
		assert.equal(item?.line, 1);
	}
	const unknownNode = emitExpression({ typename: "Mystery", lineno: 0, colno: 0 }, { locals: new Set(), free: new Set() }, new Report(), at);
	assert.equal(unknownNode, "undefined");
});

test("sort keyword arguments map to positions", () => {
	assert.equal(emit('l | sort(attribute="n")').js, 'nj.filters.sort(l, undefined, undefined, "n")');
	assert.equal(emit("l | sort(reverse=true, case_sensitive=true)").js, "nj.filters.sort(l, true, true)");
});

test("splitOutput finds the outermost safe and escape", () => {
	assert.equal(splitOutput(parseOutput("{{ x | safe }}")).html, true);
	assert.equal(splitOutput(parseOutput("{{ x | escape }}")).html, false);
	assert.equal(splitOutput(parseOutput("{{ x | escape }}")).inner.typename, "Symbol");
	assert.equal(splitOutput(parseOutput("{{ x | upper | safe }}")).inner.typename, "Filter");
	assert.equal(splitOutput(parseOutput("{{ x | safe | upper }}")).html, false);
});

test("a safe or escape that is not outermost is reported when Nunjucks would keep it safe", () => {
	for (const [expr, construct] of [
		["x | safe | trim", "safe"],
		['(x | safe) ~ "a"', "safe"],
		["x | safe | upper", "safe"],
		["x | escape | trim", "escape"],
		['x | escape | replace("a", "b")', "escape"],
		["x | escape | escape", "escape"],
	] as const) {
		const { report } = emit(expr);
		assert.deepEqual(report.items().map((i) => [i.kind, i.construct, i.file, i.line]), [["not-translated", construct, "t.html", 1]], expr);
	}
	for (const expr of ["x | escape | upper", "x | escape | lower", '(x | escape) ~ "a"', "x | escape | length"]) {
		assert.deepEqual(emit(expr).report.items(), [], expr);
	}
	// where the outcome agrees with Nunjucks, the translation is exact
	const ctx = { x: " <b> & " };
	for (const template of ["{{ x | escape | upper }}", '{{ (x | escape) ~ "a" }}']) {
		const c = { template, context: ctx };
		assert.equal(evaluate(c), render(env, c));
	}
	// and where it was reported, the output degrades to escaped text
	const safeTrim = { template: "{{ x | safe | trim }}", context: ctx };
	assert.equal(render(env, safeTrim), "<b> &");
	assert.equal(evaluateLoose(safeTrim), "&lt;b&gt; &amp;");
});

test("runtime helpers", () => {
	assert.equal(nj.text(null), "");
	assert.equal(nj.text([1, 2]), "1,2");
	assert.equal(nj.escape(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
	assert.deepEqual(nj.iterate([5]), [{ key: null, value: 5 }]);
	// A one-name loop runs to the object's length, as Nunjucks indexes it: none for a plain object
	assert.deepEqual(nj.iterate({ a: 1 }), []);
	assert.deepEqual(nj.iterate({ length: 1, 0: "x" }), [{ key: null, value: "x" }]);
	assert.deepEqual(nj.iterate(null), []);
	// Nunjucks loops while i < arr.length, so < coerces the length, and keeps the length it read for loop and the else
	assert.deepEqual(nj.iterate({ length: "2", 0: "a", 1: "b" }), [{ key: null, value: "a" }, { key: null, value: "b" }]);
	assert.equal(nj.iterate({ length: "abc", 0: "x" }).length, 0);
	assert.equal(nj.iterate({ length: "abc", 0: "x" }).len, "abc");
	assert.equal(nj.iterate(null).len, undefined);
	assert.deepEqual(nj.iterate(new Set(["s"])), [{ key: null, value: "s" }]);
	// Strings go by UTF-16 unit, as arr[i] reads them
	assert.equal(nj.iterate("a\u{1F600}").length, 3);
	assert.deepEqual(nj.loop(1, "2"), { index: 2, index0: 1, revindex: 1, revindex0: 0, first: false, last: true, length: "2" });
	assert.deepEqual(nj.loop(2, 3), { index: 3, index0: 2, revindex: 1, revindex0: 0, first: false, last: true, length: 3 });
	// Emitted loops read len from map's and forEach's third argument, and a generated project typechecks that, as
	// `npm run typecheck` does these lines
	assert.deepEqual(nj.iterate({ length: "2", 0: "a", 1: "b" }).map((_, i, all) => nj.loop(i, all.len).revindex), [2, 1]);
	const lens: unknown[] = [];
	nj.iterate({ length: "2", 0: "a", 1: "b" }).forEach((_, i, all) => lens.push(all.len));
	assert.deepEqual(lens, ["2", "2"]);
	assert.equal(nj.inOp(1, [1]), true);
	assert.throws(() => nj.inOp(1, 5), /unexpected types/);
	assert.equal(nj.floorDiv(7, 2), 3);
});
