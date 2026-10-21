import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readExport } from "../../tsg2astro/export.mts";
import { computeSiteSlugs } from "../../tsg2astro/site-slugs.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = join(root, "test", "fixtures", "shape-books");
const site = join(root, "test", "tsg", "sites", "shape-books", "site");
const work = mkdtempSync(join(tmpdir(), "site-slugs-"));
after(() => rmSync(work, { recursive: true, force: true }));

const POST_1 = "jump-aboard-the-new-treasure-islands-edition";
const POST_2 = "eat-me-here-is-the-new-edition-of-lewis-carrolls-masterpiece";

type Json = Record<string, any>;
function convert(name: string, extra: string[]): { seed: Json; report: string } {
	const out = join(work, name);
	const res = spawnSync(process.execPath, ["--no-warnings", "ts2emdash.mts", fixture, "--out", join(out, "seed.json"), "--report", join(out, "report.md"), ...extra], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(res.status, 0, `ts2emdash exited ${res.status}: ${res.stderr}`);
	return { seed: JSON.parse(readFileSync(join(out, "seed.json"), "utf8")), report: readFileSync(join(out, "report.md"), "utf8") };
}

test("shape-books-slugs", async () => {
	const exp = await readExport(fixture);
	const { slugs, notes } = await computeSiteSlugs(site, exp);
	const values = [...slugs.values()];
	assert.ok(values.includes(POST_1), values.join(", "));
	assert.ok(values.includes(POST_2));
	assert.deepEqual(notes, []);

	// Books and authors keep the slugs ts2emdash gives them today
	const plain = convert("plain", []).seed.content as Record<string, Array<{ id: string; slug: string }>>;
	assert.equal(plain.books?.length, 4);
	assert.equal(plain.authors?.length, 4);
	const siteSlugs = new Set(values);
	for (const e of [...plain.books!, ...plain.authors!]) assert.ok(siteSlugs.has(e.slug), `${e.slug} not in site slugs`);
});

test("ts2emdash-site-flag", () => {
	const { seed, report } = convert("site", ["--site", site]);
	const posts = (seed.content.posts as Array<{ slug: string }>).map((p) => p.slug);
	assert.ok(posts.includes(POST_1), posts.join(", "));
	assert.ok(posts.includes(POST_2));
	assert.match(report, /## Slugs taken from your site's URLs/);
	const section = report.split("## Slugs taken from your site's URLs")[1]!.split("\n## ")[0]!;
	assert.ok(section.includes(POST_1) && section.includes(POST_2));
});

test("ts2emdash-site-flag: the report names the slug each entry gets without --site", () => {
	type Content = Record<string, Array<{ id: string; slug?: string }>>;
	const plain = convert("plain-slugs", []).seed.content as Content;
	const { seed, report } = convert("site-slugs", ["--site", site]);
	const expected: string[] = [];
	for (const [collection, entries] of Object.entries(seed.content as Content)) {
		for (const e of entries) {
			const before = plain[collection]?.find((p) => p.id === e.id)?.slug;
			if (before !== undefined && e.slug !== undefined && before !== e.slug) expected.push(`- \`${collection}\`: \`${before}\` is now \`${e.slug}\``);
		}
	}
	assert.ok(expected.length > 0);
	const section = report.split("## Slugs taken from your site's URLs")[1]!.split("\n## ")[0]!;
	assert.deepEqual(section.split("\n").filter((l) => l.startsWith("- `")).sort(), expected.sort());
	assert.match(section, new RegExp(` ${expected.length} differ from the slug the converter gives without --site\\.`));
});

// ---------------------------------------------------------------------------
// Synthetic exports and sites. Their own small schema: Author, Tag and Post.
// ---------------------------------------------------------------------------

const rel = (shapeId: string, id: string) => ({ shapeId, id });
const prop = (type: string, shape: string, key: string, extra: Obj = {}) => ({ type, title: key, "@mapping": `takeshape:local:${shape}.${key}`, ...extra });
const relProp = (shape: string, key: string, target: string, multiple = false) => ({
	...(multiple ? { type: "array", items: { $ref: "#/shapes/TSRelationship/schema" } } : { $ref: "#/shapes/TSRelationship/schema" }),
	"@relationship": { shapeIds: [target], type: multiple ? "multiple" : "single" },
	"@mapping": `takeshape:local:${shape}.${key}`,
});
type Obj = Record<string, any>;

const SCHEMA = {
	shapes: {
		Author: { id: "A1", name: "Author", model: { type: "multiple" }, schema: { type: "object", properties: { name: prop("string", "Author", "n"), slug: prop("string", "Author", "s") } } },
		Tag: { id: "T1", name: "Tag", model: { type: "multiple" }, schema: { type: "object", properties: { name: prop("string", "Tag", "n") } } },
		Post: {
			id: "P1",
			name: "Post",
			model: { type: "multiple" },
			schema: {
				type: "object",
				properties: {
					title: prop("string", "Post", "t"),
					views: prop("integer", "Post", "v"),
					flag: prop("boolean", "Post", "f"),
					author: relProp("Post", "a", "A1"),
					tags: relProp("Post", "g", "T1", true),
					nums: { type: "array", items: { type: "string" }, "@mapping": "takeshape:local:Post.l" },
				},
			},
		},
	},
	queries: {
		getPostList: { shape: "PaginatedList<Post>" },
		getAuthorList: { shape: "PaginatedList<Author>" },
	},
};

function makeSite(name: string, yml: string, queryFiles: Record<string, string>, rows: Obj[]): { site: string; exp: { schema: unknown; rows: Obj[] } } {
	const dir = join(work, name);
	mkdirSync(join(dir, "templates"), { recursive: true });
	writeFileSync(join(dir, "tsg.yml"), yml);
	for (const [file, text] of Object.entries(queryFiles)) writeFileSync(join(dir, "templates", file), text);
	return { site: dir, exp: { schema: SCHEMA, rows } };
}
const post = (id: string, fields: Obj): Obj => ({ _id: id, _shapeId: "P1", _enabled: true, ...fields });
const POSTS_QUERY = "query { getPostList { items { title } } }";
const ROUTE = (path: string, data = "posts.graphql") => `routes:\n  posts:\n    path: ${path}\n    paginate:\n      data: ${data}\n`;

test("duplicate slugs: first keeps it, later get -2 and -3 in export order, with a note", async () => {
	const { site, exp } = makeSite("dupes", ROUTE("/blog/:title/"), { "posts.graphql": POSTS_QUERY }, [
		post("p1", { t: "Same Title" }),
		post("p2", { t: "same title!" }),
		post("p3", { t: "SAME   title" }),
		post("p4", { t: "Other" }),
	]);
	const { slugs, notes } = await computeSiteSlugs(site, exp);
	assert.deepEqual([...slugs], [["p1", "same-title"], ["p2", "same-title-2"], ["p3", "same-title-3"], ["p4", "other"]]);
	assert.equal(notes.length, 2);
	assert.match(notes[0]!, /p2/);
	assert.match(notes[0]!, /never had a page/);
	assert.match(notes[1]!, /p3.*same-title-3/);
});

test("an entry reached by two routes keeps the first route's slug and gets a note", async () => {
	const yml = `routes:\n  byTitle:\n    path: /a/:title/\n    paginate:\n      data: posts.graphql\n  byAuthor:\n    path: /b/:author.name/\n    paginate:\n      data: posts.graphql\n`;
	const { site, exp } = makeSite("two-routes", yml, { "posts.graphql": "query { getPostList { items { title author { name } } } }" }, [
		{ _id: "a1", _shapeId: "A1", n: "Ann" },
		post("p1", { t: "First", a: rel("A1", "a1") }),
	]);
	const { slugs, notes } = await computeSiteSlugs(site, exp);
	assert.equal(slugs.get("p1"), "first");
	assert.equal(notes.length, 1);
	assert.match(notes[0]!, /more than one route/);
	assert.match(notes[0]!, /"first"/);
});

test("curly syntax and a dot path through a relationship", async () => {
	const { site, exp } = makeSite("curly", ROUTE("/x/{author.name}/"), { "posts.graphql": "query { getPostList { items { author { name } } } }" }, [
		{ _id: "a1", _shapeId: "A1", n: "Ann O'Neil" },
		post("p1", { t: "Ignored", a: rel("A1", "a1") }),
	]);
	const { slugs, notes } = await computeSiteSlugs(site, exp);
	assert.equal(slugs.get("p1"), "ann-oneil");
	assert.deepEqual(notes, []);
});

test("a path with several variables uses the last one", async () => {
	const { site, exp } = makeSite("multi", ROUTE("/:author.name/:title/"), { "posts.graphql": "query { getPostList { items { title author { name } } } }" }, [
		{ _id: "a1", _shapeId: "A1", n: "Ann" },
		post("p1", { t: "My Post", a: rel("A1", "a1") }),
	]);
	const { slugs } = await computeSiteSlugs(site, exp);
	assert.equal(slugs.get("p1"), "my-post");
});

test("a path variable names the query's alias, and an unselected variable gets one note per route", async () => {
	const aliased = makeSite("alias", ROUTE("/:headline/"), { "posts.graphql": "query { getPostList { items { headline: title writer: author { who: name } } } }" }, [post("p1", { t: "Aliased Title" }), post("p2", { t: "Another" })]);
	assert.equal((await computeSiteSlugs(aliased.site, aliased.exp)).slugs.get("p1"), "aliased-title");
	const nested = makeSite("alias-nested", ROUTE("/:writer.who/"), { "posts.graphql": "query { getPostList { items { writer: author { who: name } } } }" }, [
		{ _id: "a1", _shapeId: "A1", n: "Ann" },
		post("p1", { a: rel("A1", "a1") }),
	]);
	assert.equal((await computeSiteSlugs(nested.site, nested.exp)).slugs.get("p1"), "ann");

	// "title" is the property name, but the query only selects it under the alias "headline"
	const missing = makeSite("unselected", ROUTE("/:title/"), { "posts.graphql": "query { getPostList { items { headline: title } } }" }, [post("p1", { t: "A" }), post("p2", { t: "B" })]);
	const { slugs, notes } = await computeSiteSlugs(missing.site, missing.exp);
	assert.equal(slugs.size, 0);
	assert.equal(notes.length, 1);
	assert.match(notes[0]!, /Route "posts".*"title".*does not select/);
});

test("a route that pages a context property is noted, not matched", async () => {
	const yml = `routes:\n  list:\n    path: /list/:title/\n    paginate:\n      property: items\n`;
	const { site, exp } = makeSite("property", yml, {}, [post("p1", { t: "A" })]);
	const { slugs, notes } = await computeSiteSlugs(site, exp);
	assert.equal(slugs.size, 0);
	assert.equal(notes.length, 1);
	assert.match(notes[0]!, /Route "list".*"items".*could not be matched.*keep the slugs/);
});

test("a filtered query it cannot read still gives every entry a slug, with one note per route", async () => {
	const rows = [post("p1", { t: "A" }), post("p2", { t: "B" })];
	// A where it reads whole decides the entries (the test above); one with another operator lets every entry through
	const inQuery = makeSite("filter-arg", ROUTE("/:title/"), { "posts.graphql": 'query { getPostList(where: {title: {match: "A"}}) { items { title } } }' }, rows);
	const a = await computeSiteSlugs(inQuery.site, inQuery.exp);
	assert.equal(a.slugs.size, 2);
	assert.equal(a.notes.length, 1);
	assert.match(a.notes[0]!, /Route "posts" filters its list \(where\).*outside that filter/);
	const read = makeSite("filter-read", ROUTE("/:title/"), { "posts.graphql": 'query { getPostList(where: {title: {eq: "A"}}) { items { title } } }' }, rows);
	assert.deepEqual([...(await computeSiteSlugs(read.site, read.exp)).slugs], [["p1", "a"]]);

	const yml = `routes:\n  posts:\n    path: /:title/\n    paginate:\n      data:\n        query: posts.graphql\n        variables:\n          filter: {title: A}\n`;
	const inVars = makeSite("filter-vars", yml, { "posts.graphql": POSTS_QUERY }, rows);
	const b = await computeSiteSlugs(inVars.site, inVars.exp);
	assert.equal(b.slugs.size, 2);
	assert.equal(b.notes.length, 1);
	assert.match(b.notes[0]!, /filters its list \(filter\)/);
});

test("path values are coerced like takeshape-ssg's formatPath", async () => {
	const q = "query { getPostList { items { title views flag nums tags { name } } } }";
	const cases: Array<[string, string, Obj, string | undefined]> = [
		["views", "/:views/", { v: 0 }, undefined], // 0 is falsy, so '' and no slug
		["flag-false", "/:flag/", { f: false }, undefined],
		["views-7", "/:views/", { v: 7 }, "7"],
		["flag-true", "/:flag/", { f: true }, "true"],
		["array", "/:nums/", { l: ["One", "Two"] }, "one-two"], // an array prints joined by commas
		["index", "/:tags.1.name/", { g: [rel("T1", "t1"), rel("T1", "t2")] }, "beta"], // numeric segments work like lodash get
	];
	for (const [name, path, fields, want] of cases) {
		const { site, exp } = makeSite(`coerce-${name}`, ROUTE(path), { "posts.graphql": q }, [
			{ _id: "t1", _shapeId: "T1", n: "Alpha" },
			{ _id: "t2", _shapeId: "T1", n: "Beta" },
			post("p1", { t: "T", ...fields }),
		]);
		const { slugs } = await computeSiteSlugs(site, exp);
		assert.equal(slugs.get("p1"), want, name);
	}
});

test("drafts get slugs exactly when the route's query lists them", async () => {
	// TakeShape lists drafts only when a where or filter replaces its published-only default
	const rows = [post("p1", { t: "Live" }), { ...post("p2", { t: "Draft" }), _enabled: false }];
	const slugsFor = async (name: string, yml: string, query: string) => {
		const { site, exp } = makeSite(name, yml, { "posts.graphql": query }, rows);
		return [...(await computeSiteSlugs(site, exp)).slugs];
	};
	assert.deepEqual(await slugsFor("drafts-plain", ROUTE("/:title/"), POSTS_QUERY), [["p1", "live"]]);
	assert.deepEqual(await slugsFor("drafts-where", ROUTE("/:title/"), 'query { getPostList(where: {title: {in: ["Live", "Draft"]}}) { items { title } } }'), [
		["p1", "live"],
		["p2", "draft"],
	]);
	assert.deepEqual(await slugsFor("drafts-enabled", ROUTE("/:title/"), "query { getPostList(where: {_enabled: {eq: true}}) { items { title } } }"), [["p1", "live"]]);

	// The same through tsg.yml variables
	const withVariable = (filter: string) => `routes:\n  posts:\n    path: /:title/\n    paginate:\n      data:\n        query: posts.graphql\n        variables:\n          filter: ${filter}\n`;
	const viaVariable = "query ($filter: JSON) { getPostList(filter: $filter) { items { title } } }";
	assert.deepEqual(await slugsFor("drafts-vars", withVariable("{term: {title: Draft}}"), viaVariable), [
		["p1", "live"],
		["p2", "draft"],
	]);
	assert.deepEqual(await slugsFor("drafts-vars-enabled", withVariable("{match: {_enabled: true}}"), viaVariable), [["p1", "live"]]);
});

// Entries of a collection without pages used to step around other collections' page slugs (nature became nature-2
// where a category page used nature). Slugs are unique per collection, and a collection with no pages has no URLs to
// step around.
test("an entry of a collection without pages keeps its slug when another collection's page uses it", () => {
	const { site } = makeSite("other-collection", ROUTE("/:title/"), { "posts.graphql": POSTS_QUERY }, []);
	const dir = join(work, "other-collection-export");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "schema.json"), JSON.stringify({ apiVersion: "2", projectId: "p", defaultLocale: "en", locales: ["en"], forms: {}, ...SCHEMA }));
	const rows = [post("p1", { t: "Ann" }), { _id: "a1", _shapeId: "A1", _enabled: true, n: "Ann", s: "ann" }, { _id: "a2", _shapeId: "A1", _enabled: true, n: "Ann again", s: "ann" }];
	writeFileSync(join(dir, "data.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
	const out = join(work, "other-collection-out");
	const res = spawnSync(process.execPath, ["--no-warnings", "ts2emdash.mts", dir, "--out", join(out, "seed.json"), "--report", join(out, "report.md"), "--site", site], { cwd: root, encoding: "utf8" });
	assert.equal(res.status, 0, res.stderr);
	const seed = JSON.parse(readFileSync(join(out, "seed.json"), "utf8"));
	assert.deepEqual(seed.content.posts.map((e: Json) => e.slug), ["ann"]);
	// Within the collection, slugs still step around each other
	assert.deepEqual(seed.content.authors.map((e: Json) => e.slug), ["ann", "ann-2"]);
});

// A /board/:name/ route lists getPersonList(where: {type: {eq: "board"}}), and two people share a name; type is a
// list, which Elasticsearch matched when it held the value. The one the route lists had the page.
test("a route's where decides which entry had the page, a list field matching when it holds the value", async () => {
	const { site, exp } = makeSite("where-list", ROUTE("/board/:title/"), { "posts.graphql": 'query { getPostList(where: {nums: {eq: "board"}, flag: {in: [true]}}) { items { title } } }' }, [
		post("p1", { t: "Sam Rivera" }),
		post("p2", { t: "Sam Rivera", l: ["board"], f: true }),
		post("p3", { t: "Other", l: ["board"], f: false }),
	]);
	const { slugs, notes } = await computeSiteSlugs(site, exp);
	assert.deepEqual([...slugs], [["p2", "sam-rivera"]]);
	// Every condition was read, so no note says entries outside the filter got slugs
	assert.ok(!notes.some((n) => /filters its list/.test(n)), notes.join("\n"));
});

// A query variable's default applies when tsg.yml passes none; one with no value at all can't be read, so every entry
// keeps a slug from the path and the note says so
test("a route's where reads query variable defaults, and an unset variable lets every entry through", async () => {
	const rows = [post("p1", { t: "Sam Rivera" }), post("p2", { t: "Sam Rivera", l: ["board"] })];
	const withDefault = makeSite("where-default", ROUTE("/board/:title/"), { "posts.graphql": 'query ($kind: String = "board") { getPostList(where: {nums: {eq: $kind}}) { items { title } } }' }, rows);
	assert.deepEqual([...(await computeSiteSlugs(withDefault.site, withDefault.exp)).slugs], [["p2", "sam-rivera"]]);
	const unset = makeSite("where-unset", ROUTE("/board/:title/"), { "posts.graphql": "query ($kind: String) { getPostList(where: {nums: {eq: $kind}}) { items { title } } }" }, rows);
	const { slugs, notes } = await computeSiteSlugs(unset.site, unset.exp);
	assert.equal(slugs.size, 2);
	assert.ok(notes.some((n) => /filters its list/.test(n)), notes.join("\n"));
});

// The status rule reads the same variables as the where: a defaulted $w of {_enabled: {eq: false}} lists drafts
test("a route's status reads query variable defaults too", async () => {
	const rows = [post("p1", { t: "Live" }), { ...post("p2", { t: "Draft" }), _enabled: false }];
	const { site, exp } = makeSite("status-default", ROUTE("/:title/"), { "posts.graphql": "query ($w: TSWhereInput = {_enabled: {eq: false}}) { getPostList(where: $w) { items { title } } }" }, rows);
	assert.deepEqual([...(await computeSiteSlugs(site, exp)).slugs], [["p2", "draft"]]);
});
