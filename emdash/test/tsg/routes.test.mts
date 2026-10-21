/**
 * Route planning (tsg2astro/routes.mts) and the page rules the generated route modules run
 * (tsg2astro/runtime/context.ts), checked against takeshape-ssg's behavior as read in its
 * generate, streams, context and paths modules.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadTsgConfig } from "../../tsg2astro/config.mts";
import type { TsgConfig } from "../../tsg2astro/config.mts";
import { DataFiles, emitGlobalModule, emitPage, emitSiteModule, momentLocaleFile } from "../../tsg2astro/emit-routes.mts";
import { Report } from "../../tsg2astro/report.mts";
import { astroFile, isNotFoundRoute, pageFiles, planRoutes, reservedRoute, urlsOverlap } from "../../tsg2astro/routes.mts";
import {
	answer,
	findPage,
	indexFileTarget,
	isPageUrl,
	itemContext,
	itemPages,
	itemPath,
	itemPick,
	listingContext,
	listingPages,
	listingPick,
	loading,
	pageContext,
	pageUrl,
} from "../../tsg2astro/runtime/context.ts";
import { configure } from "../../tsg2astro/runtime/filters.ts";
import type { Template } from "../../tsg2astro/templates.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const books = join(root, "test", "tsg", "sites", "shape-books", "site");

configure({ routes: {}, pathPrefix: "", imageDefaults: {}, dates: { tz: "UTC", format: "LLL" }, locale: "en", mediaPath: "/m" });

function config(routes: TsgConfig["routes"]): TsgConfig {
	return {
		templatePath: "templates",
		staticPath: "static",
		buildPath: "build",
		context: {},
		routes,
		locale: "en-us",
		dates: { tz: "America/New_York", format: "LLL" },
		numbers: { format: "," },
		pathPrefix: "",
		imageBaseUrl: "",
		assetBaseUrl: "",
		imageDefaults: {},
		gzip: false,
		env: {},
	};
}

// ---------------------------------------------------------------------------
// planRoutes
// ---------------------------------------------------------------------------

test("plans the books starter's seven route parts", async () => {
	const report = new Report();
	const plans = planRoutes(await loadTsgConfig(books, {}), report);
	assert.deepEqual(plans, [
		{ name: "sitemap", part: "page", tsgPath: "/sitemap.xml", file: "src/pages/sitemap.xml.ts", params: [], template: "feeds/sitemap.xml", output: "text", contentType: "application/xml" },
		{ name: "homepage", part: "page", tsgPath: "/", file: "src/pages/index.astro", params: [], template: "pages/homepage.html", output: "html", contentType: null },
		{ name: "posts", part: "items", tsgPath: "/blog/:title/", file: "src/pages/blog/[title].astro", params: ["title"], template: "pages/posts/individual.html", output: "html", contentType: null },
		{ name: "posts", part: "listing", tsgPath: "/blog/page-:num/", file: "src/pages/blog/page-[num].astro", params: ["num"], template: "pages/posts/landing.html", output: "html", contentType: null },
		{ name: "posts", part: "firstPage", tsgPath: "/blog/", file: "src/pages/blog/index.astro", params: [], template: "pages/posts/landing.html", output: "html", contentType: null },
		{ name: "books", part: "items", tsgPath: "/books/:title/", file: "src/pages/books/[title].astro", params: ["title"], template: "pages/book.html", output: "html", contentType: null },
		{ name: "authors", part: "items", tsgPath: "/authors/:name/", file: "src/pages/authors/[name].astro", params: ["name"], template: "pages/author.html", output: "html", contentType: null },
	]);
	assert.deepEqual(report.items(), []);
});

test("file names follow the URL", () => {
	const report = new Report();
	const plans = planRoutes(
		config({
			about: { path: "/about", template: "a.html" },
			team: { path: "/team/", template: "a.html" },
			feed: { path: "/feed.json", template: "feed.json" },
			plainText: { path: "/notes/", template: "notes.txt" },
			people: { path: "/people/{author.name}/:id-:slug", template: "p.html", paginate: { data: "q.graphql" } },
		}),
		report,
	);
	const files = plans.map((p) => [p.file, p.params, p.output, p.contentType]);
	assert.deepEqual(files, [
		["src/pages/about.astro", [], "html", null],
		["src/pages/team/index.astro", [], "html", null],
		["src/pages/feed.json.ts", [], "text", "application/json"],
		// takeshape-ssg wrote notes/index.html, which the old host served as HTML
		["src/pages/notes/index.ts", [], "text", "text/html"],
		["src/pages/people/[author_name]/[id]-[slug].astro", ["author_name", "id", "slug"], "html", null],
	]);
	assert.deepEqual(report.items(), []);
});

test("the routes Astro keeps for itself: /404, /500 and /3xx, with or without the slash", () => {
	const file = (path: string) => astroFile(path, "html").file;
	assert.ok(isNotFoundRoute(file("/404")) && isNotFoundRoute(file("/404/")));
	assert.deepEqual(["/500", "/500/", "/3xx", "/3xx/"].map((p) => reservedRoute(file(p))), ["500", "500", "3xx", "3xx"]);
	// Other paths are ordinary pages, a variable segment included
	for (const p of ["/500.html", "/500/x/", "/errors/500/", "/:code/", "/3xx.html", "/5000/"]) assert.equal(reservedRoute(file(p)), null, p);
	assert.equal(reservedRoute(astroFile("/500/", "text").file), "500");
});

test("a path with .. or . segments resolves inside src/pages, and template names are normalized", () => {
	const report = new Report();
	const plans = planRoutes(
		config({
			up: { path: "/a/../b/", template: "./pages/../a.html" },
			past: { path: "/../../../x/", template: "a.html" },
			dot: { path: "/./c/./d.xml", template: "feeds/d.xml" },
		}),
		report,
	);
	assert.deepEqual(
		plans.map((p) => [p.file, p.template]),
		[
			["src/pages/b/index.astro", "a.html"],
			["src/pages/x/index.astro", "a.html"],
			["src/pages/c/d.xml.ts", "feeds/d.xml"],
		],
	);
	assert.deepEqual(astroFile("/../../{a}/../:b", "html"), { file: "src/pages/[b].astro", params: ["b"] });
});

test("reports what it cannot route", () => {
	const report = new Report();
	const plans = planRoutes(
		config({
			byProperty: { path: "/p/:name/", template: "p.html", paginate: { property: "people", itemName: "person" } },
			noData: { path: "/n/:name/", template: "n.html", paginate: { pageSize: 2 } },
			literal: { path: "/people/{author.name}/", template: "p.html" },
			noTemplate: { path: "/x/" },
			htmlAsXml: { path: "/feed.xml", template: "feed.html" },
			first: { path: "/a/:slug/", template: "a.html", paginate: { data: "a.graphql" } },
			textSameUrls: { path: "/a/:id", template: "a.txt", paginate: { data: "t.graphql" } },
		}),
		report,
	);
	assert.deepEqual(
		plans.map((p) => p.name),
		["first"],
	);
	const items = report.items().map((i) => [i.kind, i.construct, i.message]);
	assert.equal(items.length, 6, JSON.stringify(items, null, 1));
	const byConstruct = new Map(items.map(([kind, construct, message]) => [construct, { kind, message }]));
	assert.equal(byConstruct.get("byProperty")?.kind, "not-translated");
	assert.match(String(byConstruct.get("byProperty")?.message), /paginate\.property/);
	assert.equal(byConstruct.get("noData")?.kind, "route");
	assert.match(String(byConstruct.get("noData")?.message), /no pages/);
	assert.equal(byConstruct.get("literal")?.kind, "not-translated");
	assert.equal(byConstruct.get("noTemplate")?.kind, "not-translated");
	assert.equal(byConstruct.get("htmlAsXml")?.kind, "not-translated");
	// The same URLs as an HTML route, but text: one Astro file cannot serve both
	assert.equal(byConstruct.get("textSameUrls")?.kind, "not-translated");
	assert.match(String(byConstruct.get("textSameUrls")?.message), /"first"/);
});

test("routes whose URLs overlap: one file tries each in tsg.yml order", () => {
	const report = new Report();
	const plans = planRoutes(
		config({
			posts: { path: "/blog/:title/", template: "post.html", paginate: { data: "posts.graphql", pageSize: 4, path: "/blog/page-:num/", template: "list.html", firstPage: "/blog/" } },
			about: { path: "/blog/about/", template: "about.html" },
			other: { path: "/blog/:slug/", template: "other.html", paginate: { data: "other.graphql" } },
			books: { path: "/books/:title/", template: "book.html", paginate: { data: "books.graphql" } },
		}),
		report,
	);
	// "other" has the same Astro route as the posts' items, so it shares that file
	assert.deepEqual(
		plans.map((p) => [p.name, p.part, p.file]),
		[
			["posts", "items", "src/pages/blog/[title].astro"],
			["posts", "listing", "src/pages/blog/page-[num].astro"],
			["posts", "firstPage", "src/pages/blog/index.astro"],
			["about", "page", "src/pages/blog/about/index.astro"],
			["other", "items", "src/pages/blog/[title].astro"],
			["books", "items", "src/pages/books/[title].astro"],
		],
	);
	const files = new Map(pageFiles(plans).map((f) => [f.file, f.candidates.map((c) => `${c.name}:${c.part}`)]));
	assert.deepEqual([...files.keys()], [
		"src/pages/blog/[title].astro",
		"src/pages/blog/page-[num].astro",
		"src/pages/blog/index.astro",
		"src/pages/blog/about/index.astro",
		"src/pages/books/[title].astro",
	]);
	// Astro sends /blog/page-builder-tips/ to page-[num].astro, and /blog/about/ to the static file, where
	// takeshape-ssg gave them to the first route that wrote them. Within a route its own file goes first.
	assert.deepEqual(files.get("src/pages/blog/page-[num].astro"), ["posts:listing", "posts:items", "other:items"]);
	assert.deepEqual(files.get("src/pages/blog/[title].astro"), ["posts:items", "posts:listing", "about:page", "other:items"]);
	assert.deepEqual(files.get("src/pages/blog/about/index.astro"), ["posts:items", "about:page", "other:items"]);
	assert.deepEqual(files.get("src/pages/blog/index.astro"), ["posts:firstPage"]);
	assert.deepEqual(files.get("src/pages/books/[title].astro"), ["books:items"]);
	const notes = report.items().map((i) => [i.kind, i.construct, i.message]);
	assert.ok(notes.every(([kind]) => kind === "route"), JSON.stringify(notes));
	assert.ok(notes.some(([, c, m]) => c === "about" && /"posts"/.test(String(m)) && /src\/pages\/blog\/about\/index\.astro/.test(String(m))), JSON.stringify(notes));
	assert.ok(notes.some(([, c, m]) => c === "other" && /src\/pages\/blog\/\[title\]\.astro/.test(String(m))), JSON.stringify(notes));
});

test("which URL patterns can give the same URL", () => {
	assert.equal(urlsOverlap("/blog/page-:num/", "/blog/:title/"), true);
	assert.equal(urlsOverlap("/blog/about/", "/blog/:title/"), true);
	assert.equal(urlsOverlap("/blog/about", "/blog/:title/"), true);
	assert.equal(urlsOverlap("/blog/", "/blog/:title/"), false);
	assert.equal(urlsOverlap("/blog/page-:num/", "/blog/"), false);
	assert.equal(urlsOverlap("/books/:title/", "/authors/:name/"), false);
	assert.equal(urlsOverlap("/sitemap.xml", "/:slug/"), false);
	assert.equal(urlsOverlap("/:a-:b/", "/x-y/"), true);
	assert.equal(urlsOverlap("/:a/x/", "/y/:b/"), true);
	assert.equal(urlsOverlap("/p/{author.name}/", "/p/lewis/"), true);
	// <folder>/index.html is served at <folder>/
	assert.equal(urlsOverlap("/help/index.html", "/:slug/"), true);
	assert.equal(urlsOverlap("/blog/:title/index.html", "/blog/about/"), true);
	assert.equal(urlsOverlap("/help/index.html", "/help/more/"), false);
});

test("reports locales, which it does not translate", () => {
	const report = new Report();
	const c = config({ home: { path: "/", template: "a.html" } });
	c.locales = { de: { pathPrefix: "/de" }, fr: { pathPrefix: "/fr" } };
	assert.equal(planRoutes(c, report).length, 1);
	assert.deepEqual(
		report.items().map((i) => [i.kind, i.construct]),
		[["not-translated", "locales"]],
	);
	assert.match(report.items()[0]!.message, /\(de, fr\)/);
});

// ---------------------------------------------------------------------------
// The page rules (runtime/context.ts)
// ---------------------------------------------------------------------------

test("item paths: an empty variable gives no page, values go through slugg", () => {
	assert.equal(itemPath("/blog/:title/", { title: "Reinventing Peter Pan " }), "/blog/reinventing-peter-pan/");
	assert.equal(itemPath("/blog/{author.name}/:title", { title: "A", author: { name: "Lewis Carroll" } }), "/blog/lewis-carroll/a");
	assert.equal(itemPath("/blog/:title/", { title: "" }), null);
	assert.equal(itemPath("/blog/:title/", { title: null }), null);
	assert.equal(itemPath("/blog/:title/", {}), null);
	assert.equal(itemPath("/blog/:title/", { title: 0 }), null);
	// A value that slugs to nothing is not empty to takeshape-ssg: its page lands on the folder
	assert.equal(itemPath("/blog/:title/", { title: "!!!" }), "/blog/");
	assert.equal(itemPath("/:title/", { title: "x" }, "/de"), "/de/x/");
});

test("item pages: neighbors skip empty paths, the first of a duplicate path wins", () => {
	const items = [{ title: "One" }, { title: "" }, { title: "Two" }, { title: "one" }, { title: "Three" }];
	const pages = itemPages(items, "/p/:title/");
	assert.deepEqual(
		pages.map((p) => [p.path, p.item.title, p.previousPath ?? null, p.nextPath ?? null]),
		[
			["/p/one/", "One", null, "/p/two/"],
			["/p/two/", "Two", "/p/one/", "/p/one/"],
			// "/p/one/" again: takeshape-ssg rendered it and then kept the first page with that path
			["/p/three/", "Three", "/p/one/", null],
		],
	);
	assert.equal(pages[1]!.nextItem, items[3]);
	assert.ok(!("previousItem" in pages[0]!));
	assert.ok(!("nextItem" in pages[2]!));
	// A path with and without its slash is one page on a static host
	assert.deepEqual(
		itemPages([{ t: "a" }, { t: "A" }], "/p/:t").map((p) => p.path),
		["/p/a"],
	);
	assert.deepEqual(itemPages([], "/p/:t/"), []);
});

test("listing pages: pageSize per page, firstPage replaces page 1, no items no pages", () => {
	const items = ["a", "b", "c", "d", "e"];
	const pages = listingPages(items, 2, "/blog/page-:num/", "/blog/");
	assert.deepEqual(
		pages.map((p) => [p.path, p.items, p.currentPage, p.totalPages]),
		[
			["/blog/", ["a", "b"], 1, 3],
			["/blog/page-2/", ["c", "d"], 2, 3],
			["/blog/page-3/", ["e"], 3, 3],
		],
	);
	assert.deepEqual(
		listingPages(items, 5, "/blog/page-:num/").map((p) => p.path),
		["/blog/page-1/"],
	);
	assert.deepEqual(listingPages([], 4, "/blog/page-:num/", "/blog/"), []);
	// An item without a path stays in the listing
	assert.equal(listingPages([{ title: "" }], 4, "/p/:num/")[0]!.items.length, 1);
});

// Entries as a list reads them, and the item a loader builds from each
const pickEntries = (titles: string[]) => titles.map((title, i) => ({ id: `e${i}`, data: { id: `e${i}`, title } }));
const built = (e: { data: Record<string, unknown> }) => ({ title: e.data.title, body: `about ${e.data.title}` });

test("an item page's pick: its entry and neighbors give the page it has among all items", () => {
	// Empty paths, a path twice, and the URL forms findPage reads
	const entries = pickEntries(["One", "", "Two", "one", "Three", "two", "Four", "Café"]);
	const all = itemPages(entries.map(built), "/p/:title/");
	for (const path of [...all.map((p) => p.path), "/p/nope/", "/p/two", "/p/caf%C3%A9/", "/p/one/index.html", "/"]) {
		const pick = itemPick("/p/:title/", path, ["title"], (e) => ({ title: e.data.title }));
		const kept = pick.entries(entries);
		assert.ok(kept.length <= 3, path);
		assert.deepEqual(findPage(itemPages(kept.map(built), "/p/:title/"), path), findPage(all, path), path);
	}
	const pick = itemPick("/p/:title/", "/p/two/", ["title"], (e) => ({ title: e.data.title }));
	assert.deepEqual(pick.columns, ["title"]);
	// Two's neighbors in the chain of pages: One before it, the second "one" after it
	assert.deepEqual(
		pick.entries(entries).map((e) => e.id),
		["e0", "e2", "e3"],
	);
	assert.deepEqual(pick.entries([]), []);
});

test("a listing page's pick: its own entries, with its page numbers", () => {
	const entries = pickEntries(["a", "b", "c", "d", "e"]);
	const all = listingPages(entries.map(built), 2, "/blog/page-:num/", "/blog/");
	for (const path of ["/blog/", "/blog/page-2/", "/blog/page-3/", "/blog/page-1/", "/blog/page-4/", "/blog/page-2"]) {
		const pick = listingPick(2, "/blog/page-:num/", path, "/blog/");
		const kept = pick.entries(entries);
		assert.deepEqual(pick.page(kept.map(built)), findPage(all, path), path);
	}
	const page3 = listingPick(2, "/blog/page-:num/", "/blog/page-3/", "/blog/");
	assert.deepEqual(page3.entries(entries).map((e) => e.id), ["e4"]);
	assert.equal(listingPick(2, "/blog/page-:num/", "/blog/").page([]), null, "no list read yet, no page");
	const empty = listingPick(2, "/blog/page-:num/", "/blog/", "/blog/");
	assert.deepEqual(empty.entries([]), []);
	assert.equal(empty.page([]), null);
});

test("a read started before the page is found: its failure surfaces only where it is awaited", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		// No page: nothing awaits the global context, and its failure is no unhandled rejection
		loading(Promise.reject(new Error("database down")));
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(unhandled, []);
		// A page: awaiting it still throws
		await assert.rejects(loading(Promise.reject(new Error("database down"))), /database down/);
		assert.equal(await loading(Promise.resolve(3)), 3);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("a request finds the page the old host served at that URL", () => {
	const pages = [{ path: "/blog/" }, { path: "/blog/page-2/" }, { path: "/books/a" }, { path: "/sitemap.xml" }];
	assert.equal(findPage(pages, "/blog/"), pages[0]);
	assert.equal(findPage(pages, "/blog/page-2/"), pages[1]);
	assert.equal(findPage(pages, "/blog/page-3/"), null);
	assert.equal(findPage(pages, "/blog/page-1/"), null);
	// takeshape-ssg wrote /books/a as books/a/index.html
	assert.equal(findPage(pages, "/books/a/"), pages[2]);
	assert.equal(findPage(pages, "/books/a"), null);
	assert.equal(findPage(pages, "/sitemap.xml"), pages[3]);
	assert.equal(findPage([{ path: "/b/café/" }], "/b/caf%C3%A9/")?.path, "/b/café/");
	assert.equal(findPage(pages, "/%E0%A4%A/"), null);
	assert.equal(pageUrl("/"), "/");
	assert.equal(pageUrl("/a//b"), "/a/b/");
	assert.equal(pageUrl("/feed.xml"), "/feed.xml");
});

test("a request gets its page, a redirect to a page at its folder URL, or 404", async () => {
	const pages = [{ path: "/blog/" }, { path: "/blog/page-2/" }, { path: "/books/a/" }];
	const finder = (list: Array<{ path: string }>, name: string) => async (path: string) => (findPage(list, path) ? { name, path } : null);
	const candidates = [
		{ find: finder([pages[1]!], "listing"), template: "Landing" },
		{ find: finder([pages[0]!, pages[2]!], "other"), template: "Other" },
	];
	const at = (url: string) => answer(new URL(`http://x${url}`), candidates);
	assert.deepEqual(await at("/blog/page-2/"), { template: "Landing", context: { name: "listing", path: "/blog/page-2/" } });
	assert.deepEqual(await at("/books/a/"), { template: "Other", context: { name: "other", path: "/books/a/" } });
	// Only a URL whose folder holds a page redirects; the old host answered the rest with 404 at once
	assert.deepEqual(await at("/blog?x=1"), { redirect: "/blog/?x=1" });
	assert.deepEqual(await at("/books/a"), { redirect: "/books/a/" });
	assert.equal(await at("/books/unknown"), null);
	assert.equal(await at("/blog/page-3"), null);
	assert.equal(await at("/blog/page-3/"), null);
	// A file URL never takes a slash
	const sitemap = [{ find: async (path: string) => (isPageUrl("/sitemap.xml", path) ? {} : null), template: "render" }];
	assert.deepEqual(await answer(new URL("http://x/sitemap.xml"), sitemap), { template: "render", context: {} });
	assert.equal(await answer(new URL("http://x/sitemap.xml/"), sitemap), null);
	assert.equal(isPageUrl("/about", "/about/"), true);
	assert.equal(isPageUrl("/about", "/about"), false);
});

test("an index.html URL answers with the page at its folder", () => {
	assert.equal(indexFileTarget(new URL("http://x/blog/a/index.html")), "/blog/a/");
	assert.equal(indexFileTarget(new URL("http://x/index.html?q=1")), "/?q=1");
	assert.equal(indexFileTarget(new URL("http://x/blog/a/")), null);
	assert.equal(indexFileTarget(new URL("http://x/blog/a.html")), null);
	assert.equal(indexFileTarget(new URL("http://x/blog/myindex.html")), null);
});

test("a tsg.yml path ending in index.html is its folder's page, which the index.html URL reaches too", () => {
	// takeshape-ssg wrote /help/index.html the same file as /help/, and the host served it at both URLs
	const file = (path: string) => astroFile(path, "html").file;
	assert.equal(file("/help/index.html"), "src/pages/help/index.astro");
	assert.equal(file("/index.html"), "src/pages/index.astro");
	assert.deepEqual(astroFile("/blog/:title/index.html", "html"), astroFile("/blog/:title/", "html"));
	assert.equal(file("/help/myindex.html"), "src/pages/help/myindex.html.astro");
	assert.equal(pageUrl("/help/index.html"), "/help/");
	assert.equal(pageUrl("/index.html"), "/");
	assert.equal(pageUrl("/help/myindex.html"), "/help/myindex.html");
	const pages = [{ path: "/help/index.html" }];
	assert.equal(findPage(pages, "/help/"), pages[0]);
	// The middleware sends /help/index.html to /help/
	assert.equal(findPage(pages, indexFileTarget(new URL("http://x/help/index.html"))!), pages[0]);
});

test("page context: global and route context spread, then the page's own names", () => {
	const global = { site: { title: "S" }, shared: "global" };
	const route = { page: { title: "P" }, shared: "route" };
	const env = { A: "1" };
	const plain = pageContext(global, route, {}, env, "en-us", "/about/");
	assert.deepEqual(plain, {
		site: { title: "S" },
		shared: "route",
		locale: "en-us",
		page: { title: "P" },
		global: { site: { title: "S" }, shared: "global", locale: "en-us" },
		env,
		environmentVariables: env,
		currentPath: "/about/",
	});

	const [first, second] = itemPages([{ name: "A" }, { name: "B" }], "/a/:name/");
	assert.deepEqual(itemContext(first!, "author"), { item: { name: "A" }, author: { name: "A" }, nextItem: { name: "B" }, nextPath: "/a/b/" });
	assert.deepEqual(itemContext(second!), { item: { name: "B" }, previousItem: { name: "A" }, previousPath: "/a/a/" });
	const ctx = pageContext(global, {}, itemContext(second!, "author"), env, "en-us", second!.path);
	assert.equal(ctx.currentPath, "/a/b/");
	assert.equal(ctx.author, ctx.item);

	const [listing] = listingPages(["x"], 4, "/p/page-:num/", "/p/");
	assert.deepEqual(listingContext(listing!), { items: ["x"], pagination: { currentPage: 1, totalPages: 1 } });
});

// ---------------------------------------------------------------------------
// Generated route code (tsg2astro/emit-routes.mts)
// ---------------------------------------------------------------------------

test("the global context follows takeshape-ssg's context rules", () => {
	const report = new Report();
	const plan = (file: string) => ({ file, variables: [], fields: [], paginatedAlias: null, legacyFields: true });
	const loaders = new Map([
		["data/site.graphql", plan("data/site.graphql")],
		["nav/site.graphql", plan("nav/site.graphql")],
		["data/menu.gql", plan("data/menu.gql")],
	]);
	const c = config({});
	c.context = {
		site: "data/site.graphql",
		nav: { query: "nav/site.graphql", variables: { lang: "en" } },
		menu: { query: "data/menu.gql" },
		bare: "data/menu.gql",
		manifest: "manifest.json",
		list: ["a", 2],
		flag: true,
	};
	const { source } = emitGlobalModule(c, loaders, report);
	assert.match(source, /import \{ load as loadSite \} from "\.\.\/loaders\/data\/site\.ts";/);
	assert.match(source, /import \{ load as loadNavSite \} from "\.\.\/loaders\/nav\/site\.ts";/);
	assert.match(source, /import \{ load as loadMenu \} from "\.\.\/loaders\/data\/menu\.ts";/);
	assert.match(source, /site: await loadSite\(api\),/);
	assert.match(source, /nav: await loadNavSite\(api, \{ lang: "en" \}\),/);
	assert.match(source, /menu: await loadMenu\(api\),/);
	// A bare .gql string was never queried, and an array became an object keyed by index
	assert.match(source, /bare: "data\/menu\.gql",/);
	assert.match(source, /list: \{ "0": "a", "1": 2 \},/);
	assert.match(source, /flag: true,/);
	assert.ok(!source.includes("manifest"));
	assert.deepEqual(
		report.items().map((i) => [i.kind, i.construct]),
		[["not-translated", "context.manifest"]],
	);
	// A context that is not an object gave templates nothing
	c.context = "just text" as unknown as Record<string, unknown>;
	assert.match(emitGlobalModule(c, loaders, new Report()).source, /return \{\};/);
});

// A context.assets that names webpack's manifest under static/, which head and scripts partials read for the
// stylesheet and script names. takeshape-ssg read data files from the templates folder (resolve-context.ts).
test("context data files are copied in as JSON and imported, as takeshape-ssg read them", () => {
	const site = mkdtempSync(join(tmpdir(), "tsg-data-"));
	after(() => rmSync(site, { recursive: true, force: true }));
	mkdirSync(join(site, "src", "templates"), { recursive: true });
	mkdirSync(join(site, "static", "assets"), { recursive: true });
	writeFileSync(join(site, "static", "assets", "manifest.json"), JSON.stringify({ "css/site.css": "css/site.css" }));
	writeFileSync(join(site, "src", "templates", "nav.yml"), "links:\n  - title: Home\n    url: /\n");
	// Same name, another extension, other contents: each keeps its own copy
	writeFileSync(join(site, "src", "templates", "nav.yaml"), "links: []\n");
	const c = config({});
	c.context = { assets: "../../static/assets/manifest.json", nav: "nav.yml", footer: "nav.yaml", outside: "../../../elsewhere.json" };
	const report = new Report();
	const data = new DataFiles(site, join(site, "src", "templates"), (text) => ({ parsed: text.trim() }));
	const { source } = emitGlobalModule(c, new Map(), report, data);
	assert.match(source, /import data0 from "\.\/_data\/static\/assets\/manifest\.json\.json";/);
	assert.match(source, /assets: data0\b/);
	assert.match(source, /import data1 from "\.\/_data\/src\/templates\/nav\.yml\.json";/);
	assert.match(source, /nav: data1\b/);
	assert.match(source, /import data2 from "\.\/_data\/src\/templates\/nav\.yaml\.json";/);
	assert.match(source, /footer: data2\b/);
	assert.ok(!source.includes("outside"));
	assert.deepEqual(
		[...data.files.values()].map((f) => [f.path, JSON.parse(f.source)]),
		[
			["src/routes/_data/static/assets/manifest.json.json", { "css/site.css": "css/site.css" }],
			["src/routes/_data/src/templates/nav.yml.json", { parsed: "links:\n  - title: Home\n    url: /" }],
			["src/routes/_data/src/templates/nav.yaml.json", { parsed: "links: []" }],
		],
	);
	assert.deepEqual(
		report.items().map((i) => [i.kind, i.construct]),
		[
			["note", "context.assets"],
			["note", "context.nav"],
			["note", "context.footer"],
			["not-translated", "context.outside"],
		],
	);
});

// takeshape-ssg's handleYaml refused a YAML file that loads as nothing or as plain text ("unable to load file")
test("an empty YAML data file is reported, not imported", () => {
	const site = mkdtempSync(join(tmpdir(), "tsg-data-empty-"));
	after(() => rmSync(site, { recursive: true, force: true }));
	mkdirSync(join(site, "src", "templates"), { recursive: true });
	writeFileSync(join(site, "src", "templates", "empty.yml"), "# nothing yet\n");
	const data = new DataFiles(site, join(site, "src", "templates"), () => undefined);
	const report = new Report();
	assert.equal(data.file("empty.yml", report, "context.empty"), null);
	assert.equal(data.files.size, 0);
	assert.deepEqual(report.items().map((i) => [i.kind, i.construct]), [["not-translated", "context.empty"]]);
	assert.match(report.items()[0]!.message, /takeshape-ssg could not load/);
});

// takeshape-ssg's resolveContext kept a whole context only when it resolved to an object that is not a list
test("a data file used as the whole context gives its object, and nothing when it holds a list", () => {
	const site = mkdtempSync(join(tmpdir(), "tsg-data-top-"));
	after(() => rmSync(site, { recursive: true, force: true }));
	mkdirSync(join(site, "src", "templates"), { recursive: true });
	writeFileSync(join(site, "src", "templates", "page.json"), JSON.stringify({ title: "Home" }));
	writeFileSync(join(site, "src", "templates", "list.json"), JSON.stringify([1, 2]));
	const data = new DataFiles(site, join(site, "src", "templates"), () => null);
	const c = config({});
	c.context = "page.json" as unknown as Record<string, unknown>;
	const { source } = emitGlobalModule(c, new Map(), new Report(), data);
	assert.match(source, /import data0 from "\.\/_data\/src\/templates\/page\.json\.json";/);
	assert.match(source, /return data0;/);
	c.context = "list.json" as unknown as Record<string, unknown>;
	assert.match(emitGlobalModule(c, new Map(), new Report(), data).source, /return \{\};/);
});

test("pages are short and answer 404 for a URL with no page", () => {
	const plans = planRoutes(
		config({
			feed: { path: "/feeds/:slug/", template: "feed.xml", paginate: { data: "f.graphql", itemName: "feed" } },
			robots: { path: "/robots.txt", template: "robots.txt" },
			posts: { path: "/blog/:title/", template: "post.html", paginate: { data: "posts.graphql", pageSize: 4, path: "/blog/page-:num/", template: "list.html", itemName: "post" } },
			about: { path: "/blog/about/", template: "about.html" },
		}),
		new Report(),
	);
	const t = (name: string, kind: Template["kind"]): Template => ({ name, kind, source: "", ast: null, extends: null, includes: [], blocks: [], tagInteriors: [] });
	const templates = new Map([t("feed.xml", "text"), t("robots.txt", "raw"), t("post.html", "html"), t("list.html", "html"), t("about.html", "html")].map((x) => [x.name, x]));
	const modules = new Map([["feed", "src/routes/feed.ts"], ["robots", "src/routes/robots.ts"], ["posts", "src/routes/posts.ts"], ["about", "src/routes/about.ts"]]);
	const routes = {
		feed: { path: "/feeds/:slug/", paginate: { itemName: "feed" } },
		robots: { path: "/robots.txt" },
		posts: { path: "/blog/:title/", paginate: { itemName: "post", pageSize: 4, path: "/blog/page-:num/" } },
		about: { path: "/blog/about/" },
	};
	const pages = new Map(pageFiles(plans).map((f) => [f.file, emitPage(f, routes, modules, templates).source]));

	const feed = pages.get("src/pages/feeds/[slug].ts")!;
	assert.match(feed, /export async function GET\(\{ url, redirect, rewrite \}: APIContext\) \{/);
	assert.match(feed, /const found = await answer\(url, \[\{ find: \(path\) => itemPage\(emdashApi, path\), template: render \}\]\);/);
	assert.match(feed, /if \(!found\) return rewrite\("\/404"\);/);
	assert.match(feed, /if \("redirect" in found\) return redirect\(found\.redirect, 301\);/);
	assert.match(feed, /"Content-Type": "text\/html"/);
	// A text template without Nunjucks is the same text on every page
	const robots = pages.get("src/pages/robots.txt.ts")!;
	assert.match(robots, /import text from "\.\.\/templates\/robots\.txt\?raw";/);
	assert.match(robots, /template: \(\) => text/);
	assert.match(robots, /"Content-Type": "text\/plain"/);

	// Astro sends /blog/page-builder-tips/ to page-[num].astro: it tries the listing, then the post
	const listing = pages.get("src/pages/blog/page-[num].astro")!;
	assert.match(listing, /import \{ itemPage, listingPage \} from "\.\.\/\.\.\/routes\/posts\.ts";/);
	assert.match(listing, /\{ find: \(path\) => listingPage\(emdashApi, path\), template: List \},\n\t\{ find: \(path\) => itemPage\(emdashApi, path\), template: Post \},/);
	assert.match(listing, /if \(!found\) return Astro\.rewrite\("\/404"\);/);
	assert.match(listing, /if \("redirect" in found\) return Astro\.redirect\(found\.redirect, 301\);/);
	assert.match(listing, /<Template \{\.\.\.context\} \/>/);
	// The static about page tries the earlier posts route first, then its own page, each from its own module
	const about = pages.get("src/pages/blog/about/index.astro")!;
	assert.match(about, /import \{ itemPage \} from "\.\.\/\.\.\/\.\.\/routes\/posts\.ts";/);
	assert.match(about, /import \{ page \} from "\.\.\/\.\.\/\.\.\/routes\/about\.ts";/);
	assert.ok(about.indexOf("=> itemPage(emdashApi, path)") < about.indexOf("=> page(emdashApi, path)"));
});

test("site.ts loads the moment locale tsg.yml needs", () => {
	const available = (name: string) => ["de", "fr", "fr-ca"].includes(name);
	assert.equal(momentLocaleFile("en-us", available), null);
	assert.equal(momentLocaleFile("en", available), null);
	assert.equal(momentLocaleFile("de-DE", available), "moment/locale/de.js");
	assert.equal(momentLocaleFile("fr_CA", available), "moment/locale/fr-ca.js");
	assert.equal(momentLocaleFile("xx-yy", available), null);
	const c = config({ posts: { path: "/p/:title/", paginate: { path: "/p/page-:num/" } }, home: { path: "/" } });
	c.locale = "de-de";
	const { source } = emitSiteModule(c, "moment/locale/de.js");
	assert.match(source, /import "moment\/locale\/de\.js";/);
	assert.match(source, /export const locale = "de-de";/);
	assert.match(source, /posts: \{ path: "\/p\/:title\/", paginate: \{ path: "\/p\/page-:num\/" \} \},/);
	assert.ok(!emitSiteModule(config({}), null).source.includes("moment"));
});

// takeshape-ssg ran minimize over every page with { loose: true, ...options }
test("htmlCompression from tsg.yml reaches the site module, with takeshape-ssg's default options", () => {
	const on = config({ home: { path: "/" } });
	on.htmlCompression = { enabled: true, options: { comments: true } };
	assert.match(emitSiteModule(on, null).source, /export const htmlCompression: Record<string, unknown> \| null = \{ loose: true, comments: true \};/);
	const off = config({ home: { path: "/" } });
	off.htmlCompression = { enabled: false, options: { comments: true } };
	assert.match(emitSiteModule(off, null).source, /export const htmlCompression: Record<string, unknown> \| null = null;/);
	assert.match(emitSiteModule(config({}), null).source, /export const htmlCompression: Record<string, unknown> \| null = null;/);
});

/** Every name a generated page's frontmatter or module declares: imports and const destructures. */
function declared(source: string): string[] {
	const names: string[] = [];
	for (const m of source.matchAll(/^import (?:type )?(\w+) from/gm)) names.push(m[1]!);
	for (const m of source.matchAll(/^import (?:type )?\{ ([^}]+) \} from/gm)) for (const n of m[1]!.split(",")) names.push(n.trim().split(/\s+as\s+/).pop()!);
	for (const m of source.matchAll(/^\s*const \{ ([^}]+) \} =/gm)) for (const n of m[1]!.split(",")) names.push(n.trim().split(":").pop()!.trim());
	for (const m of source.matchAll(/^\s*const (\w+) =/gm)) names.push(m[1]!);
	return names;
}

