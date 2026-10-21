// Offline checks of the template emitters: the books starter translates with nothing reported, the output is
// deterministic, and what the emitters cannot translate shows up in the report. test/tsg/differential.mts proves
// that the emitted components render like Nunjucks (it needs an Astro install, so it is not part of npm test).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TsgConfig } from "../../tsg2astro/config.mts";
import { emitAstroComponent } from "../../tsg2astro/emit-astro.mts";
import { emitMacroModule, emitTextModule } from "../../tsg2astro/emit-text.mts";
import { Report } from "../../tsg2astro/report.mts";
import { loadTemplates } from "../../tsg2astro/templates.mts";

const here = dirname(fileURLToPath(import.meta.url));
const starter = join(here, "sites", "shape-books", "site", "src", "templates");
const work = mkdtempSync(join(tmpdir(), "tsg-emit-"));
after(() => rmSync(work, { recursive: true, force: true }));

const config = { templatePath: "." } as TsgConfig;
const ENTRIES: Array<{ name: string; kind: "html" | "text" }> = [
	{ name: "feeds/sitemap.xml", kind: "text" },
	{ name: "pages/homepage.html", kind: "html" },
	{ name: "pages/posts/individual.html", kind: "html" },
	{ name: "pages/posts/landing.html", kind: "html" },
	{ name: "pages/book.html", kind: "html" },
	{ name: "pages/author.html", kind: "html" },
];

async function emitAll(root: string, entries: Array<{ name: string; kind: "html" | "text" }>) {
	const report = new Report();
	const templates = await loadTemplates(root, config, entries, report);
	const files = new Map<string, string>();
	for (const t of templates.values()) {
		const f = t.kind === "text" ? emitTextModule(t, templates, report) : emitAstroComponent(t, templates, report);
		files.set(f.path, f.source);
		const macros = emitMacroModule(t, templates, report);
		if (macros) files.set(macros.path, macros.source);
	}
	return { files, items: report.items().filter((i) => i.kind === "not-translated"), report };
}

/** Writes a small site and emits it from the given entry. */
async function site(name: string, files: Record<string, string>, entry = "page.html") {
	const root = join(work, name);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return emitAll(root, [{ name: entry, kind: /\.html?$/.test(entry) ? "html" : "text" }]);
}

const constructs = (items: Array<{ construct?: string }>) => items.map((i) => i.construct).sort();

test("starter-translates-cleanly", async () => {
	const { files, items } = await emitAll(starter, ENTRIES);
	assert.deepEqual(items, []);
	assert.deepEqual([...files.keys()].sort(), [
		"src/templates/feeds/sitemap.xml.ts",
		"src/templates/layouts/default.astro",
		"src/templates/pages/author.astro",
		"src/templates/pages/book.astro",
		"src/templates/pages/homepage.astro",
		"src/templates/pages/posts/individual.astro",
		"src/templates/pages/posts/landing.astro",
		"src/templates/partials/footer.astro",
		"src/templates/partials/header.astro",
		"src/templates/partials/our-books.astro",
		"src/templates/partials/pagination.astro",
		"src/templates/partials/vectors/logo.svg",
	]);
});

test("starter-output-shape", async () => {
	const { files } = await emitAll(starter, ENTRIES);
	const pagination = files.get("src/templates/partials/pagination.astro")!;
	assert.match(pagination, /const previousPage = pagination\?\.currentPage - 1;/);
	assert.ok(pagination.includes('<a {...(pagination?.currentPage == 1 ? { class: "is-disabled" } : { href: previousPage == 1 ? nj.text(paginationFirstPage) : '));
	assert.ok(!pagination.includes("set:html"), "the pagination partial needs no raw HTML");
	const home = files.get("src/templates/pages/homepage.astro")!;
	assert.ok(home.includes("<Fragment set:html={`</article>`} />"), "the stray end tag is raw HTML");
	assert.match(home, /^const featuredBook = page\?\.featuredBook;$/m);
	assert.ok(home.includes('<Default {...Astro.props}>\n<Fragment slot="content">'));
	const layout = files.get("src/templates/layouts/default.astro")!;
	assert.ok(layout.includes('<title><slot name="title">{nj.text(site?.settings?.siteTitle)}{page?.title ? (<> - {nj.text(page?.title)}</>) : null}</slot></title>'));
	assert.ok(layout.includes("<Fragment set:html={`<script src=\"/javascripts/main.js\"></script>`} />"));
	assert.ok(files.get("src/templates/partials/header.astro")!.includes('import logoSvg from "./vectors/logo.svg?raw";'));
	const sitemap = files.get("src/templates/feeds/sitemap.xml.ts")!;
	assert.ok(sitemap.includes("for (const { value: post } of nj.iterate(posts?.items)) {"));
	assert.ok(sitemap.includes('${nj.escape(ts.route(post, "posts"))}'));
});

test("deterministic", async () => {
	const a = await emitAll(starter, ENTRIES);
	const b = await emitAll(starter, ENTRIES);
	assert.deepEqual([...a.files.entries()], [...b.files.entries()]);
});

// An if without an else leaves the name as it was: Nunjucks then finds the context's value, here the prop.
test("set-read-after-its-if-keeps-the-context-value-otherwise", async () => {
	const { items, files } = await site("set-after-if", { "page.html": "{% if x %}{% set y = 1 %}{% endif %}<p>{{ y }}</p>" });
	assert.deepEqual(items, []);
	assert.match(files.get("src/templates/page.astro")!, /^const y = x \? 1 : Astro\.props\.y;$/m);
});

