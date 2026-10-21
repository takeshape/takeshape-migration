import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadTsgConfig } from "../../tsg2astro/config.mts";
import { emitAstroComponent } from "../../tsg2astro/emit-astro.mts";
import { Report } from "../../tsg2astro/report.mts";
import { outPath } from "../../tsg2astro/scope.mts";
import { loadTemplates } from "../../tsg2astro/templates.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const books = join(root, "test", "tsg", "sites", "shape-books", "site");
const work = mkdtempSync(join(tmpdir(), "tsg-templates-"));
after(() => rmSync(work, { recursive: true, force: true }));

async function booksTemplates() {
	const config = await loadTsgConfig(books, {});
	const report = new Report();
	const entries: Array<{ name: string; kind: "html" | "text" }> = [];
	for (const r of Object.values(config.routes)) {
		const kind = (p?: string) => (/\.[a-z0-9]+$/i.test(p ?? "") ? "text" : "html");
		if (r.template) entries.push({ name: r.template, kind: r.path && /\.\w+$/.test(r.path) ? "text" : "html" });
		if (r.paginate?.template) entries.push({ name: r.paginate.template, kind: kind(r.paginate.path) === "text" ? "text" : "html" });
	}
	return { templates: await loadTemplates(books, config, entries, report), report };
}

test("shape-books-graph", async () => {
	const { templates } = await booksTemplates();
	const home = templates.get("pages/homepage.html");
	assert.ok(home);
	assert.equal(home.extends, "layouts/default.html");
	assert.ok(home.includes.includes("partials/our-books.html"));
	assert.ok(home.ast);
	const layout = templates.get("layouts/default.html");
	assert.ok(layout);
	assert.ok(layout.blocks.includes("title"));
	assert.ok(layout.blocks.includes("content"));
});

test("svg-is-raw", async () => {
	const { templates } = await booksTemplates();
	const logo = templates.get("partials/vectors/logo.svg");
	assert.ok(logo);
	assert.equal(logo.kind, "raw");
	assert.equal(logo.ast, null);
});

test("sitemap-is-text", async () => {
	const { templates } = await booksTemplates();
	assert.equal(templates.get("feeds/sitemap.xml")?.kind, "text");
	assert.equal(templates.get("pages/homepage.html")?.kind, "html");
});

const paginationAst = async () => {
	const { templates } = await booksTemplates();
	return templates.get("partials/pagination.html")!;
};

test("pagination-tag-interiors", async () => {
	const { templates, report } = await booksTemplates();
	assert.equal(report.items().filter((i) => i.kind === "not-translated").length, 0);
	const p = templates.get("partials/pagination.html")!;
	const hits = p.tagInteriors.filter((h) => h.kind === "tag");
	assert.equal(hits.length, 15);
	assert.equal(p.tagInteriors.length - hits.length, 9, "outputs inside tags are listed too");
	assert.deepEqual(hits.map((h) => h.line), [18, 19, 19, 19, 19, 20, 22, 23, 23, 54, 55, 55, 58, 59, 59]);
	const line19 = hits.filter((h) => h.line === 19);
	// The outer if/else/endif are in the start tag; everything inside href="..." is in an attribute value.
	const outer = hits.filter((h) => h.line === 18 || h.line === 20 || (h.line === 19 && h.raw === "{% else %}" && h.where === "start-tag"));
	assert.equal(outer.length, 3);
	for (const h of outer) assert.equal(h.where, "start-tag");
	const nested = line19.filter((h) => h.where === "attr-value");
	assert.deepEqual(nested.map((h) => h.raw), ["{% if previousPage == 1 %}", "{% else %}", "{% endif %}"]);
	for (const h of nested) assert.equal(h.quote, '"');
	for (const h of p.tagInteriors) {
		assert.equal(h.element, "a");
		assert.equal(p.source[h.tagStart], "<");
		assert.equal(p.source.slice(h.start, h.end), h.raw);
	}
});