test("a template named template.html keeps its own name in the page", () => {
	const routes = {
		home: { path: "/", template: "template.html" },
		posts: { path: "/blog/:title/", template: "pages/template.html", paginate: { data: "posts.graphql", itemName: "post" } },
		astro: { path: "/a/", template: "astro.html" },
	};
	const plans = planRoutes(config(routes), new Report());
	const t = (name: string): Template => ({ name, kind: "html", source: "", ast: null, extends: null, includes: [], blocks: [], tagInteriors: [] });
	const templates = new Map(["template.html", "pages/template.html", "astro.html"].map((n) => [n, t(n)]));
	const modules = new Map([["home", "src/routes/home.ts"], ["posts", "src/routes/posts.ts"], ["astro", "src/routes/astro.ts"]]);
	const pages = new Map(pageFiles(plans).map((f) => [f.file, emitPage(f, routes, modules, templates).source]));
	for (const [file, source] of pages) {
		const names = declared(source);
		assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], `${file} declares a name twice:\n${source}`);
		assert.ok(!names.includes("Astro"), file);
	}
	assert.match(pages.get("src/pages/index.astro")!, /^import Template2 from "\.\.\/templates\/template\.astro";$/m);
	assert.match(pages.get("src/pages/index.astro")!, /template: Template2 \}/);
	assert.match(pages.get("src/pages/blog/[title].astro")!, /^import Template2 from "\.\.\/\.\.\/templates\/pages\/template\.astro";$/m);
	assert.match(pages.get("src/pages/a/index.astro")!, /^import Astro2 from /m);
});