test("set-in-every-branch-of-an-if-becomes-one-const", async () => {
	const { items, files } = await site("chain-else", {
		"page.html": "{% if data.tout.heading %}{% set heading = data.tout.heading %}{% else %}{% set heading = data.title %}{% endif %}<h1>{{ heading }}</h1>",
	});
	assert.deepEqual(items, []);
	const page = files.get("src/templates/page.astro")!;
	assert.match(page, /^const heading = data\?\.tout\?\.heading \? data\?\.tout\?\.heading : data\?\.title;$/m);
	assert.ok(page.includes("<h1>{nj.text(heading)}</h1>"), page);
});

test("set-in-every-branch-of-an-elif-chain-becomes-one-const", async () => {
	const { items, files } = await site("chain-elif", {
		"page.html": '{% if size == "l" %}{% set w = 1200 %}{% elif size == "m" %}{% set w = 800 %}{% else %}{% set w = 400 %}{% endif %}<p>{{ w }}</p>',
	});
	assert.deepEqual(items, []);
	assert.match(files.get("src/templates/page.astro")!, /^const w = size == "l" \? 1200 : size == "m" \? 800 : 400;$/m);
});

test("branch-without-a-set-keeps-the-context-value", async () => {
	const { items, files } = await site("chain-gap", {
		"page.html": '{% if a %}{% set t = "a" %}{% elif b %}<i>b</i>{% else %}{% set t = "c" %}{% endif %}<p>{{ t }}</p>{% include "item.html" %}',
		"item.html": "<b>{{ t }}</b>",
	});
	assert.deepEqual(items, []);
	const page = files.get("src/templates/page.astro")!;
	assert.match(page, /^const t = a \? "a" : b \? Astro\.props\.t : "c";$/m);
	assert.ok(page.includes("<Item {...Astro.props} t={t} />"), page);
});

test("nested-chains-become-nested-conditions", async () => {
	const { items, files } = await site("chain-nested", {
		"page.html": '{% if a %}{% if b %}{% set x = 1 %}{% else %}{% set x = 2 %}{% endif %}{% elif c %}{% set x = 3 %}{% else %}{% set x = 4 %}{% endif %}<p>{{ x }}</p>',
	});
	assert.deepEqual(items, []);
	assert.match(files.get("src/templates/page.astro")!, /^const x = a \? \(b \? 1 : 2\) : c \? 3 : 4;$/m);
});

test("two-names-set-in-one-chain-keep-their-order", async () => {
	const { items, files } = await site("chain-two-names", {
		"page.html": '{% if h %}{% set head = h %}{% set text = head ~ "!" %}{% else %}{% set head = "x" %}{% set text = false %}{% endif %}<p>{{ head }} {{ text }}</p>',
	});
	assert.deepEqual(items, []);
	const page = files.get("src/templates/page.astro")!;
	assert.match(page, /^const head = h \? h : "x";\nconst text = h \? head \+ "" \+ "!" : false;$/m);
});

test("chain-read-before-it-wraps-the-rest-in-a-function", async () => {
	const { items, files } = await site("chain-read-before", {
		"page.html": "<p>{{ note }}</p>{% if a %}{% set note = a %}{% else %}{% set note = 0 %}{% endif %}<p>{{ note }}</p>",
	});
	assert.deepEqual(items, []);
	const page = files.get("src/templates/page.astro")!;
	assert.ok(page.includes("<p>{nj.text(note)}</p>{(() => { const note = a ? a : 0; return (<>"), page);
});

test("chain-inside-an-if-wraps-the-rest-of-that-branch", async () => {
	const { items, files } = await site("chain-in-if", {
		"page.html": '{% if show %}{% if big %}{% set box = "wide" %}{% else %}{% set box = "narrow" %}{% endif %}<div>{{ box }}</div>{% endif %}',
	});
	assert.deepEqual(items, []);
	assert.ok(files.get("src/templates/page.astro")!.includes('{show ? (<>{(() => { const box = big ? "wide" : "narrow"; return (<>'));
});

test("chain-in-a-loop-body-becomes-a-const-in-the-callback", async () => {
	const { items, files } = await site("chain-in-loop", {
		"page.html": "<ul>{% for item in items %}{% if item.title %}{% set t = item.title %}{% else %}{% set t = loop.index %}{% endif %}<li>{{ t }}</li>{% endfor %}</ul>",
	});
	assert.deepEqual(items, []);
	const page = files.get("src/templates/page.astro")!;
	assert.ok(page.includes("const loop = nj.loop(i, all.len); const t = item?.title ? item?.title : loop?.index; return (<><li>"), page);
});

test("text-template-declares-the-chain-value-before-its-if", async () => {
	const { items, files } = await site(
		"chain-text",
		{ "feed.xml": '{% if site.url %}{% set base = site.url %}{% else %}{% set base = "/" %}{% endif %}{% if fr %}{% set label = "Fin" %}{% endif %}<feed base="{{ base }}">{{ label }}</feed>' },
		"feed.xml",
	);
	assert.deepEqual(items, []);
	const feed = files.get("src/templates/feed.xml.ts")!;
	assert.ok(feed.includes('\tconst base = site?.url ? site?.url : "/";\n'), feed);
	assert.ok(!feed.includes("if (site?.url)"), "an if that only sets names prints nothing, so it is left out");
	assert.ok(feed.includes('\tconst label = fr ? "Fin" : ctx.label;\n'), feed);
});