test("tag-interior-positions-match-parser", async () => {
	const p = await paginationAst();
	const nodes: Array<{ typename: string; lineno: number; colno: number }> = [];
	const walk = (n: unknown): void => {
		if (Array.isArray(n)) return n.forEach(walk);
		if (!n || typeof n !== "object") return;
		const o = n as { typename?: string; lineno: number; colno: number };
		if (o.typename === "If") nodes.push(o as never);
		for (const v of Object.values(o)) walk(v);
	};
	walk(p.ast);
	const ifs = p.tagInteriors.filter((h) => /^\{%-?\s*(if|elif)\b/.test(h.raw));
	assert.equal(ifs.length, 5);
	for (const h of ifs) assert.ok(nodes.some((n) => n.lineno + 1 === h.line && n.colno + 1 === h.col), `no If node at ${h.line}:${h.col}`);
	// Every other tag points at its keyword in the source.
	const lines = p.source.split("\n");
	for (const h of p.tagInteriors.filter((x) => x.kind === "tag")) assert.match(lines[h.line - 1]!.slice(h.col - 1), /^(if|elif|else|endif)\b/);
});

// Templates can build CDN URLs by hand from an asset's path. On TakeShape they printed what the asset and image
// filters print; on EmDash the path is a storage key, so the filters (which serve it from EmDash) take over.
test("hand-built TakeShape CDN URLs become the asset and image filters, on the same lines", async () => {
	const dir = join(work, "site-cdn");
	mkdirSync(join(dir, "templates"), { recursive: true });
	writeFileSync(join(dir, "tsg.yml"), "routes: {}\n");
	const source = [
		'<a href="https://assets.takeshape.io/{{ page.downloadButton.asset.path }}" download>Get it</a>',
		'<img src="https://images.takeshape.io/{{ page.graphImage.path }}?auto=format%2Ccompress">',
		"<hero-video :sources=\"['https://assets.takeshape.io/{{page.hero.video.path}}']\" img=\"https://images.takeshape.io/{{ page.hero.background.path }}\">",
		'<img src="https://images.takeshape.io/00000001/dev/00a00001/logo.png?auto=format">',
	].join("\n");
	writeFileSync(join(dir, "templates", "a.html"), source);
	const config = await loadTsgConfig(dir, {});
	const report = new Report();
	const t = (await loadTemplates(dir, config, [{ name: "a.html", kind: "html" }], report)).get("a.html")!;
	assert.equal(
		t.source,
		[
			'<a href="{{ page.downloadButton.asset.path | asset }}" download>Get it</a>',
			'<img src="{{ page.graphImage.path | image({ auto: "format,compress" }, false) }}">',
			"<hero-video :sources=\"['{{ page.hero.video.path | asset }}']\" img=\"{{ page.hero.background.path | image({}, false) }}\">",
			'<img src="https://images.takeshape.io/00000001/dev/00a00001/logo.png?auto=format">',
		].join("\n"),
	);
	assert.deepEqual(
		report.items().map((i) => [i.kind, i.file, i.line]),
		[
			["note", "a.html", 1],
			["note", "a.html", 2],
			["note", "a.html", 3],
			["note", "a.html", 3],
		],
	);
	assert.match(report.items()[1]!.message, /https:\/\/images\.takeshape\.io\/\{\{ page\.graphImage\.path \}\}\?auto=format%2Ccompress/);
});

// HTML's srcset parsing ends a URL's run of non-whitespace at its trailing commas, which separate it from the next
// candidate; a comma inside a value (auto=format,compress) belongs to the URL
test("a hand-built CDN URL keeps the comma after it in a srcset", async () => {
	const dir = join(work, "site-cdn-srcset");
	mkdirSync(join(dir, "templates"), { recursive: true });
	writeFileSync(join(dir, "tsg.yml"), "routes: {}\n");
	writeFileSync(
		join(dir, "templates", "a.html"),
		'<img srcset="https://images.takeshape.io/{{ photo.path }}?w=300, https://images.takeshape.io/{{ photo.path }}?w=600&amp;auto=format,compress 2x">',
	);
	const config = await loadTsgConfig(dir, {});
	const t = (await loadTemplates(dir, config, [{ name: "a.html", kind: "html" }], new Report())).get("a.html")!;
	assert.equal(t.source, '<img srcset="{{ photo.path | image({ w: "300" }, false) }}, {{ photo.path | image({ w: "600", auto: "format,compress" }, false) }} 2x">');
});

// A URL inside a tag's string, a comment or a raw block is code or text Nunjucks never renders as markup: rewriting it
// there put unescaped quotes inside a string, and the template no longer parsed
test("hand-built CDN URLs in tags, output strings, comments and raw blocks stay as they are", async () => {
	const dir = join(work, "site-cdn-code");
	mkdirSync(join(dir, "templates"), { recursive: true });
	writeFileSync(join(dir, "tsg.yml"), "routes: {}\n");
	const code = [
		'{% set example = "https://images.takeshape.io/{{ photo.path }}?w=300" %}',
		"{# https://images.takeshape.io/{{ photo.path }}?w=10 #}",
		'{% raw %}<img src="https://images.takeshape.io/{{ photo.path }}?w=20">{% endraw %}',
		"{%- set q = 'a %} b' -%}",
		'{{ "https://images.takeshape.io/{{ photo.path }}?w=40" }}',
		"{{ 'x }} https://assets.takeshape.io/{{ file.path }}' }}",
	];
	writeFileSync(join(dir, "templates", "a.html"), [...code, '<img src="https://images.takeshape.io/{{ photo.path }}?w=30">'].join("\n"));
	const config = await loadTsgConfig(dir, {});
	const report = new Report();
	const t = (await loadTemplates(dir, config, [{ name: "a.html", kind: "html" }], report)).get("a.html")!;
	assert.equal(t.source, [...code, '<img src="{{ photo.path | image({ w: "30" }, false) }}">'].join("\n"));
	assert.ok(t.ast, JSON.stringify(report.items()));
});

// HTML decodes character references in an attribute before the browser reads the URL, so &#38; and &#x26; separate
// parameters as &amp; does; a script or a style is not decoded, and its output must not be escaped either
test("hand-built CDN URLs with character references, and in scripts and styles", async () => {
	const dir = join(work, "site-cdn-refs");
	mkdirSync(join(dir, "templates"), { recursive: true });
	writeFileSync(join(dir, "tsg.yml"), "routes: {}\n");
	const source = [
		'<img src="https://images.takeshape.io/{{ p.path }}?w=300&#38;h=200"><img src="https://images.takeshape.io/{{ p.path }}?w=300&#x26;h=200&amp;txt=a&#39;b">',
		'<style>.hero { background: url(https://images.takeshape.io/{{ p.path }}?w=300&h=200); }</style>',
		'<script>var u = "https://assets.takeshape.io/{{ f.path }}";</script>',
	].join("\n");
	writeFileSync(join(dir, "templates", "a.html"), source);
	const config = await loadTsgConfig(dir, {});
	const t = (await loadTemplates(dir, config, [{ name: "a.html", kind: "html" }], new Report())).get("a.html")!;
	assert.equal(
		t.source,
		[
			'<img src="{{ p.path | image({ w: "300", h: "200" }, false) }}"><img src="{{ p.path | image({ w: "300", h: "200", txt: "a\'b" }, false) }}">',
			'<style>.hero { background: url({{ p.path | image({ w: "300", h: "200" }, false) | safe }}); }</style>',
			'<script>var u = "{{ f.path | asset | safe }}";</script>',
		].join("\n"),
	);
});

// A fragment is no part of the query: the browser never sent it, and it stays on the URL
test("a hand-built CDN URL keeps its fragment outside the parameters", async () => {
	const dir = join(work, "site-cdn-fragment");
	mkdirSync(join(dir, "templates"), { recursive: true });
	writeFileSync(join(dir, "tsg.yml"), "routes: {}\n");
	writeFileSync(join(dir, "templates", "a.html"), '<a href="https://images.takeshape.io/{{ photo.path }}?w=300#preview">x</a><a href="https://assets.takeshape.io/{{ file.path }}#page=2">y</a>');
	const config = await loadTsgConfig(dir, {});
	const t = (await loadTemplates(dir, config, [{ name: "a.html", kind: "html" }], new Report())).get("a.html")!;
	assert.equal(t.source, '<a href="{{ photo.path | image({ w: "300" }, false) }}#preview">x</a><a href="{{ file.path | asset }}#page=2">y</a>');
});

// The CDN read each parameter decoded (bg=%23ff0000 is #ff0000), so an output the template urlencodes passes its own value
test("a hand-built CDN URL's urlencoded parameter passes the value itself", async () => {
	const dir = join(work, "site-cdn-urlencode");
	mkdirSync(join(dir, "templates"), { recursive: true });
	writeFileSync(join(dir, "tsg.yml"), "routes: {}\n");
	writeFileSync(join(dir, "templates", "a.html"), '<img src="https://images.takeshape.io/{{ photo.path }}?w=300&amp;bg={{ color | urlencode }}&amp;txt={{ label|urlencode }}">');
	const config = await loadTsgConfig(dir, {});
	const t = (await loadTemplates(dir, config, [{ name: "a.html", kind: "html" }], new Report())).get("a.html")!;
	assert.equal(t.source, '<img src="{{ photo.path | image({ w: "300", bg: color, txt: label }, false) }}">');
});

// Parameters a template fills in become image() arguments; a URL built any other way is left as it was and reported
test("hand-built CDN URLs keep what follows them and take parameters from outputs", async () => {
	const dir = join(work, "site-cdn-params");
	mkdirSync(join(dir, "templates"), { recursive: true });
	writeFileSync(join(dir, "tsg.yml"), "routes: {}\n");
	const mixed = '<img src="https://images.takeshape.io/{{ photo.path }}?w={{ width }}px">';
	const branch = '<img src="https://images.takeshape.io/{{ photo.path }}?w=300{% if big %}&amp;dpr=2{% endif %}">';
	// The output is only part of the path, so the filters can't take the URL's place
	const compound = '<img src="https://assets.takeshape.io/{{ projectId }}/dev/logo.svg">';
	// A filter binds tighter than or and if, so a compound expression is grouped before it
	const either = '<img src="https://images.takeshape.io/{{ primary.path or fallback.path }}?w=10"><a href="https://assets.takeshape.io/{{ a.path if a else b.path }}">f</a>';
	const source = [
		'<img src="https://images.takeshape.io/{{ photo.path }}?w={{ width }}&amp;h=200&amp;fit={{- mode -}}">',
		'<div style="background: url(https://images.takeshape.io/{{ photo.path }}?w=300)"></div>',
		mixed,
		branch,
		compound,
		either,
	].join("\n");
	writeFileSync(join(dir, "templates", "a.html"), source);
	const config = await loadTsgConfig(dir, {});
	const report = new Report();
	const t = (await loadTemplates(dir, config, [{ name: "a.html", kind: "html" }], report)).get("a.html")!;
	assert.equal(
		t.source,
		[
			'<img src="{{ photo.path | image({ w: width, h: "200", fit: mode }, false) }}">',
			'<div style="background: url({{ photo.path | image({ w: "300" }, false) }})"></div>',
			mixed,
			branch,
			compound,
			'<img src="{{ (primary.path or fallback.path) | image({ w: "10" }, false) }}"><a href="{{ (a.path if a else b.path) | asset }}">f</a>',
		].join("\n"),
	);
	assert.deepEqual(
		report.items().map((i) => [i.kind, i.line]),
		[
			["note", 1],
			["note", 2],
			["not-translated", 3],
			["not-translated", 4],
			["not-translated", 5],
			["note", 6],
			["note", 6],
		],
	);
	assert.match(report.items()[2]!.message, /image\(\{/);
});

test("output-interiors", async () => {
	const dir = join(work, "site1");
	mkdirSync(join(dir, "templates"), { recursive: true });
	writeFileSync(join(dir, "tsg.yml"), "routes: {}\n");
	writeFileSync(join(dir, "templates", "a.html"), '<p>{{ ok }}</p>\n<a {{ attrs }} href="{{ url }}" title=\'{{ t }}\' data-x={{ v }}>go</a>\n<a title="{{ x }} > y" {% if w %}hidden{% endif %}>z</a>');
	const config = await loadTsgConfig(dir, {});
	const report = new Report();
	const t = await loadTemplates(dir, config, [{ name: "a.html", kind: "html" }], report);
	const hits = t.get("a.html")!.tagInteriors;
	assert.deepEqual(
		hits.map((h) => [h.raw, h.where, h.quote ?? null, h.element]),
		[
			["{{ attrs }}", "start-tag", null, "a"],
			["{{ url }}", "attr-value", '"', "a"],
			["{{ t }}", "attr-value", "'", "a"],
			["{{ v }}", "attr-value", null, "a"],
			["{{ x }}", "attr-value", '"', "a"],
			["{% if w %}", "start-tag", null, "a"],
			["{% endif %}", "start-tag", null, "a"],
		],
	);
	assert.deepEqual(report.items(), []);
});

test("script-split-by-tag-has-no-interiors", async () => {
	const dir = join(work, "site3");
	mkdirSync(join(dir, "templates"), { recursive: true });
	writeFileSync(join(dir, "tsg.yml"), "routes: {}\n");
	writeFileSync(join(dir, "templates", "a.html"), "<script>if (a {% if b %}<{% endif %} c) {}</script><p {% if x %}class=a{% endif %}>");
	const config = await loadTsgConfig(dir, {});
	const t = await loadTemplates(dir, config, [{ name: "a.html", kind: "html" }], new Report());
	assert.deepEqual(t.get("a.html")!.tagInteriors.map((h) => h.raw), ["{% if x %}", "{% endif %}"]);
});

test("missing-template-is-reported", async () => {
	const dir = join(work, "site2");
	mkdirSync(join(dir, "templates"), { recursive: true });
	writeFileSync(join(dir, "tsg.yml"), "routes: {}\n");
	writeFileSync(join(dir, "templates", "a.html"), '{% include "nope.html" %}');
	const config = await loadTsgConfig(dir, {});
	const report = new Report();
	const t = await loadTemplates(dir, config, [{ name: "a.html", kind: "html" }], report);
	assert.ok(t.has("a.html"));
	assert.ok(report.items().some((i) => i.file === "a.html" && /nope\.html/.test(i.message)));
});

test("names with .. resolve as takeshape-ssg read them, and never leave the site folder", async () => {
	// work/dotdot/a/b/site, so ../../../outside.html from site/templates is work/dotdot/a/outside.html
	const dir = join(work, "dotdot", "a", "b", "site");
	mkdirSync(join(dir, "templates", "partials"), { recursive: true });
	mkdirSync(join(dir, "static"), { recursive: true });
	writeFileSync(join(dir, "tsg.yml"), "routes: {}\n");
	writeFileSync(join(dir, "static", "icon.svg"), "<svg/>");
	writeFileSync(join(work, "dotdot", "a", "outside.html"), "<p>not the site's</p>");
	writeFileSync(join(dir, "templates", "partials", "x.html"), "<b>{{ x }}</b>");
	writeFileSync(
		join(dir, "templates", "a.html"),
		['{% include "../static/icon.svg" %}', '{% include "partials/../partials/x.html" %}{% include "/partials/x.html" %}', '{% include "../../../outside.html" %}'].join("\n"),
	);
	const config = await loadTsgConfig(dir, {});
	const report = new Report();
	const t = await loadTemplates(dir, config, [{ name: "./a.html", kind: "html" }], report);
	// One template per file, by its normalized name
	assert.deepEqual([...t.keys()].sort(), ["../static/icon.svg", "a.html", "partials/x.html"]);
	assert.deepEqual(t.get("a.html")!.includes, ["../static/icon.svg", "partials/x.html", "partials/x.html", "../../../outside.html"]);
	// A file of the site outside the templates folder goes under src/templates/_site/, by its path from the site root
	assert.equal(outPath(t.get("../static/icon.svg")!), "src/templates/_site/static/icon.svg");
	assert.equal(outPath(t.get("partials/x.html")!), "src/templates/partials/x.astro");
	const page = emitAstroComponent(t.get("a.html")!, t, report);
	assert.match(page.source, /from "\.\/_site\/static\/icon\.svg\?raw"/);
	assert.match(page.source, /from "\.\/partials\/x\.astro"/);
	// A file outside the site folder is refused: reported, never read, nothing written for it
	assert.deepEqual(
		report.items().map((i) => [i.kind, i.file, i.line, i.construct]),
		[["not-translated", "a.html", 3, "../../../outside.html"]],
	);
	assert.match(report.items()[0]!.message, /outside the site folder/);
	assert.ok(![...t.values()].some((x) => x.source.includes("not the site's")));
	assert.ok(!page.source.includes("outside"), page.source);
});

test("report-markdown", () => {
	const r = new Report();
	r.add({ kind: "not-translated", file: "pages/a.html", line: 7, construct: "{% macro %}", message: "Macros are not translated." });
	const md = r.toMarkdown([{ name: "home", urls: "/", files: ["pages/a.html"] }]);
	assert.match(md, /## Not translated/);
	assert.match(md, /\| pages\/a\.html \| 7 \| `\{% macro %\}` \| Macros are not translated\. \|/);
	assert.match(md, /\| home \| \/ \| pages\/a\.html \|/);
	assert.ok(!/rewrite this tag by hand/.test(md));
	assert.ok(!md.includes("—"));
});

test("route notes sit under the route table, under one heading", () => {
	const r = new Report();
	r.add({ kind: "route", file: "tsg.yml", construct: "about", message: "Served in tsg.yml order." });
	const md = r.toMarkdown([{ name: "about", urls: "/about/", files: ["src/pages/about/index.astro"] }]);
	assert.equal(md.match(/^## Routes$/gm)?.length, 1, md);
	const routes = md.slice(md.indexOf("## Routes"));
	assert.ok(routes.indexOf("| about |") < routes.indexOf("Served in tsg.yml order."), md);
	assert.ok(!/behave differently/.test(md), md);
});