// Raw text routes: the generated endpoint, run in Node with `?raw` imports served by a hook
const rawProject = join(root, "test", ".out", `tsg-raw-route-${process.pid}`);
after(() => rmSync(rawProject, { recursive: true, force: true }));

test("a plain route whose template has no Nunjucks answers without EmDash", async () => {
	const routes = {
		robots: { path: "/robots.txt", template: "robots.txt" },
		about: { path: "/about/", template: "about.html" },
	};
	const plans = planRoutes(config(routes), new Report());
	const raw = (name: string): Template => ({ name, kind: "raw", source: "", ast: null, extends: null, includes: [], blocks: [], tagInteriors: [] });
	const templates = new Map([raw("robots.txt"), raw("about.html")].map((x) => [x.name, x]));
	const modules = new Map([["robots", "src/routes/robots.ts"], ["about", "src/routes/about.ts"]]);
	const pages = new Map(pageFiles(plans).map((f) => [f.file, emitPage(f, routes, modules, templates).source]));
	for (const source of pages.values()) {
		assert.ok(!source.includes("emdashApi"), source);
		assert.ok(!source.includes("routes/"), source);
	}
	assert.match(pages.get("src/pages/about/index.astro")!, /find: async \(path\) => \(isPageUrl\("\/about\/", path\) \? \{\} : null\)/);

	// Run the endpoint: a database that fails, or any import of it, must not matter
	const src = join(rawProject, "src");
	mkdirSync(join(src, "pages"), { recursive: true });
	mkdirSync(join(src, "templates"), { recursive: true });
	cpSync(join(root, "tsg2astro", "runtime"), join(src, "lib", "takeshape"), { recursive: true });
	writeFileSync(join(src, "lib", "takeshape", "emdash-api.ts"), 'throw new Error("the database is down");\n');
	writeFileSync(join(src, "templates", "robots.txt"), "User-agent: *\n");
	writeFileSync(join(src, "pages", "robots.txt.ts"), pages.get("src/pages/robots.txt.ts")!);
	registerHooks({
		load(url, context, nextLoad) {
			if (!url.endsWith("?raw")) return nextLoad(url, context);
			const text = readFileSync(fileURLToPath(url.slice(0, -"?raw".length)), "utf8");
			return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
		},
	});
	const endpoint = (await import(pathToFileURL(join(src, "pages", "robots.txt.ts")).href)) as {
		GET(context: { url: URL; redirect: (to: string, status: number) => Response; rewrite: (to: string) => Response }): Promise<Response>;
	};
	const ctx = (url: string) => ({
		url: new URL(`http://localhost${url}`),
		redirect: (to: string, status: number) => new Response(null, { status, headers: { Location: to } }),
		rewrite: (to: string) => new Response(to, { status: 404 }),
	});
	const ok = await endpoint.GET(ctx("/robots.txt"));
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get("Content-Type"), "text/plain");
	assert.equal(await ok.text(), "User-agent: *\n");
	assert.equal((await endpoint.GET(ctx("/robots.txt/"))).status, 404);
});