// Inside a loop, a name a branch leaves alone keeps the previous iteration's value (the loop's frame persists). Each
// run's value is computed before the loop from the items (versions.mts); a chain that reads a name the loop body
// sets cannot be, and is reported.
test("chain-in-a-loop-without-an-else-keeps-the-last-run", async () => {
	const ok = await site("chain-loop-no-else", { "page.html": "{% for i in xs %}{% if i.t %}{% set t = i.t %}{% endif %}<p>{{ t }}</p>{% endfor %}" });
	assert.deepEqual(constructs(ok.items), []);
	assert.match(ok.files.get("src/templates/page.astro") ?? "", /const t__runs1 = nj\.iterate\(xs\)\.reduce\(/);
	const { items } = await site("chain-loop-local", { "page.html": "{% for i in xs %}{% set k = i.t %}{% if k %}{% set t = k %}{% endif %}<p>{{ t }}</p>{% endfor %}" });
	assert.deepEqual(constructs(items), ["set"]);
});

test("name-set-by-two-chains-is-one-value-per-chain", async () => {
	const { files, items } = await site("two-chains", {
		"page.html": "{% if a %}{% set x = 1 %}{% else %}{% set x = 2 %}{% endif %}<p>{{ x }}</p>{% if b %}{% set x = 3 %}{% else %}{% set x = 4 %}{% endif %}<p>{{ x }}</p>",
	});
	assert.deepEqual(constructs(items), []);
	assert.match(files.get("src/templates/page.astro") ?? "", /const x = a \? 1 : 2;\nconst x__2 = b \? 3 : 4;/);
});

// Where no branch sets it, the name keeps the value set before the chain
test("set-before-a-chain-that-sets-it-again-keeps-it-where-no-branch-runs", async () => {
	const { files, items } = await site("set-then-chain", { "page.html": "{% set x = 0 %}{% if a %}{% set x = 1 %}{% endif %}<p>{{ x }}</p>" });
	assert.deepEqual(constructs(items), []);
	assert.match(files.get("src/templates/page.astro") ?? "", /const x = 0;\nconst x__2 = a \? 1 : x;/);
});

test("chain-read-in-a-branch-before-its-set-is-reported", async () => {
	const { items } = await site("chain-read-early", { "page.html": "{% if a %}<i>{{ x }}</i>{% set x = 1 %}{% else %}{% set x = 2 %}{% endif %}<p>{{ x }}</p>" });
	assert.deepEqual(constructs(items), ["set", "set"]);
});

test("chain-read-in-a-later-condition-is-reported", async () => {
	const { items } = await site("chain-read-cond", { "page.html": "{% if a %}{% set x = 1 %}{% elif x %}{% set x = 2 %}{% else %}{% set x = 3 %}{% endif %}<p>{{ x }}</p>" });
	assert.deepEqual(constructs(items), ["set", "set", "set"]);
});

// The carried values are worked out before the loop runs, which is right only when computing them changes nothing:
// a chain that calls anything (a joiner) keeps its report item
test("a carried value whose chain calls anything is reported", async () => {
	const { items } = await site("carried-call", {
		"page.html": '{% set j = joiner(",") %}{% for i in [false, true] %}{% if i %}{% set t = j() %}{% endif %}[{{ t }}|{{ j() }}]{% endfor %}',
	});
	assert.ok(constructs(items).includes("set"), JSON.stringify(items));
});

// A counter becomes c + loop.index0 * d only when that is what Nunjucks prints: it starts at a number, and nothing
// after the loop reads the last count, an included template included
test("a counter that starts as text, or that a later include reads, is reported", async () => {
	const text = await site("counter-text", { "page.html": '{% set c = "1" %}{% for x in xs %}<i>{{ c }}</i>{% set c = c + 1 %}{% endfor %}' });
	assert.ok(constructs(text.items).includes("set"), JSON.stringify(text.items));
	const footer = await site("counter-footer", {
		"footer.html": "<p>{{ c }}</p>",
		"page.html": '{% set c = 1 %}{% for x in xs %}<i>{{ c }}</i>{% set c = c + 1 %}{% endfor %}{% include "footer.html" %}',
	});
	assert.ok(constructs(footer.items).includes("set"), JSON.stringify(footer.items));
});

// Imports and macro definitions bind at the template's top level only (scope.mts), so one inside an if, a loop or a
// block is reported: `{% if show %}{% from "m.html" import card %}{{ card("A") }}{% endif %}` printed nothing
test("a macro import or definition inside another tag is reported unless it repeats a top-level import", async () => {
	const m = '{% macro card(t) %}<b>{{ t }}</b>{% endmacro %}';
	const nested = await site("nested-import", { "m.html": m, "page.html": '{% if show %}{% from "m.html" import card %}{{ card("A") }}{% endif %}' });
	assert.ok(constructs(nested.items).includes("from"), JSON.stringify(nested.items));
	const defined = await site("nested-macro", { "page.html": '{% if show %}{% macro badge(t) %}<i>{{ t }}</i>{% endmacro %}{{ badge("B") }}{% endif %}' });
	assert.ok(constructs(defined.items).includes("macro"), JSON.stringify(defined.items));
	const named = await site("nested-namespace", { "m.html": m, "page.html": '{% for x in xs %}{% import "m.html" as ui %}{{ ui.card(x) }}{% endfor %}' });
	assert.ok(constructs(named.items).includes("import"), JSON.stringify(named.items));
	// A page that imports the same macro again inside its content block: nothing changes
	const again = await site("nested-repeat", { "m.html": m, "page.html": '{% from "m.html" import card %}{% if show %}{% from "m.html" import card %}{{ card("A") }}{% endif %}' });
	assert.deepEqual(constructs(again.items), []);
});

// Whether a macro is nested comes from the parse tree, not from how deep the emitter is: a set read before and after it
// wraps the rest of the template in a function, and a child template's block body starts at the top
test("a top-level macro after a wrapping set is fine, and one in a child template's block is reported", async () => {
	const wrapped = await site("macro-after-wrap", { "page.html": '<p>{{ x }}</p>{% set x = 2 %}{% macro m() %}hi{% endmacro %}<p>{{ m() }} {{ x }}</p>' });
	assert.ok(!constructs(wrapped.items).includes("macro"), JSON.stringify(wrapped.items));
	const inBlock = await site("macro-in-child-block", {
		"layout.html": "<html><body>{% block content %}{% endblock %}</body></html>",
		"page.html": '{% extends "layout.html" %}{% block content %}{% macro m() %}hi{% endmacro %}<p>{{ m() }}</p>{% endblock %}',
	});
	assert.ok(constructs(inBlock.items).includes("macro"), JSON.stringify(inBlock.items));
	// An import there too: the block's body starts at the emitter's top, though the import is not the template's
	const importInBlock = await site("import-in-child-block", {
		"m.html": "{% macro card(t) %}<b>{{ t }}</b>{% endmacro %}",
		"layout.html": "<html><body>{% block content %}{% endblock %}</body></html>",
		"page.html": '{% extends "layout.html" %}{% block content %}{% from "m.html" import card %}<p>{{ card("A") }}</p>{% endblock %}',
	});
	assert.ok(constructs(importInBlock.items).includes("from"), JSON.stringify(importInBlock.items));
});

// A hand-built CDN URL in a style or a script prints unescaped: CSS and JavaScript read &amp; as it stands, so the
// endpoint would have got "amp;h" for h
test("a rewritten CDN URL in a style or a script prints without HTML escaping", async () => {
	const r = await site("cdn-in-style", { "page.html": "<style>.hero { background: url(https://images.takeshape.io/{{ p.path }}?w=300&h=200); }</style><script>var u = 'https://images.takeshape.io/{{ p.path }}?w=10';</script>" });
	assert.deepEqual(constructs(r.items), []);
	const page = r.files.get("src/templates/page.astro") ?? "";
	assert.ok(page.includes('${nj.text(ts.image(p?.path, { w: "300", h: "200" }, false))}'), page);
	assert.ok(page.includes('${nj.text(ts.image(p?.path, { w: "10" }, false))}'), page);
	assert.ok(!page.includes("nj.escape(ts.image"), page);
});

// A name set in the branches of an if chain becomes one value with the chain's conditions, and the markup runs the
// same conditions again: a condition that calls a function (a joiner) can answer differently the second time
test("a set in an if chain whose conditions call a function is reported", async () => {
	const stateful = await site("chain-call", { "page.html": '{% set j = joiner(",") %}<p>{{ x }}</p>{% if j() %}{% set x = "yes" %}<b>{{ x }}</b>{% else %}{% set x = "no" %}<i>{{ x }}</i>{% endif %}' });
	assert.ok(constructs(stateful.items).includes("set"), JSON.stringify(stateful.items));
	const top = await site("chain-call-top", { "page.html": '{% set j = joiner(",") %}{% if j() %}{% set x = "yes" %}{% else %}{% set x = "no" %}{% endif %}<p>{{ x }}</p>' });
	assert.ok(constructs(top.items).includes("set"), JSON.stringify(top.items));
	// A condition with filters and lookups only stays translated
	const plain = await site("chain-plain", { "page.html": '{% if items | length > 1 %}{% set x = "many" %}{% else %}{% set x = "few" %}{% endif %}<p>{{ x }}</p>' });
	assert.deepEqual(constructs(plain.items), []);
});

// concat on a string joins text: the list idiom's flatMap printed "".concat(["a", "b"]) as "a,b" where Nunjucks printed "ab"
test("a value built with concat that starts as text is reported", async () => {
	const text = await site("concat-text", { "page.html": '{% set s = "" %}{% for x in xs %}{% set s = s.concat(x) %}{% endfor %}<p>{{ s }}</p>' });
	assert.ok(constructs(text.items).includes("set"), JSON.stringify(text.items));
	assert.ok(!(text.files.get("src/templates/page.astro") ?? "").includes("flatMap"));
	const list = await site("concat-list", { "page.html": '{% set s = [] %}{% for x in xs %}{% set s = s.concat(x) %}{% endfor %}<p>{{ s }}</p>' });
	assert.deepEqual(constructs(list.items), []);
});

// Each set after the first gets a name of its own, and each read the one set last before it (versions.mts)
test("set-twice-gives-each-read-the-set-before-it", async () => {
	const { files, items } = await site("set-twice", { "page.html": "{% set x = 1 %}<p>{{ x }}</p>{% set x = 2 %}<p>{{ x }}</p>" });
	assert.deepEqual(constructs(items), []);
	const page = files.get("src/templates/page.astro") ?? "";
	assert.match(page, /const x = 1;\nconst x__2 = 2;/);
	assert.match(page, /<p>\{nj\.text\(x\)\}<\/p><p>\{nj\.text\(x__2\)\}<\/p>/);
});

test("loop-accumulator-is-reported", async () => {
	const { items } = await site("accumulate", { "page.html": "{% set t = 0 %}{% for i in xs %}{% set t = t + i %}{% endfor %}<p>{{ t }}</p>" });
	assert.deepEqual(constructs(items), ["set", "set"]);
});

// A loop between attributes sends the start tag out as the text Nunjucks printed; one inside a value is part of it
test("for-inside-a-tag-is-raw-html-or-part-of-the-value", async () => {
	const between = await site("for-in-tag", { "page.html": '<a {% for c in cs %}data-{{ c }}="1" {% endfor %}href="/">x</a>' });
	assert.deepEqual(constructs(between.items), []);
	assert.match(between.files.get("src/templates/page.astro") ?? "", /<Fragment set:html=\{`<a \$\{nj\.iterate\(cs\)\.map\(/);
	const inValue = await site("for-in-value", { "page.html": '<a data-x="{% for c in cs %}{{ c }}{% endfor %}" href="/">x</a>' });
	assert.deepEqual(constructs(inValue.items), []);
	assert.match(inValue.files.get("src/templates/page.astro") ?? "", /<a data-x=\{nj\.iterate\(cs\)\.map\(/);
});

test("include-inside-a-tag-is-reported", async () => {
	const { items } = await site("include-in-tag", { "page.html": '<a {% include "attrs.html" %}>x</a>', "attrs.html": 'class="a"' });
	assert.deepEqual(constructs(items), ["include"]);
});

test("set-inside-a-tag-that-moves-to-the-frontmatter-is-translated", async () => {
	const { items, files } = await site("set-in-tag", { "page.html": '<a {% set c = "on" %}class="{{ c }}">x</a>' });
	assert.deepEqual(items, []);
	assert.match(files.get("src/templates/page.astro")!, /const c = "on";/);
});

// The macros differential case (test/tsg/cases/macros) checks the output against Nunjucks; this, the files
test("a macro becomes a function in the template's macro module, which the template imports", async () => {
	const { files, items } = await site("macro", { "page.html": "{% macro m(x) %}<b>{{ x }}</b>{% endmacro %}<p>{{ m('hi') }}</p>" });
	assert.deepEqual(constructs(items), []);
	assert.match(files.get("src/templates/page.macros.ts") ?? "", /export function m\(x\?: any\): nj\.SafeHtml \{/);
	const page = files.get("src/templates/page.astro") ?? "";
	assert.match(page, /import \{ m \} from "\.\/page\.macros\.ts";/);
	assert.match(page, /<p><Fragment set:html=\{nj\.text\(m\("hi"\)\)\} \/><\/p>/);
});

// Each macro's render helper gets a name no export, import or other helper has: card's would be renderCard
test("a macro module declares each name once", async () => {
	const { files } = await site("macro-helper-names", {
		"lib.html": "{% macro card(v) %}<b>{{ v }}</b>{% endmacro %}{% macro renderCard(v) %}<i>{{ v }}</i>{% endmacro %}{% macro Card(v) %}<u>{{ v }}</u>{% endmacro %}",
		"page.html": '{% from "lib.html" import card, renderCard, Card %}<p>{{ card("a") }}{{ renderCard("b") }}{{ Card("c") }}</p>',
	});
	const names = [...(files.get("src/templates/lib.macros.ts") ?? "").matchAll(/function (\w+)\(/g)].map((m) => m[1]);
	assert.equal(new Set(names).size, names.length, names.join(", "));
});

// A macro is exported under its JavaScript name (class$ for class), and a call through a namespace uses that name
test("a namespace call uses the name the macro is exported under", async () => {
	const { files, items } = await site("namespace-js-name", {
		"lib.html": "{% macro class(v) %}<b>{{ v }}</b>{% endmacro %}",
		"page.html": '{% import "lib.html" as m %}<p>{{ m.class("x") }}</p>',
	});
	assert.deepEqual(constructs(items), []);
	const exported = /export function (\S+)\(/.exec(files.get("src/templates/lib.macros.ts") ?? "")?.[1];
	assert.ok(exported && exported !== "class", files.get("src/templates/lib.macros.ts"));
	assert.ok((files.get("src/templates/page.astro") ?? "").includes(`m.${exported}("x")`), files.get("src/templates/page.astro"));
});

// Nunjucks exports a template's top-level sets too; only macros are translated, so the rest is reported, not imported
test("an import of names that are no macros is reported and binds an empty value", async () => {
	const { files, items } = await site("import-sets", {
		"lib.html": '{% set label = "Hello" %}',
		"page.html": '{% import "lib.html" as m %}{% from "lib.html" import label %}<p>{{ m.label }} {{ label }}</p>',
	});
	assert.deepEqual(constructs(items), ["label", "m"]);
	const page = files.get("src/templates/page.astro") ?? "";
	assert.ok(!page.includes("lib.macros.ts"), page);
	assert.ok(!files.has("src/templates/lib.macros.ts"));
	assert.match(page, /const m: any = \{\};/);
	assert.match(page, /const label: any = undefined;/);
});

// A Nunjucks macro reads its template's context: its top-level sets, and the page's context when the page calls it
test("a macro that reads its template's context is reported", async () => {
	const { items } = await site("macro-context", {
		"lib.html": "{% macro shout(x) %}{{ x }}{{ outside }}{% endmacro %}",
		"page.html": '{% from "lib.html" import shout %}{% set prefix = "Hi" %}{% macro greet(name, by=sender) %}{{ prefix }} {{ name }} {{ by }}{% endmacro %}<p>{{ greet("Ann") }} {{ shout("y") }}</p>',
	});
	// lib.html is only imported, so shout's `outside` was empty in Nunjucks too
	assert.deepEqual(constructs(items), ["prefix", "sender"]);
	assert.match(items.find((i) => i.construct === "prefix")!.message, /The macro "greet" reads "prefix" from its template's context/);
});

test("block-reading-a-layout-set-is-reported", async () => {
	const { items } = await site(
		"layout-set",
		{
			"layout.html": '{% set theme = "dark" %}<html><body>{% block content %}{% endblock %}</body></html>',
			"page.html": '{% extends "layout.html" %}{% block content %}<p>{{ theme }}</p>{% endblock %}',
		},
	);
	assert.deepEqual(constructs(items), ["block"]);
});

test("block-skipping-a-middle-layout-is-reported", async () => {
	const { items } = await site("three-levels", {
		"base.html": "<html><head><title>{% block title %}Base{% endblock %}</title></head><body>{% block content %}{% endblock %}</body></html>",
		"middle.html": '{% extends "base.html" %}{% block content %}<main>{% block main %}{% endblock %}</main>{% endblock %}',
		"page.html": '{% extends "middle.html" %}{% block title %}Page{% endblock %}',
	});
	assert.deepEqual(constructs(items), ["block"]);
});

// The block-in-attribute differential cases check the output against Nunjucks; this, the files and what stays reported
test("a block inside a tag is text the page gives its layout; one holding a loop is reported", async () => {
	const layout = '<html><body class="{% block bodyClass %}{% endblock %}">{% block content %}{% endblock %}</body></html>';
	const ok = await site("block-in-tag", { "layout.html": layout, "page.html": '{% extends "layout.html" %}{% block bodyClass %}home{% endblock %}{% block content %}<p>x</p>{% endblock %}' });
	assert.deepEqual(constructs(ok.items), []);
	assert.match(ok.files.get("src/templates/page.astro") ?? "", /\$blocks=\{\{ "bodyClass": `home`, \.\.\.Astro\.props\.\$blocks \}\}/);
	// The text comes escaped, as Nunjucks printed it, and Astro escapes an attribute: it goes in decoded
	assert.match(ok.files.get("src/templates/layout.astro") ?? "", /class=\{\(nj\.unescapeHtml\(Astro\.props\.\$blocks\?\.\["bodyClass"\]\) \?\? ""\)\}/);
	// An if chain becomes a condition in the text
	const cond = await site("block-in-tag-if", { "layout.html": layout, "page.html": '{% extends "layout.html" %}{% block bodyClass %}{% if x %}home{% endif %}{% endblock %}{% block content %}<p>x</p>{% endblock %}' });
	assert.deepEqual(constructs(cond.items), []);
	assert.match(cond.files.get("src/templates/page.astro") ?? "", /"bodyClass": `\$\{x \? `home` : ""\}`/);
	const bad = await site("block-in-tag-for", { "layout.html": layout, "page.html": '{% extends "layout.html" %}{% block bodyClass %}{% for c in cs %}{{ c }}{% endfor %}{% endblock %}{% block content %}<p>x</p>{% endblock %}' });
	assert.ok(constructs(bad.items).includes("block"));
});

// The layout prints a block in an attribute as an Astro attribute, which escapes the page's text, where Nunjucks printed
// the override's own text raw: a quote there, or a `| safe` output, ended the attribute and started another
test("a block override that could end the layout's attribute is reported", async () => {
	const layout = '<html><body class="{% block cls %}{% endblock %}">{% block content %}{% endblock %}</body></html>';
	const page = (cls: string) => `{% extends "layout.html" %}{% block cls %}${cls}{% endblock %}{% block content %}<p>x</p>{% endblock %}`;
	const quote = await site("block-attr-quote", { "layout.html": layout, "page.html": page('x" data-mode="wide') });
	assert.ok(constructs(quote.items).includes("block"), JSON.stringify(quote.items));
	const safe = await site("block-attr-safe", { "layout.html": layout, "page.html": page("{{ cls | safe }}") });
	assert.ok(constructs(safe.items).includes("block"), JSON.stringify(safe.items));
	// A macro's result prints as it stands too (a SafeString)
	const macro = await site("block-attr-macro", { "layout.html": layout, "page.html": `{% macro m() %}x" data-mode="wide{% endmacro %}${page("{{ m() }}")}` });
	assert.ok(constructs(macro.items).includes("block"), JSON.stringify(macro.items));
	// Plain text and escaped outputs stay in the attribute in both
	const plain = await site("block-attr-plain", { "layout.html": layout, "page.html": page("body--page {{ extra }}") });
	assert.deepEqual(constructs(plain.items), []);
});

// Only a start tag's block reaches the layout as text; one in a script, a style or a comment kept the layout's text,
// and the page's override went nowhere without a word
test("a block inside a script, a style or a comment is reported", async () => {
	for (const [name, inside] of [
		["script", '<script>var config = "{% block config %}old{% endblock %}";</script>'],
		["style", "<style>body { color: {% block config %}red{% endblock %}; }</style>"],
		["comment", "<!-- {% block config %}old{% endblock %} -->"],
	] as const) {
		const layout = `<html><body>${inside}{% block content %}{% endblock %}</body></html>`;
		const r = await site(`block-in-${name}`, { "layout.html": layout, "page.html": '{% extends "layout.html" %}{% block config %}new{% endblock %}{% block content %}<p>x</p>{% endblock %}' });
		assert.ok(constructs(r.items).includes("block"), `${name}: ${JSON.stringify(r.items)}`);
	}
});

test("super-is-reported", async () => {
	const { items } = await site("super", {
		"layout.html": "<html><body>{% block content %}<p>base</p>{% endblock %}</body></html>",
		"page.html": '{% extends "layout.html" %}{% block content %}{{ super() }}<p>more</p>{% endblock %}',
	});
	assert.deepEqual(constructs(items), ["super()"]);
});

test("safe-inside-an-attribute-becomes-raw-html", async () => {
	const { items, files } = await site("safe-attr", { "page.html": '<a title="{{ t | safe }}" href="/">x</a>' });
	assert.deepEqual(items, []);
	const page = files.get("src/templates/page.astro")!;
	assert.ok(page.includes("<Fragment set:html={`<a title=\"${nj.text(t)}\" href=\"/\">`} />"));
	assert.ok(page.includes("<Fragment set:html={`</a>`} />"));
});

test("an attribute name with a non-breaking space keeps its bytes as raw HTML", async () => {
	// An embed code pasted with `src="..."\u00a0scrolling="no"`: HTML reads "\u00a0scrolling" as one attribute name, which
	// browsers ignore; Astro's compiler reads the NBSP as a space and printed a real scrolling="no".
	const { items, files } = await site("nbsp-attr", { "page.html": '<iframe src="/x"\u00a0scrolling="no" width="100%"></iframe>' });
	assert.deepEqual(items, []);
	const page = files.get("src/templates/page.astro")!;
	assert.ok(page.includes('<Fragment set:html={`<iframe src="/x"\u00a0scrolling="no" width="100%">`} />'), page);
	assert.ok(page.includes("<Fragment set:html={`</iframe>`} />"), page);
});

test("unbalanced-markup-is-raw-only-where-needed", async () => {
	const { files } = await site("balance", { "page.html": "<ul><li>one<li>two</ul><div><p>ok</p></div></section>" });
	const page = files.get("src/templates/page.astro")!;
	assert.ok(page.includes("<ul><Fragment set:html={`<li>`} />one<Fragment set:html={`<li>`} />two</ul>"));
	assert.ok(page.includes("<div><p>ok</p></div><Fragment set:html={`</section>`} />"));
});

// A child's block runs in the layout's frame at the call site, so it sees more than the layout's props.
test("block-reading-a-grandparent-set-is-reported", async () => {
	const { items } = await site("grandparent-set", {
		"base.html": '{% set x = "from base" %}<html><body><main>{% block content %}{% endblock %}</main></body></html>',
		"middle.html": '{% extends "base.html" %}{% block content %}<div>{% block inner %}{% endblock %}</div>{% endblock %}',
		"page.html": '{% extends "middle.html" %}{% block inner %}<p>{{ x }}</p>{% endblock %}',
	});
	assert.deepEqual(constructs(items), ["block"]);
});

test("block-reading-a-loop-variable-around-its-call-is-reported", async () => {
	const { items } = await site("loop-around-block", {
		"base.html": "<html><body>{% for item in nav %}{% block navitem %}<b>{{ item.title }}</b>{% endblock %}{% endfor %}</body></html>",
		"page.html": '{% extends "base.html" %}{% block navitem %}<a>{{ item.title }} {{ loop.index }}</a>{% endblock %}',
	});
	assert.deepEqual(constructs(items), ["block"]);
});

test("block-reading-a-middle-block-set-is-reported", async () => {
	const { items } = await site("middle-block-set", {
		"base.html": "<html><body>{% block content %}{% endblock %}</body></html>",
		"middle.html": '{% extends "base.html" %}{% block content %}{% set y = 1 %}<div>{% block inner %}{% endblock %}</div>{% endblock %}',
		"page.html": '{% extends "middle.html" %}{% block inner %}<p>{{ y }}</p>{% endblock %}',
	});
	assert.deepEqual(constructs(items), ["block"]);
});

test("block-reading-only-props-is-not-reported", async () => {
	const { items } = await site("block-props-only", {
		"base.html": '{% set x = 1 %}<html><body>{% for item in nav %}<i>{{ item }}</i>{% endfor %}{% block content %}{% endblock %}</body></html>',
		"page.html": '{% extends "base.html" %}{% block content %}<p>{{ page.title }}</p>{% endblock %}',
	});
	assert.deepEqual(items, []);
});

// Nunjucks's Frame.resolve stops honoring isolateWrites after the first hop, so a set in a loop inside an include or
// a block writes into the includer's (or the layout's) variable of the same name.
test("include-loop-set-writing-into-the-includer-is-reported", async () => {
	const { items } = await site("include-write-through", {
		"page.html": '{% set label = "Books" %}<h1>{{ label }}</h1>{% include "list.html" %}<p>after: {{ label }}</p>',
		"list.html": "<ul>{% for b in books %}{% set label = b.title %}<li>{{ label }}</li>{% endfor %}</ul>",
	});
	assert.deepEqual(constructs(items), ["include"]);
});

test("include-loop-set-of-an-unbound-name-is-translated", async () => {
	const { items } = await site("include-no-write-through", {
		"page.html": '<h1>{{ label }}</h1>{% include "list.html" %}',
		"list.html": "<ul>{% for b in books %}{% set label = b.title %}<li>{{ label }}</li>{% endfor %}</ul>",
	});
	assert.deepEqual(items, []);
});

test("block-loop-set-writing-into-the-layout-is-reported", async () => {
	const { items } = await site("block-write-through", {
		"base.html": '{% set label = "base" %}<html><body>{% block content %}{% endblock %}<p>{{ label }}</p></body></html>',
		"page.html": '{% extends "base.html" %}{% block content %}{% for b in books %}{% set label = b.title %}<i>{{ label }}</i>{% endfor %}{% endblock %}',
	});
	assert.deepEqual(constructs(items), ["block"]);
});

test("extends-inside-an-if-is-reported", async () => {
	const { items } = await site("conditional-extends", {
		"page.html": '{% if wrap %}{% extends "base.html" %}{% endif %}{% block content %}<p>child</p>{% endblock %}',
		"base.html": "<html><body><main>{% block content %}{% endblock %}</main></body></html>",
	});
	assert.deepEqual(constructs(items), ["extends"]);
});

test("partial-shared-by-a-text-and-an-html-template-is-reported", async () => {
	const root = join(work, "mixed-kinds");
	for (const [path, text] of Object.entries({ "page.html": '<p>{{ x }}</p>{% include "item.html" %}', "feed.xml": '<feed>{% include "item.html" %}</feed>', "item.html": "<entry>{{ x }}</entry>" })) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	const { items } = await emitAll(root, [{ name: "page.html", kind: "html" }, { name: "feed.xml", kind: "text" }]);
	assert.deepEqual(constructs(items), ["include"]);
});

test("bogus-markup-is-raw-html-that-compiles", async () => {
	const { items, files } = await site("bogus", { "page.html": "<p>a </ b> c</p><p>x </3> y</p><p></> <!x bogus></p><{{ tag }}>dyn</{{ tag }}><p>if a<{{ n }}</p>" });
	assert.deepEqual(items, []);
	const page = files.get("src/templates/page.astro")!;
	for (const raw of ["</ b>", "</3>", "</>", "<!x bogus>"]) assert.ok(page.includes(`<Fragment set:html={\`${raw}\`} />`), raw);
	assert.ok(page.includes("<Fragment set:html={`<`} />{nj.text(tag)}>dyn<Fragment set:html={`</`} />{nj.text(tag)}>"));
	assert.ok(page.includes("<p>if a<Fragment set:html={`<`} />{nj.text(n)}</p>"));
});

test("sets-in-sibling-loops-are-translated", async () => {
	const { items } = await site("sibling-loops", { "page.html": "<ul>{% for a in as %}{% set label = a.name %}<li>{{ label }}</li>{% endfor %}</ul><ul>{% for b in bs %}{% set label = b.name %}<li>{{ label }}</li>{% endfor %}</ul>" });
	assert.deepEqual(items, []);
});

test("recursive-include-does-not-depend-on-emit-order", async () => {
	const root = join(here, "cases", "recursive-include");
	const emitIn = async (order: string[]) => {
		const report = new Report();
		const templates = await loadTemplates(root, config, [{ name: "page.html", kind: "html" }], report);
		const out = new Map<string, string>();
		for (const name of order) out.set(name, emitAstroComponent(templates.get(name)!, templates, report).source);
		return out;
	};
	const a = await emitIn(["node.html", "menu.html", "page.html"]);
	const b = await emitIn(["page.html", "menu.html", "node.html"]);
	for (const name of a.keys()) assert.equal(a.get(name), b.get(name), name);
	// the recursive call sits in its own loop, so it gets that loop's `loop`
	assert.ok(a.get("node.html")!.includes("const loop = nj.loop(i, all.len); return (<><Node {...Astro.props} loop={loop} node={node} />"));
});

// A layout's root render runs on the child's frame and a block runs on its caller's frame, so a layout's set or loop
// variable wins over a child's top-level set of the same name.
test("block-reading-a-name-the-layout-sets-over-the-child-is-reported", async () => {
	const { items } = await site("layout-set-over-child", {
		"page.html": '{% extends "base.html" %}{% set x = "leaf" %}{% block content %}<p>{{ x }}</p>{% endblock %}',
		"base.html": '{% set x = "base" %}<main>{% block content %}{% endblock %}</main>',
	});
	assert.deepEqual(constructs(items), ["block"]);
});

test("layout-set-after-the-block-call-is-not-reported", async () => {
	const { items } = await site("layout-set-after-block", {
		"page.html": '{% extends "base.html" %}{% set x = "leaf" %}{% block content %}<p>{{ x }}</p>{% endblock %}',
		"base.html": '<main>{% block content %}{% endblock %}</main>{% set x = "base" %}<i>{{ x }}</i>',
	});
	assert.deepEqual(items, []);
});

test("block-reading-a-layout-loop-variable-over-a-child-set-is-reported", async () => {
	const { items } = await site("layout-loop-over-child", {
		"page.html": '{% extends "base.html" %}{% set item = "leaf" %}{% block navitem %}<a>{{ item }}</a>{% endblock %}',
		"base.html": "<nav>{% for item in nav %}{% block navitem %}<b>{{ item }}</b>{% endblock %}{% endfor %}</nav>",
	});
	assert.deepEqual(constructs(items), ["block"]);
});

test("block-loop-set-writing-into-a-child-top-level-set-is-reported", async () => {
	const { items } = await site("block-write-into-child", {
		"page.html":
			'{% extends "base.html" %}{% set label = "top" %}{% block a %}{% for b in bs %}{% set label = b %}<i>{{ label }}</i>{% endfor %}{% endblock %}{% block c %}<p>{{ label }}</p>{% endblock %}',
		"base.html": "<main>{% block a %}{% endblock %}{% block c %}{% endblock %}</main>",
	});
	assert.deepEqual(constructs(items), ["block"]);
});

test("text-template-inlines-a-partial-without-nunjucks", async () => {
	const root = join(here, "cases", "text-includes-plain-partial");
	const { files, items } = await emitAll(root, [{ name: "feed.xml", kind: "text" }]);
	assert.deepEqual(items, []);
	const feed = files.get("src/templates/feed.xml.ts")!;
	assert.ok(!feed.includes(".astro"), feed);
	assert.ok(feed.includes("static & plain \\`\\${not js}\\`"), feed);
});
