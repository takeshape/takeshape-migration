import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FieldMap } from "../../ts2emdash.mts";
import { emitLoader } from "../../tsg2astro/emit-loader.mts";
import { listOptions, planQuery } from "../../tsg2astro/queries.mts";
import type { QueryPlan } from "../../tsg2astro/queries.mts";
import { readExport } from "../../tsg2astro/export.mts";
import { Report } from "../../tsg2astro/report.mts";
import { loadTakeShapeSchema } from "../../tsg2astro/schema.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = join(root, "test", "fixtures", "shape-books");
const templates = join(root, "test", "tsg", "sites", "shape-books", "site", "src", "templates");
const work = mkdtempSync(join(tmpdir(), "tsg-queries-"));
after(() => rmSync(work, { recursive: true, force: true }));

const STARTER_QUERIES = ["site", "sitemap", "homepage", "posts", "books", "authors"];

/** The field map ts2emdash writes for shape-books. */
function shapeBooksFieldMap(extra: string[] = []): FieldMap {
	const out = join(work, extra.length ? "bare" : "normal");
	const res = spawnSync(process.execPath, ["--no-warnings", "ts2emdash.mts", fixture, "--out", join(out, "seed.json"), "--report", join(out, "report.md"), ...extra], { cwd: root, encoding: "utf8" });
	assert.equal(res.status, 0, `ts2emdash exited ${res.status}: ${res.stderr}`);
	return JSON.parse(readFileSync(join(out, "takeshape-field-map.json"), "utf8"));
}

const fieldMap = shapeBooksFieldMap();
const schema = loadTakeShapeSchema(JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8")));
const plan = (source: string, report = new Report(), file = "data/test.graphql"): QueryPlan => planQuery(file, source, schema, fieldMap, report);

test("plans-shape-books", () => {
	const report = new Report();
	const plans = STARTER_QUERIES.map((name) => {
		const file = `data/${name}.graphql`;
		return planQuery(file, readFileSync(join(templates, file), "utf8"), schema, fieldMap, report);
	});
	const expected = JSON.parse(readFileSync(join(root, "test", "tsg", "expected", "shape-books-plans.json"), "utf8"));
	assert.deepEqual(plans, expected);

	// One thing the new site does differently, reported; nothing else
	const items = report.items();
	assert.deepEqual(
		items.map((i) => [i.kind, i.file, i.line, i.construct]),
		[["query", "data/authors.graphql", 9, "biography"]],
	);
	assert.match(items[0]!.message, /Portable Text/);
});

test("schema-model", () => {
	assert.deepEqual(schema.queries.get("getBookList"), { shape: "Book", op: "list" });
	assert.deepEqual(schema.queries.get("getBook"), { shape: "Book", op: "get" });
	assert.deepEqual(schema.queries.get("getHomepage"), { shape: "Homepage", op: "single" });
	const book = schema.shapes.get("Book")!;
	assert.equal(book.model, "multiple");
	assert.deepEqual(book.properties.author, { name: "author", kind: "relationship", multiple: false, targets: ["Author"], relatedName: "authored" });
	assert.deepEqual(book.properties.genre, { name: "genre", kind: "relationship", multiple: false, targets: ["Genre"], relatedName: "books" });
	assert.equal(book.properties.coverImage?.kind, "asset");
	assert.equal(book.properties.body?.kind, "draftjs");
	const hero = schema.shapes.get("Homepage")!.properties.hero!;
	assert.equal(hero.kind, "object");
	assert.deepEqual(Object.keys(hero.properties ?? {}), ["image", "featuredPost"]);
	assert.equal(schema.shapes.get("Post")!.properties.tags?.multiple, true);

	// Every relationship has a back reference: the relatedName, or <shape>Set (schemas before 3.13)
	const author = schema.reverse.get("Author")!;
	assert.deepEqual(author.get("authored"), { shape: "Book", property: "author", multiple: false });
	assert.deepEqual(author.get("postSet"), { shape: "Post", property: "author", multiple: false });
	assert.deepEqual(schema.reverse.get("Post")!.get("heroFeaturedPost"), { shape: "Homepage", property: "hero.featuredPost", multiple: false });
	assert.deepEqual(schema.reverse.get("Tag")!.get("postSet"), { shape: "Post", property: "tags", multiple: true });
});

test("schema-model reads a current export like the pattern export", async () => {
	// TakeShape's 2026 export of the same project: relationships are `@ref` with a shapedb:getRelated resolver
	const { schema: json } = await readExport(join(root, "test", "tsg", "sites", "shape-books", "export"));
	const current = loadTakeShapeSchema(json);
	// The one difference: the export is apiVersion "1" with no workflows, so its lists keep drafts (list-status.mts)
	for (const [name, shape] of schema.shapes) assert.deepEqual(current.shapes.get(name), { ...shape, onlyEnabledFilters: false }, name);
	assert.equal(schema.shapes.get("Post")!.onlyEnabledFilters, true);
	for (const [target, fields] of schema.reverse) {
		for (const [field, from] of fields) assert.deepEqual(current.reverse.get(target)?.get(field), from, `${target}.${field}`);
	}
	assert.deepEqual(current.shapes.get("Book")!.properties.author, { name: "author", kind: "relationship", multiple: false, targets: ["Author"], relatedName: "authored" });
});

// TakeShape's <shape>Set without a back reference name lists the entries that reference this one through any field
// (it filters on _references, every link an entry holds): a Category.storySet covers Story.categories and a category
// field inside an inline object too
test("schema-model makes an unnamed reverse field cover every field that points at the shape", () => {
	const json = JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8"));
	const author = json.shapes.Book.schema.properties.author;
	json.shapes.Book.schema.properties.author = { ...author, "@relationship": { ...author["@relationship"], relatedName: undefined } };
	json.shapes.Book.schema.properties.editor = { ...author, "@mapping": "takeshape:local:Book.editor1", "@relationship": { ...author["@relationship"], relatedName: undefined } };
	const rev = loadTakeShapeSchema(json).reverse.get("Author")!.get("bookSet");
	assert.deepEqual(rev, { shape: "Book", property: "author", multiple: false, others: [{ property: "editor", multiple: false }] });
});

// _references holds every reference of the entry, so the unnamed field also lists books linked through a named field
test("schema-model makes an unnamed reverse field cover named fields too", () => {
	const json = JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8"));
	const author = json.shapes.Book.schema.properties.author;
	// Book.author keeps its name (Author.authored); Book.editor has none
	json.shapes.Book.schema.properties.editor = { ...author, "@mapping": "takeshape:local:Book.editor1", "@relationship": { ...author["@relationship"], relatedName: undefined } };
	const model = loadTakeShapeSchema(json);
	assert.deepEqual(model.reverse.get("Author")!.get("bookSet"), { shape: "Book", property: "editor", multiple: false, others: [{ property: "author", multiple: false }] });
	assert.deepEqual(model.reverse.get("Author")!.get("authored"), { shape: "Book", property: "author", multiple: false });
	// The other order: Book.author has no name and Book.editor is named
	const flipped = JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8"));
	const props = flipped.shapes.Book.schema.properties;
	props.editor = { ...props.author, "@mapping": "takeshape:local:Book.editor1", "@relationship": { ...props.author["@relationship"], relatedName: "edited" } };
	props.author = { ...props.author, "@relationship": { ...props.author["@relationship"], relatedName: undefined } };
	const other = loadTakeShapeSchema(flipped);
	assert.deepEqual(other.reverse.get("Author")!.get("bookSet"), { shape: "Book", property: "author", multiple: false, others: [{ property: "editor", multiple: false }] });
	assert.deepEqual(other.reverse.get("Author")!.get("edited"), { shape: "Book", property: "editor", multiple: false });
	// A field whose own reverse is off still puts its links in _references (TakeShape's indexing adds every
	// relationship value), so the unnamed field lists books linked only through it
	const disabled = JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8"));
	const dp = disabled.shapes.Book.schema.properties;
	dp.editor = { ...dp.author, "@mapping": "takeshape:local:Book.editor1", "@backreference": { enabled: false } };
	dp.author = { ...dp.author, "@relationship": { ...dp.author["@relationship"], relatedName: undefined } };
	const off = loadTakeShapeSchema(disabled);
	assert.deepEqual(off.reverse.get("Author")!.get("bookSet"), { shape: "Book", property: "author", multiple: false, others: [{ property: "editor", multiple: false }] });
	assert.equal([...off.reverse.get("Author")!.values()].filter((f) => f.property === "editor").length, 0, "editor has no reverse field of its own");
	// A named field that takes the unnamed field's name replaces it, as the later definition did in TakeShape, and
	// reads its own property only
	const replaced = JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8"));
	const rp = replaced.shapes.Book.schema.properties;
	rp.editor = { ...rp.author, "@mapping": "takeshape:local:Book.editor1", "@relationship": { ...rp.author["@relationship"], relatedName: "bookSet" } };
	rp.author = { ...rp.author, "@relationship": { ...rp.author["@relationship"], relatedName: undefined } };
	assert.deepEqual(loadTakeShapeSchema(replaced).reverse.get("Author")!.get("bookSet"), { shape: "Book", property: "editor", multiple: false });
	// One inline shape used by two properties: _references holds the links under both, though TakeShape named reverse
	// fields from its first use only
	const inline = JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8"));
	const ip = inline.shapes.Book.schema.properties;
	const authorRel = { ...ip.author, "@relationship": { ...ip.author["@relationship"], relatedName: undefined } };
	inline.shapes.Credit = { id: "CRD", name: "Credit", title: "Credit", schema: { type: "object", properties: { author: { ...authorRel, "@mapping": "takeshape:local:Credit.au" } } } };
	delete ip.author;
	ip.primary = { "@ref": "local:Credit", "@mapping": "takeshape:local:Book.pr" };
	ip.secondary = { "@ref": "local:Credit", "@mapping": "takeshape:local:Book.se" };
	assert.deepEqual(loadTakeShapeSchema(inline).reverse.get("Author")!.get("bookSet"), { shape: "Book", property: "primary.author", multiple: false, others: [{ property: "secondary.author", multiple: false }] });
});

// TakeShape answered a missing value with the property's default, or, for a required property, its type's
// (read from its source)
test("schema-model keeps a scalar's default, and a required one's type default", () => {
	const json = JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8"));
	const hero = json.shapes.HomepageHero.schema;
	hero.properties.flag = { type: "boolean", title: "Flag", default: true, "@mapping": "takeshape:local:HomepageHero.flag1" };
	hero.properties.count = { type: "integer", title: "Count", "@mapping": "takeshape:local:HomepageHero.count1" };
	hero.properties.label = { type: "string", title: "Label", "@mapping": "takeshape:local:HomepageHero.label1" };
	hero.required = ["count", "label"];
	const props = loadTakeShapeSchema(json).shapes.get("Homepage")!.properties.hero!.properties!;
	assert.equal(props.flag?.default, true);
	assert.equal(props.count?.default, 0);
	assert.equal(props.label?.default, "");
	assert.equal("default" in props.image!, false);
});

// An inline shape's MDX field, tagged on the property, where the parent's form has no widget for it
test("schema-model reads a property tagged mdx as markdown", () => {
	const json = JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8"));
	json.shapes.HomepageHero.schema.properties.blurb = { type: "string", title: "Blurb", "@tag": "mdx", "@mapping": "takeshape:local:HomepageHero.blurb1" };
	const hero = loadTakeShapeSchema(json).shapes.get("Homepage")!.properties.hero!;
	assert.equal(hero.properties?.blurb?.kind, "markdown");
});

// ts2emdash binds a reference field to a relation when its links are declared from the other end.
// runtime/references.ts reads the relation from either end, so the plan reads it as any other.
test("a reference field bound to a relation is read, forward and in reverse", () => {
	const bound = structuredClone(fieldMap);
	const book = bound.shapes.Book;
	assert.equal(book.kind, "collection");
	const author = book.kind === "collection" ? book.properties.author : undefined;
	assert.equal(author?.kind, "reference");
	if (author?.kind === "reference") author.relation = "authors_books_author";
	const report = new Report();
	const forward = planQuery("data/test.graphql", "query { getBookList { items { title author { name } } } }", schema, bound, report);
	const reverse = planQuery("data/test2.graphql", "query { getAuthorList { items { name authored { items { title } } } } }", schema, bound, report);
	assert.deepEqual(
		report.items().filter((i) => i.kind === "not-translated").map((i) => i.message),
		[],
	);
	assert.match(JSON.stringify(forward), /"alias":"author","source":\{"kind":"reference","field":"author","target":"Author","collection":"authors","multiple":false\}/);
	assert.match(JSON.stringify(reverse), /"alias":"authored","source":\{"kind":"reverse","shape":"Book","property":"author","collection":"books","field":"author"\}/);
});

// Partials can print `x.image.s3Key | image(...)`: on TakeShape an asset's s3Key was its path
// title(format: html) and content(format: html) are TakeShape's other way to ask for a rich-text field's HTML
test("a rich-text field with format: html renders as its Html field does", () => {
	const report = new Report();
	const p = plan('query { getBookList { items { body(format: html) other: body(format: html, classPrefix: "x-") } } }', report);
	assert.deepEqual(report.items().map((i) => i.message), []);
	const json = JSON.stringify(p);
	assert.match(json, /\{"alias":"body","source":\{"kind":"richTextHtml","field":"body","sidecar":"takeshape_rich_text","args":\{\}\}/);
	assert.match(json, /\{"alias":"other","source":\{"kind":"richTextHtml","field":"body","sidecar":"takeshape_rich_text","args":\{"classPrefix":"x-"\}\}/);
});

test("an asset's s3Key reads as its path", () => {
	const report = new Report();
	const p = plan("query { getBookList { items { coverImage { s3Key path } } } }", report);
	assert.deepEqual(
		report.items().filter((i) => i.kind === "not-translated").map((i) => i.construct),
		[],
	);
	assert.match(JSON.stringify(p), /\{"alias":"s3Key","source":\{"kind":"assetField","name":"path"\},"selection":\[\]\},\{"alias":"path","source":\{"kind":"assetField","name":"path"\}/);
});

test("args map through the field map", () => {
	const p = plan(`query { getPostList(sort: [{field: "title", order: "asc"}, {field: "_createdAt", order: "DESC"}, {field: "_id", order: "asc"}], size: 5, from: 2) { items { title } } }`);
	assert.deepEqual(p.fields[0]!.args, {
		sort: [
			{ field: "title", order: "asc" },
			{ field: "takeshape_created_at", order: "desc" },
			{ field: "takeshape_id", order: "asc" },
		],
		where: null,
		filter: null,
		size: 5,
		from: 2,
		id: null,
	});
	// A null argument is the same as none, and needs no report line
	const report = new Report();
	assert.deepEqual(plan(`query { getPostList(where: null, size: null) { total } }`, report).fields[0]!.args, { sort: [], where: null, filter: null, size: null, from: null, id: null });
	assert.deepEqual(report.items(), []);
	const get = plan(`query { getBook(_id: "2dec2ee7") { title } }`);
	assert.equal(get.fields[0]!.op, "get");
	assert.equal(get.fields[0]!.args.id, "2dec2ee7");
	assert.equal(get.paginatedAlias, null);
});

test("where and filter keep equality on stored fields and report the rest", () => {
	const report = new Report();
	const p = plan(
		`query {
  getPostList(where: {title: {eq: "A"}, deck: {match: "word"}, _enabled: {eq: true}}) { items { title } }
  more: getPostList(filter: {bool: {must: [{match: {_enabled: true}}, {term: {title: "B"}}], must_not: {match: {deck: "x"}}}}) { items { title } }
  any: getBookList(where: {type: {in: ["paperback", "hardcover"]}}) { items { title } }
  words: getPostList(filter: {bool: {must: [{match: {deck: "pirate ship"}}]}}) { items { title } }
  pages: getBookList(filter: {match: {totalPages: 120}}) { items { title } }
}`,
		report,
	);
	const [posts, more, books, words, pages] = p.fields;
	// A match on text inside must_not is left out like one inside must, so nothing is excluded
	assert.equal(more!.args.exclude, undefined);
	assert.deepEqual(posts!.args.where, { title: "A", _enabled: true });
	assert.deepEqual(more!.args.filter, { _enabled: true, title: "B" });
	assert.deepEqual(books!.args.where, { type: ["paperback", "hardcover"] });
	// match runs on analyzed text in TakeShape, so only a boolean or number match is an equality
	assert.deepEqual(words!.args.filter, {});
	assert.deepEqual(pages!.args.filter, { total_pages: 120 });
	assert.deepEqual(
		report.items().map((i) => [i.kind, i.line, i.construct]),
		[
			["not-translated", 2, "deck"],
			["not-translated", 3, "deck"],
			["not-translated", 5, "deck"],
		],
	);
	assert.match(report.items()[0]!.message, /left out/);
	assert.match(report.items()[2]!.message, /match/);
});

// The status rule reads a query variable's default as the route's values: a defaulted $w of {_enabled: {eq: false}}
// lists drafts, as ts2emdash --site reads it
test("a list's status reads query variable defaults", () => {
	const report = new Report();
	const [posts] = plan("query ($w: TSWhereInput = {_enabled: {eq: false}}) { getPostList(where: $w) { items { title } } }", report).fields;
	assert.equal((posts!.args.where as Record<string, unknown> | null)?._enabled ?? (posts!.args.filter as Record<string, unknown> | null)?._enabled, false);
});

test("drafts follow TakeShape's onlyEnabled default", () => {
	const fields = plan(`query {
  plain: getPostList { items { title } }
  filtered: getPostList(where: {title: {eq: "A"}}) { items { title } }
  esFiltered: getPostList(filter: {term: {title: "A"}}) { items { title } }
  published: getPostList(where: {title: {eq: "A"}, _enabled: {eq: true}}) { items { title } }
  unpublished: getPostList(where: {_enabled: {eq: false}}) { items { title } }
}`).fields;
	const drafts = Object.fromEntries(fields.map((f) => [f.alias, listOptions(f).includeDrafts]));
	assert.deepEqual(drafts, { plain: false, filtered: true, esFiltered: true, published: false, unpublished: false });
	assert.equal(listOptions(fields[0]!).defaultSize, 20);
});

test("unsupported fields are reported and left out of the plan", () => {
	const report = new Report();
	const p = plan(
		`query {
  getPostList(terms: "peter") {
    items {
      title
      nope
      _status
      featureImage { path captionHtml }
      author { name postSet { total } }
    }
  }
  getGenreList { items { title } }
}`,
		report,
	);
	assert.equal(p.fields.length, 1);
	const items = p.fields[0]!.selection.find((s) => s.alias === "items")!;
	assert.deepEqual(items.selection.map((s) => s.alias), ["title", "featureImage", "author"]);
	assert.deepEqual(items.selection[1]!.selection.map((s) => s.alias), ["path"]);
	// A reverse field under a reference is fine
	assert.deepEqual(items.selection[2]!.selection.map((s) => s.alias), ["name", "postSet"]);
	assert.deepEqual(
		report.items().map((i) => [i.line, i.construct]),
		[
			[2, "terms"],
			[5, "nope"],
			[6, "_status"],
			[7, "captionHtml"],
			[11, "getGenreList"],
		],
	);
});

test("rich-text image parameters the image endpoint ignores are reported", () => {
	const report = new Report();
	const p = plan(
		`query {
  getBookList {
    items {
      bodyHtml(
        imageConfig: {w: 300, fit: "crop", dpr: 2, blur: 10}
        images: {large: {w: 800, fm: "webp", crop: "faces"}, small: {h: 100, fit: "facearea"}}
        classPrefix: "rt-"
      )
    }
  }
}`,
		report,
	);
	const html = p.fields[0]!.selection[0]!.selection[0]!;
	// The arguments still reach the renderer whole; only the report changes
	assert.deepEqual(html.source, {
		kind: "richTextHtml",
		field: "body",
		sidecar: "takeshape_rich_text",
		args: { imageConfig: { w: 300, fit: "crop", dpr: 2, blur: 10 }, images: { large: { w: 800, fm: "webp", crop: "faces" }, small: { h: 100, fit: "facearea" } }, classPrefix: "rt-" },
	});
	assert.deepEqual(
		report.items().map((i) => [i.kind, i.file, i.line, i.construct, i.message]),
		[
			["image-param", "data/test.graphql", 5, "blur", '"bodyHtml" passes "blur" in imageConfig: the image endpoint ignores it.'],
			["image-param", "data/test.graphql", 6, "fit", '"bodyHtml" passes "fit" in images.small: the image endpoint ignores "facearea" and resizes as fit "clip" does.'],
		],
	);
});

test("an old-format list query returns a bare array", () => {
	const p = plan(`query { books: getBookList { title } }`);
	const f = p.fields[0]!;
	assert.equal(f.legacyListShape, true);
	assert.deepEqual(f.selection.map((s) => s.alias), ["title"]);
	// takeshape-ssg cannot paginate an old-format list
	assert.equal(p.paginatedAlias, null);
});

test("aliases, fragments and variables", () => {
	const report = new Report();
	const p = plan(
		`query Books($limit: Int) {
  list: getBookList(size: $limit) { items { ...BookBits heading: title type: __typename kind: _contentTypeName } }
}
fragment BookBits on Book { title author { name } }`,
		report,
	);
	assert.deepEqual(p.variables, ["limit"]);
	const items = p.fields[0]!.selection.find((s) => s.alias === "items")!;
	assert.deepEqual(items.selection.map((s) => s.alias), ["title", "author", "heading", "type", "kind"]);
	// The GraphQL type name is the shape name; _contentTypeName is its camelCase, as TakeShape resolved it
	assert.deepEqual(items.selection[3]!.source, { kind: "meta", name: "__typename" });
	assert.deepEqual(items.selection[4]!.source, { kind: "meta", name: "_contentTypeName" });
	assert.equal(p.fields[0]!.args.size, null);
	assert.deepEqual(report.items().map((i) => [i.line, i.construct]), [[2, "size"]]);
	assert.match(report.items()[0]!.message, /variable/);
});

test("emitted loaders are deterministic and live under src/loaders", () => {
	const source = readFileSync(join(templates, "data/books.graphql"), "utf8");
	const a = emitLoader(planQuery("data/books.graphql", source, schema, fieldMap, new Report()));
	const b = emitLoader(planQuery("data/books.graphql", source, schema, fieldMap, new Report()));
	assert.equal(a.path, "src/loaders/data/books.ts");
	assert.equal(a.source, b.source);
	assert.match(a.source, /from "\.\.\/\.\.\/lib\/takeshape\/query\.ts"/);
	assert.doesNotMatch(a.source, /\u2014/);
});

test("a getX without a literal id comes back null", () => {
	const report = new Report();
	const p = plan(`query ($id: ID!) {\n  byVariable: getBook(_id: $id) { title }\n  noId: getBook { title }\n}`, report);
	assert.deepEqual(p.fields.map((f) => f.args.id), [null, null]);
	assert.deepEqual(report.items().map((i) => [i.kind, i.line, i.construct]), [
		["not-translated", 2, "_id"],
		["not-translated", 3, "getBook"],
	]);
	for (const item of report.items()) assert.match(item.message, /null/);
});

test("without legacy fields, loaders use EmDash's order and never read takeshape_ columns", () => {
	const bare = shapeBooksFieldMap(["--no-legacy-fields"]);
	const report = new Report();
	const p = planQuery(
		"data/bare.graphql",
		`query {\n  getPostList(sort: [{field: "_enabledAt", order: "desc"}]) { items { _id title _createdAt _contentTypeName } }\n  getBook(_id: "2dec2ee7") { title }\n}`,
		schema,
		bare,
		report,
	);
	assert.equal(p.legacyFields, false);
	const items = p.fields[0]!.selection.find((s) => s.alias === "items")!;
	assert.deepEqual(items.selection.map((s) => s.alias), ["title", "_contentTypeName"]);
	assert.deepEqual(p.fields[0]!.args.sort, []);
	assert.equal(p.fields[1]!.args.id, null);
	const lines = report.items().map((i) => [i.kind, i.line, i.construct]);
	assert.deepEqual(lines, [
		["query", undefined, "--no-legacy-fields"],
		["not-translated", 2, "_enabledAt"],
		["not-translated", 2, "_id"],
		["not-translated", 2, "_createdAt"],
		["not-translated", 3, "_id"],
	]);
	assert.match(report.items()[0]!.message, /EmDash's order/);
	assert.match(report.items()[0]!.message, /TakeShape id/);
	assert.doesNotMatch(emitLoader(p).source, /takeshape_/);
});

test("without a term order slot, terms come in label order and the report says so", () => {
	const old: FieldMap = JSON.parse(JSON.stringify(fieldMap));
	for (const s of Object.values(old.shapes)) if (s.kind === "collection") delete (s as { termOrder?: unknown }).termOrder;
	const report = new Report();
	planQuery("data/posts.graphql", readFileSync(join(templates, "data/posts.graphql"), "utf8"), schema, old, report);
	assert.deepEqual(report.items().map((i) => [i.kind, i.line, i.construct]), [["query", 8, "tags"]]);
	assert.match(report.items()[0]!.message, /label order/);
});
