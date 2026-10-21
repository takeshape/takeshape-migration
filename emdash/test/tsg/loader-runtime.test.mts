/**
 * The loader runtime (tsg2astro/runtime/query.ts) and the loaders emit-loader.mts writes, run against a stub
 * EmDashApi. The stub filters by status, `where` and `limit` the way getEmDashCollection does and leaves the
 * order to the runtime. Given `select`, it returns only those columns and the system ones, as rows.ts does, so a
 * loader that names too few columns builds the wrong response here. Like EmDash 1.3, it keeps reference fields out of `data` and answers them through
 * `references` and `referrers`, each for a whole list at once. runtime/references.ts, which reads them from
 * EmDash's tables, has its own test against a real database (references.test.mts), and the real EmDash calls run
 * end to end in the e2e site build.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FieldMap } from "../../ts2emdash.mts";
import { emitLoader } from "../../tsg2astro/emit-loader.mts";
import { listOptions, planQuery } from "../../tsg2astro/queries.mts";
import { Report } from "../../tsg2astro/report.mts";
import { renderRichText } from "../../tsg2astro/runtime/richtext.ts";
import type { PTBlock, RichTextSidecar } from "../../tsg2astro/runtime/portable-text.ts";
import { withPublicOrigin } from "../../tsg2astro/runtime/public-origin.ts";
import { assetValue, assetValues, entryId, getEntry, listEntries, references, reverseReferences, termsOf } from "../../tsg2astro/runtime/query.ts";
import type { EmDashApi, Entry, QueryArgs } from "../../tsg2astro/runtime/query.ts";
import { loadTakeShapeSchema } from "../../tsg2astro/schema.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = join(root, "test", "fixtures", "shape-books");
const templates = join(root, "test", "tsg", "sites", "shape-books", "site", "src", "templates");
// Inside the repo, so the copied runtime finds github-slugger and prismjs in emdash/node_modules
const project = join(root, "test", ".out", `tsg-loaders-${process.pid}`);
after(() => rmSync(project, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// The stub API
// ---------------------------------------------------------------------------

type Term = { slug: string; label: string };
/** `referenceFields`: more reference fields than the seed's, as "collection.field" to the target collection. */
type StubData = { collections: Record<string, Entry[]>; terms?: Record<string, Record<string, Term[]>>; referenceFields?: Record<string, string> };
/** One read of a reference field (`references`) or of a reverse field (`referrers`), for every entry it names. */
type ReferenceCall = { kind: "references" | "referrers"; collection: string; field: string; ids: string[] };

function stubApi({ collections, terms = {}, referenceFields = {} }: StubData): EmDashApi & { calls: Array<{ type: string; filter: Record<string, unknown> }>; referenceCalls: ReferenceCall[] } {
	const calls: Array<{ type: string; filter: Record<string, unknown> }> = [];
	const referenceCalls: ReferenceCall[] = [];
	const targets: Record<string, string> = { ...SEED_REFERENCE_FIELDS, ...referenceFields };
	// What EmDash returns for an entry: every field but the reference fields, which have no column. With `select`,
	// only those fields and the system ones, as rows.ts reads them
	const stored = (collection: string, e: Entry, select?: unknown): Entry => {
		const keep = Array.isArray(select) ? new Set([...SYSTEM_FIELDS, ...(select as string[])]) : null;
		return { id: e.id, data: Object.fromEntries(Object.entries(e.data).filter(([k]) => !(`${collection}.${k}` in targets) && (!keep || keep.has(k)))) };
	};
	return {
		calls,
		referenceCalls,
		async collection(type, filter) {
			calls.push({ type, filter });
			const status = (filter.status as string | undefined) ?? "published";
			const where = (filter.where ?? {}) as Record<string, unknown>;
			let entries = (collections[type] ?? []).filter((e) => e.data.status === status);
			for (const [key, want] of Object.entries(where)) {
				entries = entries.filter((e) => (Array.isArray(want) ? want.includes(e.data[key]) : e.data[key] === want));
			}
			// EmDash orders by created_at desc; the runtime must not depend on it, so the stub reverses insertion order
			entries = [...entries].reverse();
			if (typeof filter.limit === "number") entries = entries.slice(0, filter.limit);
			return { entries: entries.map((e) => stored(type, e, filter.select)) };
		},
		async entry(type, slugOrId) {
			const found = (collections[type] ?? []).find((e) => e.data.status === "published" && (e.id === slugOrId || e.data.id === slugOrId));
			return found ? stored(type, found) : null;
		},
		async byIds(type, ids, select) {
			calls.push({ type, filter: { byIds: ids } });
			return (collections[type] ?? []).filter((e) => e.data.status === "published" && ids.includes(e.data.id as string)).map((e) => stored(type, e, select));
		},
		async terms(collection, entryIds, taxonomy) {
			const out = new Map<string, Term[]>();
			for (const id of entryIds) {
				const list = terms[`${collection}:${taxonomy}`]?.[id] ?? [];
				// EmDash returns terms in label order
				out.set(id, [...list].sort((a, b) => a.label.localeCompare(b.label)));
			}
			return out;
		},
		// references.ts: for any entry the loader renders, the published entries the field points at, in stored order
		async references(collection, entries, field, select) {
			referenceCalls.push({ kind: "references", collection, field, ids: entries.map(entryId) });
			const target = targets[`${collection}.${field}`];
			return new Map(
				entries.map((entry) => {
					const parent = (collections[collection] ?? []).find((e) => e.data.id === entryId(entry));
					if (!target || !parent) return [entryId(entry), []];
					const found = [parent.data[field]]
						.flat()
						.map((ref) => (collections[target] ?? []).find((e) => e.data.id === ref && e.data.status === "published"))
						.filter((e): e is Entry => e !== undefined)
						.map((e) => stored(target, e, select));
					return [entryId(entry), found];
				}),
			);
		},
		// For each published target, the published entries whose field points at it, in no set order
		async referrers(collection, field, list, select) {
			referenceCalls.push({ kind: "referrers", collection, field, ids: list.map(entryId) });
			const target = targets[`${collection}.${field}`];
			return new Map(
				list.map((t) => {
					const live = target !== undefined && (collections[target] ?? []).some((e) => e.data.id === entryId(t) && e.data.status === "published");
					// EmDash's order is not TakeShape's: the runtime sorts
					const found = (collections[collection] ?? [])
						.filter((e) => live && e.data.status === "published" && [e.data[field]].flat().includes(entryId(t)))
						.reverse()
						.map((e) => stored(collection, e, select));
					return [entryId(t), found];
				}),
			);
		},
	};
}

// rows.ts reads these with every column choice
const SYSTEM_FIELDS = ["id", "slug", "status", "authorId", "primaryBylineId", "createdAt", "updatedAt", "publishedAt", "scheduledAt", "locale", "translationGroup"];

let seq = 0;
function entry(fields: Record<string, unknown>, status = "published"): Entry {
	seq++;
	const id = (fields.id as string | undefined) ?? `01EMDASH${String(seq).padStart(4, "0")}`;
	return { id: (fields.slug as string | undefined) ?? `slug-${seq}`, data: { status, ...fields, id } };
}
const image = (storageKey: string, extra: Record<string, unknown> = {}) => ({
	provider: "local",
	id: `media-${storageKey}`,
	alt: "",
	width: 4,
	height: 3,
	mimeType: "image/jpeg",
	filename: `${storageKey}.jpg`,
	meta: { storageKey },
	...extra,
});
const NO_ARGS: QueryArgs = { sort: [], where: null, filter: null, size: null, from: null, id: null };
const titles = (entries: Entry[]) => entries.map((e) => e.data.title);

// ---------------------------------------------------------------------------
// Emitted loaders, written into a project folder next to a copy of the runtime
// ---------------------------------------------------------------------------

function convert(name: string, extra: string[] = []): { fieldMap: FieldMap; seed: Record<string, any> } {
	const out = join(project, name);
	const res = spawnSync(process.execPath, ["--no-warnings", "ts2emdash.mts", fixture, "--out", join(out, "seed.json"), "--report", join(out, "report.md"), ...extra], { cwd: root, encoding: "utf8" });
	assert.equal(res.status, 0, `ts2emdash exited ${res.status}: ${res.stderr}`);
	return { fieldMap: JSON.parse(readFileSync(join(out, "takeshape-field-map.json"), "utf8")), seed: JSON.parse(readFileSync(join(out, "seed.json"), "utf8")) };
}

mkdirSync(project, { recursive: true });
cpSync(join(root, "tsg2astro", "runtime"), join(project, "src", "lib", "takeshape"), { recursive: true });
const converted = convert("convert");
const { fieldMap } = converted;
/**
 * The seed's reference fields, as "collection.field" to the target collection. EmDash 1.3 makes each one a
 * relation when it applies the seed, so none of them is a column.
 */
const SEED_REFERENCE_FIELDS: Record<string, string> = Object.fromEntries(
	(converted.seed.collections as Array<{ slug: string; fields: Array<{ slug: string; type: string; validation?: { targetCollection?: string } }> }>).flatMap((c) =>
		c.fields.filter((f) => f.type === "reference" && f.validation?.targetCollection).map((f) => [`${c.slug}.${f.slug}`, f.validation!.targetCollection!] as const),
	),
);
const schema = loadTakeShapeSchema(JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8")));

type Load = (api: EmDashApi, variables?: Record<string, unknown>, options?: { paginate?: boolean }) => Promise<Record<string, any>>;
async function loader(file: string, source = readFileSync(join(templates, file), "utf8"), map: FieldMap = fieldMap, model = schema): Promise<Load> {
	const emitted = emitLoader(planQuery(file, source, model, map, new Report()));
	const path = join(project, emitted.path);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, emitted.source);
	return ((await import(pathToFileURL(path).href)) as { load: Load }).load;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("a list that is cut reads what decides it for every entry, then the kept entries' columns", async () => {
	const posts = ["a", "b", "c", "d", "e"].map((t, i) => entry({ title: t.toUpperCase(), body: `long text ${t}`, takeshape_id: t, takeshape_created_at: `2020-0${i + 1}-01T00:00:00.000Z` }));
	const drafted = entry({ title: "Z", body: "draft", takeshape_id: "z", takeshape_created_at: "2021-01-01T00:00:00.000Z" }, "draft");
	const api = stubApi({ collections: { posts: [...posts, drafted] } });
	const options = { includeDrafts: false, defaultSize: null, select: ["title"] };
	const sized = await listEntries(api, "posts", { ...NO_ARGS, size: 2 }, options);
	assert.deepEqual(titles(sized), ["E", "D"]);
	assert.equal(sized.total, 5);
	const ids = (list: Entry[]) => list.map(entryId);
	assert.deepEqual(
		api.calls.map((c) => c.filter),
		[
			// The default order and its tie break decide the list
			{ status: "published", select: ["takeshape_created_at", "takeshape_id"] },
			{ status: "published", where: { id: ids(sized) }, select: ["title", "takeshape_created_at", "takeshape_id"] },
		],
	);
	assert.ok(!("body" in (sized[0] as Entry).data), "only the columns asked for");

	// Kept whole: one read with both
	api.calls.length = 0;
	const whole = await listEntries(api, "posts", NO_ARGS, options);
	assert.deepEqual(titles(whole), ["E", "D", "C", "B", "A"]);
	assert.deepEqual(
		api.calls.map((c) => c.filter),
		[{ status: "published", select: ["title", "takeshape_created_at", "takeshape_id"] }],
	);

	// A route's pick: the entries it keeps, from the whole list in order, and the columns its paths read
	api.calls.length = 0;
	const seen: string[][] = [];
	const pick = { columns: ["slug"], entries: (list: Entry[]) => (seen.push(ids(list)), list.slice(1, 3)) };
	const picked = await listEntries(api, "posts", NO_ARGS, { ...options, pick });
	// It sees every entry in order, with what decides the list and its own columns, but no title
	assert.deepEqual(seen, [ids(whole)]);
	assert.deepEqual(titles(picked), ["D", "C"]);
	assert.equal(picked.total, 5);
	assert.deepEqual(api.calls[0]?.filter, { status: "published", select: ["takeshape_created_at", "takeshape_id", "slug"] });
	assert.deepEqual(await listEntries(api, "posts", NO_ARGS, { ...options, pick: { columns: [], entries: () => [] } }), Object.assign([], { total: 5 }), "a pick that keeps nothing reads nothing more");

	// Drafts too: each status read again by id
	api.calls.length = 0;
	const both = await listEntries(api, "posts", { ...NO_ARGS, where: {}, size: 2 }, { ...options, includeDrafts: true });
	assert.deepEqual(titles(both), ["Z", "E"]);
	assert.deepEqual(
		api.calls.slice(2).map((c) => c.filter),
		[
			{ status: "draft", where: { id: [entryId(drafted)] }, select: ["title", "takeshape_created_at", "takeshape_id"] },
			{ status: "published", where: { id: [entryId(posts[4] as Entry)] }, select: ["title", "takeshape_created_at", "takeshape_id"] },
		],
	);
	// Light columns only (no rich text or JSON): one read with them, cut in memory
	api.calls.length = 0;
	const light = await listEntries(api, "posts", { ...NO_ARGS, size: 2 }, { ...options, heavy: [] });
	assert.deepEqual(titles(light), ["E", "D"]);
	assert.deepEqual(api.calls.map((c) => c.filter), [{ status: "published", select: ["title", "takeshape_created_at", "takeshape_id"] }]);
	// Heavy columns: the light ones come with the first read, the heavy ones only for the entries kept
	api.calls.length = 0;
	const heavy = await listEntries(api, "posts", { ...NO_ARGS, size: 2 }, { ...options, select: ["title", "body"], heavy: ["body"] });
	assert.equal((heavy[0] as Entry).data.body, "long text e");
	assert.deepEqual(
		api.calls.map((c) => c.filter),
		[
			{ status: "published", select: ["takeshape_created_at", "takeshape_id", "title"] },
			{ status: "published", where: { id: ids(heavy) }, select: ["title", "body", "takeshape_created_at", "takeshape_id"] },
		],
	);
	// Without select: every column, in one read, as before
	api.calls.length = 0;
	const all = await listEntries(api, "posts", { ...NO_ARGS, size: 2 }, { includeDrafts: false, defaultSize: null });
	assert.equal((all[0] as Entry).data.body, "long text e");
	assert.deepEqual(api.calls.map((c) => c.filter), [{ status: "published" }]);
});

test("default-order-created-desc", async () => {
	const posts = [
		entry({ title: "old", takeshape_id: "c", takeshape_created_at: "2020-01-01T00:00:00.000Z" }),
		entry({ title: "tie-b", takeshape_id: "b", takeshape_created_at: "2020-06-01T00:00:00.000Z" }),
		entry({ title: "new", takeshape_id: "z", takeshape_created_at: "2021-01-01T00:00:00.000Z" }),
		entry({ title: "tie-a", takeshape_id: "a", takeshape_created_at: "2020-06-01T00:00:00.000Z" }),
	];
	const api = stubApi({ collections: { posts } });
	const list = await listEntries(api, "posts", NO_ARGS, { includeDrafts: false, defaultSize: null });
	assert.deepEqual(titles(list), ["new", "tie-a", "tie-b", "old"]);

	// An explicit sort keeps takeshape_id as the last key; a missing value sorts last either way, as in Elasticsearch
	const sorted = await listEntries(api, "posts", { ...NO_ARGS, sort: [{ field: "takeshape_created_at", order: "asc" }] }, { includeDrafts: false, defaultSize: null });
	assert.deepEqual(titles(sorted), ["old", "tie-a", "tie-b", "new"]);
	const withGap = stubApi({ collections: { posts: [...posts, entry({ title: "undated", takeshape_id: "0" })] } });
	for (const order of ["asc", "desc"] as const) {
		const list = await listEntries(withGap, "posts", { ...NO_ARGS, sort: [{ field: "takeshape_created_at", order }] }, { includeDrafts: false, defaultSize: null });
		assert.equal(list.at(-1)?.data.title, "undated", order);
	}
});

test("an entry made in EmDash after the move reads EmDash's own id and dates", async () => {
	// EmDash stamps imported entries with the import time; the converter's fields keep TakeShape's
	const imported = { createdAt: new Date("2026-10-20T09:00:00.000Z"), updatedAt: new Date("2026-10-20T09:00:00.000Z"), publishedAt: new Date("2026-10-20T09:00:00.000Z") };
	const migrated = [
		entry({ title: "older", ...imported, takeshape_id: "b", takeshape_created_at: "2019-05-01T00:00:00.000Z", takeshape_published_at: "2019-05-02T00:00:00.000Z", takeshape_updated_at: "2019-05-03T00:00:00.000Z" }),
		entry({ title: "old", ...imported, takeshape_id: "a", takeshape_created_at: "2020-01-01T00:00:00.000Z", takeshape_published_at: "2020-01-02T00:00:00.000Z", takeshape_updated_at: "2020-01-03T00:00:00.000Z" }),
	];
	// Made after the cutover: no TakeShape id or dates
	const fresh = entry({
		title: "new in EmDash",
		id: "01NEWENTRY",
		createdAt: new Date("2026-11-02T10:00:00.000Z"),
		updatedAt: new Date("2026-11-03T10:00:00.000Z"),
		publishedAt: new Date("2026-11-02T12:00:00.000Z"),
		takeshape_id: null,
		takeshape_created_at: null,
		takeshape_published_at: null,
		takeshape_updated_at: null,
	});
	const api = stubApi({ collections: { posts: [fresh, ...migrated] } });
	const options = { includeDrafts: false, defaultSize: null };
	// TakeShape's default order, newest _createdAt first, puts it first
	assert.deepEqual(titles(await listEntries(api, "posts", NO_ARGS, options)), ["new in EmDash", "old", "older"]);
	// and so does a sort on _enabledAt (published) or _updatedAt, either way
	for (const field of ["takeshape_published_at", "takeshape_updated_at"]) {
		assert.deepEqual(titles(await listEntries(api, "posts", { ...NO_ARGS, sort: [{ field, order: "desc" }] }, options)), ["new in EmDash", "old", "older"], field);
		assert.deepEqual(titles(await listEntries(api, "posts", { ...NO_ARGS, sort: [{ field, order: "asc" }] }, options)), ["older", "old", "new in EmDash"], field);
	}

	const load = await loader("data/meta.graphql", `query { getPostList { items { title _id _enabledAt _createdAt _updatedAt } } }`);
	const { getPostList } = await load(api);
	assert.deepEqual(getPostList.items, [
		{ title: "new in EmDash", _id: "01NEWENTRY", _enabledAt: "2026-11-02T12:00:00.000Z", _createdAt: "2026-11-02T10:00:00.000Z", _updatedAt: "2026-11-03T10:00:00.000Z" },
		// Migrated entries keep TakeShape's values
		{ title: "old", _id: "a", _enabledAt: "2020-01-02T00:00:00.000Z", _createdAt: "2020-01-01T00:00:00.000Z", _updatedAt: "2020-01-03T00:00:00.000Z" },
		{ title: "older", _id: "b", _enabledAt: "2019-05-02T00:00:00.000Z", _createdAt: "2019-05-01T00:00:00.000Z", _updatedAt: "2019-05-03T00:00:00.000Z" },
	]);
	// A draft made in EmDash has no publish date
	const draft = entry({ title: "draft", id: "01DRAFT", createdAt: new Date("2026-11-04T00:00:00.000Z"), updatedAt: new Date("2026-11-04T00:00:00.000Z"), publishedAt: null }, "draft");
	const withDraft = await (await loader("data/meta-all.graphql", `query { getPostList(where: {_enabled: {eq: false}}) { items { title _enabledAt } } }`))(stubApi({ collections: { posts: [draft] } }));
	assert.deepEqual(withDraft.getPostList.items, [{ title: "draft", _enabledAt: null }]);
});

test("default-size", async () => {
	const books = Array.from({ length: 25 }, (_, i) => entry({ title: `book ${i}`, takeshape_id: `id-${String(i).padStart(2, "0")}`, takeshape_created_at: `2020-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }));
	const api = stubApi({ collections: { books } });
	// TakeShape returned at most 20 without a size, and counted them all in total
	const capped = await listEntries(api, "books", NO_ARGS, { includeDrafts: false, defaultSize: 20 });
	assert.equal(capped.length, 20);
	assert.equal(capped.total, 25);
	assert.equal(capped[0]!.data.title, "book 24");
	const page = await listEntries(api, "books", { ...NO_ARGS, size: 5, from: 3 }, { includeDrafts: false, defaultSize: 20 });
	assert.deepEqual(titles(page), ["book 21", "book 20", "book 19", "book 18", "book 17"]);
	assert.equal(page.total, 25);

	// A context query gets 20; the same query paginated by takeshape-ssg gets every entry
	const site = await loader("data/site.graphql");
	const authors = [entry({ name: "Ann", id: "author-ann" })];
	const withAuthors = stubApi({ collections: { books, authors, site_settings: [entry({ site_title: "Books" })] } });
	const context = await site(withAuthors);
	assert.equal(context.books.items.length, 20);
	assert.equal(context.books.total, 25);
	assert.equal(context.settings.siteTitle, "Books");
	const paginated = await (await loader("data/books.graphql"))(withAuthors, {}, { paginate: true });
	assert.equal(paginated.getBookList.items.length, 25);
	assert.equal(paginated.getBookList.total, 25);
});

test("reverse-relation", async () => {
	const ann = entry({ name: "Ann", id: "author-ann", takeshape_created_at: "2020-01-01T00:00:00.000Z" });
	const bob = entry({ name: "Bob", id: "author-bob", takeshape_created_at: "2020-01-02T00:00:00.000Z" });
	const books = [
		entry({ title: "Ann 1", author: "author-ann", takeshape_id: "b1", takeshape_created_at: "2020-02-01T00:00:00.000Z", cover_image: image("ann1") }),
		entry({ title: "Bob 1", author: "author-bob", takeshape_id: "b2", takeshape_created_at: "2020-02-02T00:00:00.000Z" }),
		entry({ title: "Ann 2", author: "author-ann", takeshape_id: "b3", takeshape_created_at: "2020-02-03T00:00:00.000Z" }),
		entry({ title: "Ann draft", author: "author-ann", takeshape_id: "b4", takeshape_created_at: "2020-02-04T00:00:00.000Z" }, "draft"),
	];
	assert.deepEqual(titles(await reverseReferences(stubApi({ collections: { books, authors: [ann, bob] } }), "books", "author", ann)), ["Ann 2", "Ann 1"]);
	// A reverse field is a list without size: 20 entries, and total counts them all
	const many = Array.from({ length: 21 }, (_, i) => entry({ title: `Bob ${i}`, author: "author-bob", takeshape_id: `m${String(i).padStart(2, "0")}`, takeshape_created_at: "2021-01-01T00:00:00.000Z" }));
	const bobs = await reverseReferences(stubApi({ collections: { books: many, authors: [bob] } }), "books", "author", bob);
	assert.equal(bobs.length, 20);
	assert.equal(bobs.total, 21);
	assert.equal(bobs[0]!.data.title, "Bob 0");

	const api = stubApi({ collections: { authors: [ann, bob], books } });
	const authors = await loader("data/authors.graphql");
	const page = (await authors(api, {}, { paginate: true })).page;
	assert.deepEqual(page.items.map((a: any) => a.name), ["Bob", "Ann"]);
	assert.deepEqual(page.items[1].authored, {
		total: 2,
		items: [
			{ title: "Ann 2", coverImage: null },
			{ title: "Ann 1", coverImage: { path: "ann1" } },
		],
	});
	assert.deepEqual(page.items[0].authored, { total: 1, items: [{ title: "Bob 1", coverImage: null }] });
	// One read for both authors, and no read of the whole book list
	assert.equal(api.calls.filter((c) => c.type === "books").length, 0);
	assert.deepEqual(api.referenceCalls, [{ kind: "referrers", collection: "books", field: "author", ids: ["author-bob", "author-ann"] }]);

	// A draft author has no books, as getEmDashReferences leaves a draft target out of every book
	const dee = entry({ name: "Dee", id: "author-dee" }, "draft");
	const withDraft = stubApi({ collections: { authors: [dee], books: [entry({ title: "Dee 1", author: "author-dee", takeshape_id: "d1" })] } });
	assert.deepEqual((await reverseReferences(withDraft, "books", "author", dee)).total, 0);
});

test("null-relations", async () => {
	const books = [
		entry({ title: "Nothing attached", author: "deleted-author", cover_image: null, body: null, takeshape_created_at: "2020-01-02T00:00:00.000Z" }),
		entry({ title: "Empty body", body: [], takeshape_created_at: "2020-01-01T00:00:00.000Z" }),
	];
	const api = stubApi({ collections: { books, authors: [] } });
	const load = await loader("data/books.graphql");
	const { getBookList } = await load(api);
	const [first, second] = getBookList.items;
	assert.equal(first.coverImage, null);
	assert.equal(first.author, null);
	assert.equal(first.genre, null);
	assert.equal(first.bodyHtml, "");
	assert.equal(second.bodyHtml, "");
	assert.equal(second.author, null);
	assert.equal(assetValue(undefined), null);
	assert.equal(assetValue({ provider: "external", id: "x", src: "https://example.com/a.jpg" }), null);
	// The converter stores an image list as repeater rows holding `image`; empty rows drop out
	assert.deepEqual(assetValues([{ image: image("a") }, { image: null }, null]).map((a) => a.path), ["a"]);
	assert.deepEqual(assetValues(null), []);

	// A homepage with nothing filled in, and no homepage at all
	const homepage = await loader("data/homepage.graphql");
	const empty = await homepage(stubApi({ collections: { homepage: [entry({ title: "Home" })], posts: [], books: [], authors: [] } }));
	// An inline object with nothing stored in it is null, as TakeShape returned for an object never saved
	assert.deepEqual(empty.page, { title: "Home", hero: null, featuredBook: null });
	const heroOnly = await homepage(stubApi({ collections: { homepage: [entry({ title: "Home", hero_image: image("hero") })], posts: [], books: [], authors: [] } }));
	assert.deepEqual(heroOnly.page.hero, { image: { path: "hero" }, featuredPost: null });
	// A hero holding only a featured post was stored too, though EmDash keeps the link outside `data`
	const rabbit = entry({ title: "Rabbit" });
	const linkOnlyApi = stubApi({ collections: { homepage: [entry({ title: "Home", hero_featured_post: rabbit.data.id })], posts: [rabbit], books: [], authors: [] } });
	assert.deepEqual((await homepage(linkOnlyApi)).page.hero, { image: null, featuredPost: { title: "Rabbit", author: null } });
	// ...also when the query does not ask for the link
	const imageOnly = await loader("data/hero-image.graphql", `query { page: getHomepage { hero { image { path } } } }`);
	assert.deepEqual((await imageOnly(linkOnlyApi)).page.hero, { image: null });
	assert.deepEqual(empty.posts, { total: 0, items: [] });
	assert.equal((await homepage(stubApi({ collections: {} }))).page, null);
});

test("drafts-follow-takeshape", async () => {
	const posts = [
		entry({ title: "live", takeshape_id: "p1", takeshape_created_at: "2020-01-02T00:00:00.000Z" }),
		entry({ title: "draft", takeshape_id: "p2", takeshape_created_at: "2020-01-01T00:00:00.000Z" }, "draft"),
	];
	const api = stubApi({ collections: { posts } });
	const plan = planQuery(
		"data/drafts.graphql",
		`query {
  plain: getPostList { items { title } }
  filtered: getPostList(where: {title: {in: ["live", "draft"]}}) { items { title } }
  published: getPostList(where: {_enabled: {eq: true}}) { items { title } }
  unpublished: getPostList(where: {_enabled: {eq: false}}) { items { title } }
}`,
		schema,
		fieldMap,
		new Report(),
	);
	const seen: Record<string, unknown[]> = {};
	for (const field of plan.fields) seen[field.alias] = titles(await listEntries(api, "posts", field.args, listOptions(field)));
	// TakeShape's onlyEnabled default applies only to a list with neither where nor filter
	assert.deepEqual(seen, { plain: ["live"], filtered: ["live", "draft"], published: ["live"], unpublished: ["draft"] });

	// The emitted loader makes the same choice
	const load = await loader("data/drafts.graphql", `query { plain: getPostList { items { title } } filtered: getPostList(where: {title: {eq: "draft"}}) { items { title } } }`);
	const result = await load(api);
	assert.deepEqual(result.plain.items, [{ title: "live" }]);
	assert.deepEqual(result.filtered.items, [{ title: "draft" }]);
});

test("rich-text-html-field", async () => {
	const body: PTBlock[] = [
		{ _type: "block", _key: "a1", style: "h2", markDefs: [], children: [{ _type: "span", _key: "a1-s0", text: "Chapter one", marks: [] }] },
		{ _type: "image", _key: "b2", asset: { _ref: "media-1", url: "/_emdash/api/media/file/01COVER.jpg" }, alt: "A cover" },
		{ _type: "block", _key: "c3", style: "normal", markDefs: [], children: [{ _type: "span", _key: "c3-s0", text: "Some text & more", marks: ["strong"] }] },
	];
	const sidecar: RichTextSidecar = { body: { b2: { size: "large", assetId: "asset-1" } } };
	const books = [entry({ title: "Peter Pan", body, takeshape_rich_text: sidecar })];
	const api = stubApi({ collections: { books, authors: [] } });
	const { getBookList } = await (await loader("data/books.graphql"))(api);
	const expected = renderRichText(body, sidecar.body, { imageUrl: (src) => `/_emdash/api/media/file/${src.storageKey}` });
	assert.equal(getBookList.items[0].bodyHtml, expected);
	assert.match(expected, /<h2 id="chapter-one">/);
	assert.match(expected, /src="\/_emdash\/api\/media\/file\/01COVER\.jpg"/);

	// imageConfig and images map through the image filter's parameters, with no site defaults added
	const sized = await (await loader("data/sized.graphql", `query { getBookList { items { bodyHtml(imageConfig: {w: 300}, images: {large: {w: 800, fm: "webp"}}, classPrefix: "rt-") } } }`))(api);
	const html: string = sized.getBookList.items[0].bodyHtml;
	assert.match(html, /<figure class="rt-large"><img alt="A cover" src="\/_takeshape\/image\?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2F01COVER\.jpg&w=800&fm=webp"\/><\/figure>/);
	// Inside a request, as TakeShape's absolute CDN URLs were. The loaders import a copy of the runtime, as Vite's chunks
	// can, and still see the origin this module set
	const inRequest = await withPublicOrigin("https://site.test", async () => (await (await loader("data/sized.graphql", `query { getBookList { items { bodyHtml(imageConfig: {w: 300}, images: {large: {w: 800, fm: "webp"}}, classPrefix: "rt-") } } }`))(api)).getBookList.items[0].bodyHtml);
	assert.match(inRequest, /src="https:\/\/site\.test\/_takeshape\/image\?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2F01COVER\.jpg&w=800&fm=webp"/);
	const plain = await withPublicOrigin("https://site.test", async () => (await (await loader("data/books.graphql"))(api)).getBookList.items[0].bodyHtml);
	assert.match(plain, /src="https:\/\/site\.test\/_emdash\/api\/media\/file\/01COVER\.jpg"/);
});

// Lists of rows of text and images (touts, social links, heroes), which the converter keeps as an EmDash repeater
test("a repeater's rows come back as TakeShape returned them, an unset one as null", async () => {
	const map = structuredClone(fieldMap);
	const book = map.shapes.Book;
	assert.equal(book?.kind, "collection");
	if (book?.kind === "collection") {
		book.properties.quotes = {
			kind: "repeater",
			field: "quotes",
			properties: { text: { kind: "scalar", field: "text", type: "string" }, photo: { kind: "asset", field: "photo", multiple: false } },
		};
	}
	const books = [entry({ title: "Peter Pan", quotes: [{ text: "Second star", photo: image("star") }, { text: "No photo" }] }), entry({ title: "Hook" })];
	const api = stubApi({ collections: { books, authors: [] } });
	const { getBookList } = await (await loader("data/quotes.graphql", "query { getBookList { items { title quotes { text photo { path } } } } }", map))(api);
	const quotes = Object.fromEntries(getBookList.items.map((i: Record<string, any>) => [i.title, i.quotes]));
	assert.deepEqual(quotes["Peter Pan"], [
		{ text: "Second star", photo: { path: "star" } },
		{ text: "No photo", photo: null },
	]);
	assert.equal(quotes.Hook, null);
});

// A category page can ask storySet for the stories a filter leaves in, newest first. A reverse field is TakeShape's
// list resolver with the link as its base condition, so it takes a list's arguments.
test("a reverse field takes a list's arguments, and must_not leaves entries out", async () => {
	const ann = entry({ name: "Ann", id: "author-ann" });
	const book = (title: string, n: number) => entry({ title, author: "author-ann", takeshape_id: `b${n}`, takeshape_created_at: `2020-01-0${n}T00:00:00.000Z` });
	const books = [book("B", 1), book("A", 2), book("C", 3)];
	const api = stubApi({ collections: { authors: [ann], books } });
	const query = `query { getAuthorList { items {
		sorted: authored(sort: [{field: "title", order: "asc"}], size: 2) { total items { title } }
		notB: authored(filter: {bool: {must_not: {term: {title: "B"}}}}) { total items { title } }
		onlyA: authored(where: {title: {eq: "A"}}) { total items { title } }
	} } }`;
	const { getAuthorList } = await (await loader("data/reverse-args.graphql", query))(api);
	const [a] = getAuthorList.items;
	assert.deepEqual(a.sorted, { total: 3, items: [{ title: "A" }, { title: "B" }] });
	assert.deepEqual(a.notB, { total: 2, items: [{ title: "C" }, { title: "A" }] });
	assert.deepEqual(a.onlyA, { total: 1, items: [{ title: "A" }] });
	const { getBookList } = await (await loader("data/must-not.graphql", 'query { getBookList(filter: {bool: {must_not: [{term: {title: "B"}}, {terms: {title: ["C"]}}]}}) { total items { title } } }'))(api);
	assert.deepEqual(getBookList, { total: 1, items: [{ title: "A" }] });
});

// A reference field can be the child end of its relation: EmDash gives its links in the order the other end
// declared them, and the converter keeps TakeShape's order in takeshape_link_order
test("a multiple reference keeps TakeShape's order from the link order sidecar", async () => {
	const map = structuredClone(fieldMap);
	const book = map.shapes.Book;
	if (book?.kind === "collection") {
		book.properties.coauthors = { kind: "reference", field: "coauthors", target: "Author", multiple: true, relation: "authors_books_coauthors" };
		book.linkOrder = "takeshape_link_order";
	}
	const model = loadTakeShapeSchema(JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8")));
	model.shapes.get("Book")!.properties.coauthors = { name: "coauthors", kind: "relationship", multiple: true, targets: ["Author"], relatedName: null };
	const authors = ["Ann", "Bo", "Cy", "Di"].map((name) => entry({ name, id: `author-${name}`, takeshape_id: name.toLowerCase() }));
	// EmDash's order: Ann, Bo, Cy, Di. TakeShape kept Cy, Ann, Di; Bo was linked in EmDash after the move.
	const books = [
		entry({ title: "Peter Pan", coauthors: ["author-Ann", "author-Bo", "author-Cy", "author-Di"], takeshape_link_order: { coauthors: ["cy", "gone", "ann", "di"] } }),
		entry({ title: "Hook", coauthors: ["author-Di", "author-Ann"] }),
	];
	const api = stubApi({ collections: { books, authors }, referenceFields: { "books.coauthors": "authors" } });
	const { getBookList } = await (await loader("data/link-order.graphql", "query { getBookList { items { title coauthors { name } } } }", map, model))(api);
	const names = (title: string) => getBookList.items.find((b: { title: string }) => b.title === title).coauthors.map((a: { name: string }) => a.name);
	assert.deepEqual(names("Peter Pan"), ["Cy", "Ann", "Di", "Bo"]);
	// No order kept: EmDash's
	assert.deepEqual(names("Hook"), ["Di", "Ann"]);
});

// A reverse field without a related name (Category.storySet) lists the stories that reference the category through
// any field
test("an unnamed reverse field lists the entries that reference the parent through any field, once each", async () => {
	const map = structuredClone(fieldMap);
	const book = map.shapes.Book;
	if (book?.kind === "collection") book.properties.editor = { kind: "reference", field: "editor", target: "Author", multiple: false, relation: null };
	const model = loadTakeShapeSchema(JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8")));
	model.reverse.get("Author")!.set("bookSet", { shape: "Book", property: "author", multiple: false, others: [{ property: "editor", multiple: false }] });
	const ann = entry({ name: "Ann", id: "author-ann" });
	const book1 = (title: string, n: number, fields: Record<string, unknown>) => entry({ title, takeshape_id: `b${n}`, takeshape_created_at: `2020-01-0${n}T00:00:00.000Z`, ...fields });
	const books = [book1("Wrote", 1, { author: "author-ann" }), book1("Edited", 2, { editor: "author-ann" }), book1("Both", 3, { author: "author-ann", editor: "author-ann" }), book1("Neither", 4, {})];
	const api = stubApi({ collections: { books, authors: [ann] }, referenceFields: { "books.editor": "authors" } });
	const { getAuthorList } = await (await loader("data/any-field.graphql", "query { getAuthorList { items { bookSet { total items { title } } } } }", map, model))(api);
	assert.deepEqual(getAuthorList.items[0].bookSet, { total: 3, items: [{ title: "Both" }, { title: "Edited" }, { title: "Wrote" }] });
});

// A page can list people where: {type: {eq: "board"}} when type is a list: TakeShape's Elasticsearch matched a list
// that holds the value, where an EmDash equality matches none
test("a condition on a multi-select field keeps the entries whose list holds the value", async () => {
	const map = structuredClone(fieldMap);
	const book = map.shapes.Book;
	if (book?.kind === "collection") book.properties.kinds = { kind: "scalar", field: "kinds", type: "multiSelect" };
	const books = [entry({ title: "Board", kinds: ["board", "team"] }), entry({ title: "Team", kinds: ["team"] }), entry({ title: "None" })];
	const api = stubApi({ collections: { books, authors: [] } });
	const query = 'query { board: getBookList(where: {kinds: {eq: "board"}}) { total items { title } } notTeam: getBookList(filter: {bool: {must_not: {term: {kinds: "team"}}}}) { items { title } } }';
	const result = await (await loader("data/multi-select.graphql", query, map))(api);
	assert.deepEqual(result.board, { total: 1, items: [{ title: "Board" }] });
	assert.deepEqual(result.notTeam.items, [{ title: "None" }]);
});

// Routes can pass { slug } to one query, as in where: {slug: {eq: $slug}}
test("a where condition takes the variables the route passes", async () => {
	const books = [entry({ title: "Peter Pan" }), entry({ title: "Hook" })];
	const api = stubApi({ collections: { books, authors: [] } });
	const query = 'query ($t: String!, $not: String) { getBookList(where: {title: {eq: $t}}) { total items { title } } others: getBookList(filter: {bool: {must_not: {term: {title: $not}}}}) { total } }';
	const load = await loader("data/variables.graphql", query);
	const hook = await load(api, { t: "Hook", not: "Hook" });
	assert.deepEqual(hook.getBookList, { total: 1, items: [{ title: "Hook" }] });
	assert.equal(hook.others.total, 1);
	assert.equal((await load(api, { t: "Peter Pan" })).getBookList.items[0].title, "Peter Pan");
});

// A query variable's default applies when the route passes none, and a null the route passes stays null
test("a where condition takes a query variable's default when the route passes none", async () => {
	const books = [entry({ title: "Peter Pan" }), entry({ title: "Hook" })];
	const api = stubApi({ collections: { books, authors: [] } });
	const load = await loader("data/variable-default.graphql", 'query ($t: String = "Hook") { getBookList(where: {title: {eq: $t}}) { total items { title } } }');
	assert.deepEqual((await load(api)).getBookList, { total: 1, items: [{ title: "Hook" }] });
	assert.deepEqual((await load(api, { t: "Peter Pan" })).getBookList.items, [{ title: "Peter Pan" }]);
});

// A related field can link to stories and pages; links to several shapes are kept as a JSON list
test("a relationship to several shapes kept as JSON reads each link's target", async () => {
	const map = structuredClone(fieldMap);
	const book = map.shapes.Book;
	if (book?.kind === "collection") book.properties.related = { kind: "json", field: "related" };
	const model = loadTakeShapeSchema(JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8")));
	model.shapes.get("Book")!.properties.related = { name: "related", kind: "relationship", multiple: true, targets: ["Author", "Book"], relatedName: null };
	const ann = entry({ name: "Ann", id: "author-ann" });
	const hook = entry({ title: "Hook", id: "book-hook" });
	const pan = entry({ title: "Peter Pan", related: [{ collection: "authors", id: "author-ann" }, { collection: "books", id: "book-gone" }, { collection: "books", id: "book-hook" }] });
	const api = stubApi({ collections: { books: [pan, hook], authors: [ann] } });
	const query = "query { getBookList { items { title related { ... on Author { name } ... on Book { title } } } } }";
	const { getBookList } = await (await loader("data/related.graphql", query, map, model))(api);
	const related = Object.fromEntries(getBookList.items.map((i: Record<string, any>) => [i.title, i.related]));
	// A link to an entry that is gone drops out, as TakeShape dropped it from a multiple relationship
	assert.deepEqual(related["Peter Pan"], [{ name: "Ann" }, { title: "Hook" }]);
	assert.deepEqual(related.Hook, []);
});

// The same condition on a reverse field: authored(where: {author: {name: {eq: "Ann"}}}) on Bob holds nothing
test("a reverse field applies a condition through a reference", async () => {
	const ann = entry({ name: "Ann", id: "author-ann" });
	const bob = entry({ name: "Bob", id: "author-bob" });
	const books = [entry({ title: "Ann 1", author: "author-ann", takeshape_id: "1" }), entry({ title: "Bob 1", author: "author-bob", takeshape_id: "2" })];
	const api = stubApi({ collections: { authors: [ann, bob], books } });
	const query = 'query { getAuthorList { items { name authored(where: {author: {name: {eq: "Ann"}}}) { total items { title } } } } }';
	const { getAuthorList } = await (await loader("data/reverse-through.graphql", query))(api);
	const byName = Object.fromEntries(getAuthorList.items.map((a: Record<string, any>) => [a.name, a.authored]));
	assert.deepEqual(byName, { Ann: { total: 1, items: [{ title: "Ann 1" }] }, Bob: { total: 0, items: [] } });
});

// A list can ask for stories whose categories include one by slug: a condition on the entries a reference field
// points at
test("a condition through a reference field keeps the entries whose targets match", async () => {
	const ann = entry({ name: "Ann", id: "author-ann" });
	const bob = entry({ name: "Bob", id: "author-bob" });
	const books = [entry({ title: "Ann 1", author: "author-ann", takeshape_id: "1" }), entry({ title: "Bob 1", author: "author-bob", takeshape_id: "2" }), entry({ title: "Nobody", takeshape_id: "3" })];
	const api = stubApi({ collections: { authors: [ann, bob], books } });
	const query = 'query { getBookList(where: {author: {name: {eq: "Ann"}}}) { total items { title } } }';
	const { getBookList } = await (await loader("data/through.graphql", query))(api);
	assert.deepEqual(getBookList, { total: 1, items: [{ title: "Ann 1" }] });
});

// An inline object's field: where: {listing: {featured: {eq: true}}} tests a flattened field
test("a condition on an inline object's field reads the field it was flattened into", async () => {
	const map = structuredClone(fieldMap);
	const book = map.shapes.Book;
	if (book?.kind === "collection") book.properties.listing = { kind: "object", properties: { featured: { kind: "scalar", field: "listing_featured", type: "boolean" } } };
	const books = [entry({ title: "Shown", listing_featured: true }), entry({ title: "Hidden", listing_featured: false })];
	const api = stubApi({ collections: { authors: [], books } });
	const { getBookList } = await (await loader("data/object-where.graphql", "query { getBookList(where: {listing: {featured: {eq: true}}}) { total items { title } } }", map))(api);
	assert.deepEqual(getBookList, { total: 1, items: [{ title: "Shown" }] });
});

// A hero can print heroImage.url as the img src; TakeShape answered https://images.takeshape.io/<path>
test("an asset's url is its file on the site", async () => {
	const books = [entry({ title: "Peter Pan", cover_image: image("ts-a1.jpg") })];
	const api = stubApi({ collections: { books, authors: [] } });
	const { getBookList } = await (await loader("data/cover-url.graphql", "query { getBookList { items { coverImage { url path } } } }"))(api);
	assert.deepEqual(getBookList.items[0].coverImage, { url: "/_emdash/api/media/file/ts-a1.jpg", path: "ts-a1.jpg" });
});

// Templates can print asset titles as alt text; the converter keeps TakeShape's title in the value's meta
test("an asset's title comes from the value's meta", async () => {
	const books = [entry({ title: "Peter Pan", cover_image: image("ts-a1.jpg", { meta: { storageKey: "ts-a1.jpg", title: "Second star" } }) }), entry({ title: "Hook", cover_image: image("ts-a2.jpg") })];
	const api = stubApi({ collections: { books, authors: [] } });
	const { getBookList } = await (await loader("data/cover-title.graphql", "query { getBookList { items { title coverImage { title } } } }"))(api);
	const titles = Object.fromEntries(getBookList.items.map((i: Record<string, any>) => [i.title, i.coverImage.title]));
	assert.deepEqual(titles, { "Peter Pan": "Second star", Hook: null });
});

// A page can test page.hideSidebar === false, a boolean with default: false that most entries never stored.
// TakeShape's API answered a missing value with the property's default (read from its source).
test("a scalar the entry never stored answers with the property's default", async () => {
	const model = loadTakeShapeSchema(JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8")));
	const map = structuredClone(fieldMap);
	const book = map.shapes.Book;
	if (book?.kind === "collection") book.properties.hideSidebar = { kind: "scalar", field: "hide_sidebar", type: "boolean" };
	model.shapes.get("Book")!.properties.hideSidebar = { name: "hideSidebar", kind: "scalar", multiple: false, targets: [], relatedName: null, default: false };
	const books = [entry({ title: "Unset" }), entry({ title: "Set", hide_sidebar: true })];
	const api = stubApi({ collections: { books, authors: [] } });
	const { getBookList } = await (await loader("data/defaults.graphql", "query { getBookList { items { title hideSidebar } } }", map, model))(api);
	const values = Object.fromEntries(getBookList.items.map((i: Record<string, any>) => [i.title, i.hideSidebar]));
	assert.deepEqual(values, { Unset: false, Set: true });
});

// GraphQL answers a selected field the entry lacks with null, which templates can tell from undefined: a share link
// that prints page.social[0].description + " " + ... gave "null " on the old site
test("a scalar the entry never stored, with no default, is null", async () => {
	const books = [entry({ title: "Untitled" })];
	const api = stubApi({ collections: { books, authors: [] } });
	const { getBookList } = await (await loader("data/null-scalar.graphql", "query { getBookList { items { title totalPages } } }"))(api);
	assert.deepEqual(getBookList.items, [{ title: "Untitled", totalPages: null }]);
});

// Repeater rows that hold link { text url }, stored as the row fields link_text and link_url
test("an object inside a repeater row comes back as an object", async () => {
	const map = structuredClone(fieldMap);
	const book = map.shapes.Book;
	if (book?.kind === "collection") {
		book.properties.ways = {
			kind: "repeater",
			field: "ways",
			properties: {
				title: { kind: "scalar", field: "title", type: "string" },
				link: { kind: "object", properties: { text: { kind: "scalar", field: "link_text", type: "string" }, url: { kind: "scalar", field: "link_url", type: "string" } } },
			},
		};
	}
	const books = [entry({ title: "Peter Pan", ways: [{ title: "Email", link_text: "Write to us", link_url: "/write/" }, { title: "Phone" }] })];
	const api = stubApi({ collections: { books, authors: [] } });
	const { getBookList } = await (await loader("data/ways.graphql", "query { getBookList { items { ways { title link { text url } } } } }", map))(api);
	assert.deepEqual(getBookList.items[0].ways, [
		{ title: "Email", link: { text: "Write to us", url: "/write/" } },
		{ title: "Phone", link: null },
	]);
});

// An item page used to build its route's whole list, and a story query can ask every story for contentHtml: on a
// large site, rendering them all on each page cost about 0.5 s. A feed or listing still builds many. HTML renders
// when a template reads it, once.
test("rich text HTML renders when it is read, once, and still serializes", async () => {
	const body: PTBlock[] = [{ _type: "block", _key: "a1", style: "normal", markDefs: [], children: [{ _type: "span", _key: "a1-s0", text: "Chapter one", marks: [] }] }];
	const books = [entry({ title: "Peter Pan", body }), entry({ title: "Hook", body })];
	const api = stubApi({ collections: { books, authors: [] } });
	const { getBookList } = await (await loader("data/books.graphql"))(api);
	const [first, second] = getBookList.items;
	assert.equal(typeof Object.getOwnPropertyDescriptor(first, "bodyHtml")?.get, "function");
	assert.equal(first.bodyHtml, "<p>Chapter one</p>");
	assert.equal(Object.getOwnPropertyDescriptor(first, "bodyHtml")?.value, "<p>Chapter one</p>");
	assert.equal(typeof Object.getOwnPropertyDescriptor(second, "bodyHtml")?.get, "function");
	assert.match(JSON.stringify(second), /"bodyHtml":"<p>Chapter one<\/p>"/);
});

// Lists of objects the converter kept as JSON (related stories, partner blocks), holding text, images, nested objects
// and links ({ collection, id }) to entries of several shapes
test("a JSON list builds what the query selects, links included, one read per link path", async () => {
	const map = structuredClone(fieldMap);
	const book = map.shapes.Book;
	if (book?.kind === "collection") book.properties.blocks = { kind: "json", field: "blocks" };
	const model = loadTakeShapeSchema(JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8")));
	const scalar = (name: string) => ({ name, kind: "scalar" as const, multiple: false, targets: [], relatedName: null });
	model.shapes.get("Book")!.properties.blocks = {
		name: "blocks",
		kind: "array",
		multiple: true,
		targets: [],
		relatedName: null,
		properties: {
			heading: scalar("heading"),
			photo: { name: "photo", kind: "asset", multiple: false, targets: ["ASSET"], relatedName: null },
			link: { name: "link", kind: "relationship", multiple: false, targets: ["Author", "Book"], relatedName: null },
			links: { name: "links", kind: "relationship", multiple: true, targets: ["Author"], relatedName: null },
			inner: { name: "inner", kind: "object", multiple: false, targets: [], relatedName: null, properties: { note: scalar("note"), pic: { name: "pic", kind: "asset", multiple: false, targets: ["ASSET"], relatedName: null } } },
		},
	};
	const ann = entry({ name: "Ann", id: "author-ann" });
	const books = [
		entry({ title: "Peter Pan", blocks: [{ heading: "H1", photo: image("p1"), link: { collection: "authors", id: "author-ann" }, links: [{ collection: "authors", id: "author-ann" }, { collection: "authors", id: "gone" }], inner: { note: "n", pic: image("p2") } }] }),
		entry({ title: "Hook" }),
	];
	const api = stubApi({ collections: { books, authors: [ann] } });
	const query = "query { getBookList { items { title blocks { heading photo { path } link { ... on Author { name _contentTypeName } ... on Book { title } } links { ... on Author { name } } inner { note pic { path } } } } } }";
	const { getBookList } = await (await loader("data/blocks.graphql", query, map, model))(api);
	const blocks = Object.fromEntries(getBookList.items.map((i: Record<string, any>) => [i.title, i.blocks]));
	assert.deepEqual(blocks["Peter Pan"], [
		{ heading: "H1", photo: { path: "p1" }, link: { name: "Ann", _contentTypeName: "author" }, links: [{ name: "Ann" }], inner: { note: "n", pic: { path: "p2" } } },
	]);
	assert.equal(blocks.Hook, null);
	// One read per link path (link, links) for every entry at once; EmDash's per-request store serves a repeat
	assert.equal(api.calls.filter((c) => "byIds" in c.filter).length, 2);
});

// A homepage's boxes can print title(format: html) and blurbHtml from a list kept as JSON
test("rich text inside a JSON list renders as HTML when asked for it, as text otherwise", async () => {
	const map = structuredClone(fieldMap);
	const book = map.shapes.Book;
	if (book?.kind === "collection") book.properties.boxes = { kind: "json", field: "boxes" };
	const model = loadTakeShapeSchema(JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8")));
	model.shapes.get("Book")!.properties.boxes = {
		name: "boxes",
		kind: "array",
		multiple: true,
		targets: [],
		relatedName: null,
		properties: { blurb: { name: "blurb", kind: "draftjs", multiple: false, targets: [], relatedName: null } },
	};
	const blurb = {
		_type: "takeshapeRichText",
		blocks: [{ _type: "block", _key: "b1", style: "normal", markDefs: [], children: [{ _type: "span", _key: "b1-0", text: "Read ", marks: [] }, { _type: "span", _key: "b1-1", text: "ours", marks: ["strong"] }] }],
	};
	const api = stubApi({ collections: { books: [entry({ title: "Peter Pan", boxes: [{ blurb }] })], authors: [] } });
	const query = "query { getBookList { items { boxes { blurbHtml blurb asHtml: blurb(format: html) } } } }";
	const { getBookList } = await (await loader("data/boxes.graphql", query, map, model))(api);
	const [box] = getBookList.items[0].boxes;
	assert.equal(box.blurbHtml, "<p>Read <strong>ours</strong></p>");
	assert.equal(box.asHtml, "<p>Read <strong>ours</strong></p>");
	assert.equal(box.blurb, "Read ours");
});

// A box title in MDX ("Field\n\nGuide"), printed with title(format: html)
test("MDX inside a JSON list renders as HTML when asked for it, as its source otherwise", async () => {
	const map = structuredClone(fieldMap);
	const book = map.shapes.Book;
	if (book?.kind === "collection") book.properties.boxes = { kind: "json", field: "boxes" };
	const model = loadTakeShapeSchema(JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8")));
	model.shapes.get("Book")!.properties.boxes = {
		name: "boxes",
		kind: "array",
		multiple: true,
		targets: [],
		relatedName: null,
		properties: { title: { name: "title", kind: "markdown", multiple: false, targets: [], relatedName: null } },
	};
	const para = (key: string, text: string) => ({ _type: "block", _key: key, style: "normal", markDefs: [], children: [{ _type: "span", _key: `${key}-0`, text, marks: [] }] });
	const title = { _type: "takeshapeRichText", blocks: [para("t1", "Field"), para("t2", "Guide")], source: "Field\n\nGuide" };
	const api = stubApi({ collections: { books: [entry({ title: "Peter Pan", boxes: [{ title }] })], authors: [] } });
	const query = "query { getBookList { items { boxes { title asHtml: title(format: html) } } } }";
	const { getBookList } = await (await loader("data/mdx-boxes.graphql", query, map, model))(api);
	const [box] = getBookList.items[0].boxes;
	assert.equal(box.asHtml, "<p>Field</p><p>Guide</p>");
	assert.equal(box.title, "Field\n\nGuide");
});

// A template can read item.title.blocks[0].text: TakeShape returned the stored Draft.js there
test("a Draft.js field asked for without Html reads as the Draft.js TakeShape returned", async () => {
	const body: PTBlock[] = [
		{ _type: "block", _key: "k1", style: "h3", markDefs: [], children: [{ _type: "span", _key: "k1-0", text: "Lead editor", marks: [] }] },
		{ _type: "block", _key: "k2", style: "blockquote", markDefs: [], children: [{ _type: "span", _key: "k2-0", text: "Quote", marks: [] }] },
	];
	const sidecar: RichTextSidecar = { body: { k2: { pullquote: true } } };
	const api = stubApi({ collections: { books: [entry({ title: "Peter Pan", body, takeshape_rich_text: sidecar }), entry({ title: "Empty", body: null })], authors: [] } });
	const { getBookList } = await (await loader("data/draft-body.graphql", "query { getBookList { items { body } } }"))(api);
	const block = (key: string, text: string, type: string) => ({ key, text, type, depth: 0, inlineStyleRanges: [], entityRanges: [], data: {} });
	assert.deepEqual(getBookList.items[0].body, { blocks: [block("k1", "Lead editor", "header-three"), block("k2", "Quote", "pullquote")], entityMap: {} });
	assert.equal(getBookList.items[1].body, null);
});

// An MDX field asked for with format: html: TakeShape's MDX renderer minified the whitespace between blocks
test("an MDX field asked for with format: html prints its blocks with nothing between them", async () => {
	const map = structuredClone(fieldMap);
	const book = map.shapes.Book;
	if (book?.kind === "collection") book.properties.body = { kind: "richText", field: "body", format: "markdown" };
	const para = (key: string, text: string) => ({ _type: "block", _key: key, style: "normal", markDefs: [], children: [{ _type: "span", _key: `${key}-0`, text, marks: [] }] });
	const code = { _type: "code", _key: "c1", language: "", code: "a\n\nb" };
	const api = stubApi({ collections: { books: [entry({ title: "Peter Pan", body: [para("t1", "Field"), para("t2", "Guide"), code] })], authors: [] } });
	const { getBookList } = await (await loader("data/mdx.graphql", "query { getBookList { items { body(format: html) } } }", map))(api);
	const html: string = getBookList.items[0].body;
	assert.ok(html.startsWith("<p>Field</p><p>Guide</p><pre"), html);
	// Code keeps its line breaks
	assert.ok(html.includes("a\n\nb"), html);
});

test("references come from EmDash's reference read and keep TakeShape's shape", async () => {
	const ann = entry({ name: "Ann", id: "author-ann" });
	const books = [
		// EmDash gives every field of the collection, null when it is empty
		entry({ title: "One", author: "author-ann", total_pages: null, type: null, body: null, cover_image: image("one", { alt: "Cover one" }), takeshape_created_at: "2020-01-02T00:00:00.000Z", takeshape_published_at: "2020-03-01T00:00:00.000Z" }),
		entry({ title: "Two", author: "author-ann", total_pages: 120, type: "paperback", takeshape_created_at: "2020-01-01T00:00:00.000Z" }),
	];
	const api = stubApi({
		collections: { books, authors: [ann] },
		terms: { "books:genre": { [books[0]!.data.id as string]: [{ slug: "fantasy", label: "Fantasy" }] } },
	});
	const { getBookList } = await (await loader("data/books.graphql"))(api);
	assert.deepEqual(getBookList.items[0], {
		_contentTypeName: "book",
		_enabledAt: "2020-03-01T00:00:00.000Z",
		title: "One",
		totalPages: null,
		type: null,
		genre: { title: "Fantasy" },
		author: { name: "Ann" },
		bodyHtml: "",
		coverImage: { path: "one" },
	});
	assert.equal(getBookList.items[1].totalPages, 120);
	assert.deepEqual(getBookList.items[1].author, { name: "Ann" });
	// EmDash keeps the link in its relation table: one reference read gives every book's author
	assert.deepEqual(api.referenceCalls, [{ kind: "references", collection: "books", field: "author", ids: [books[0]!.data.id, books[1]!.data.id] }]);
	assert.equal(api.calls.filter((c) => c.type === "authors").length, 0);

	// EmDash's public reads return published entries only, so a draft target reads as empty
	const draftAuthor = stubApi({ collections: { books: [entry({ title: "Three", author: "author-dee" })], authors: [entry({ name: "Dee", id: "author-dee" }, "draft")] } });
	const three = (await (await loader("data/books.graphql"))(draftAuthor)).getBookList.items[0];
	assert.equal(three.author, null);
});

test("a multiple reference keeps its stored order", async () => {
	const [a, b, hidden] = [entry({ title: "A" }), entry({ title: "B" }), entry({ title: "Hidden" }, "draft")];
	const first = entry({ title: "First", related: [b.data.id, "gone", hidden.data.id, a.data.id] });
	const second = entry({ title: "Second", related: [a.data.id] });
	const draft = entry({ title: "Draft", related: [a.data.id] }, "draft");
	const api = stubApi({ collections: { posts: [a, b, hidden, first, second, draft] }, referenceFields: { "posts.related": "posts" } });
	const found = await references(api, "posts", [first, second, null, first, draft], "related");
	assert.deepEqual(titles(found.of(first)), ["B", "A"]);
	assert.deepEqual(titles(found.of(second)), ["A"]);
	// A draft the loader renders gets its published links, as TakeShape returned them
	assert.deepEqual(titles(found.of(draft)), ["A"]);
	assert.deepEqual(titles(found.entries), ["B", "A"]);
	// One read for the distinct entries
	assert.deepEqual(api.referenceCalls, [{ kind: "references", collection: "posts", field: "related", ids: [first.data.id, second.data.id, draft.data.id] }]);
});

test("terms keep TakeShape's order", async () => {
	const post = entry({ title: "Tagged", takeshape_term_order: { tag: ["vestibulum-tellus", "pellentesque"] } });
	const unordered = entry({ title: "Edited later" });
	const terms = {
		"posts:tag": {
			[post.data.id as string]: [
				{ slug: "pellentesque", label: "Pellentesque" },
				{ slug: "vestibulum-tellus", label: "Vestibulum Tellus" },
				{ slug: "commodo", label: "Commodo" },
				{ slug: "added", label: "Added In EmDash" },
			],
			[unordered.data.id as string]: [{ slug: "zeta", label: "Zeta" }, { slug: "alpha", label: "Alpha" }],
		},
	};
	const api = stubApi({ collections: { posts: [post] }, terms });
	// Terms TakeShape never had come after its own, in EmDash's label order
	const found = await termsOf(api, "posts", [post, unordered, null], "tag");
	assert.deepEqual(found.of(post).map((t) => t.label), ["Vestibulum Tellus", "Pellentesque", "Added In EmDash", "Commodo"]);
	assert.deepEqual(found.of(unordered).map((t) => t.label), ["Alpha", "Zeta"]);
});

test("shape-books posts print their tags in TakeShape's order", async () => {
	// Posts from the converted seed, with each post's terms answered in EmDash's label order
	const labels = new Map<string, string>();
	for (const t of converted.seed.taxonomies) for (const term of t.terms) labels.set(`${t.name}:${term.slug}`, term.label);
	const posts = (converted.seed.content.posts as Array<{ id: string; slug: string; data: Record<string, unknown>; taxonomies?: Record<string, string[]> }>).map((e) =>
		entry({ ...e.data, author: null, id: e.id, slug: e.slug }),
	);
	const tags: Record<string, Term[]> = {};
	for (const e of converted.seed.content.posts) tags[e.id] = (e.taxonomies?.tag ?? []).map((slug: string) => ({ slug, label: labels.get(`tag:${slug}`)! }));
	const { getPostList } = await (await loader("data/posts.graphql"))(stubApi({ collections: { posts, authors: [] }, terms: { "posts:tag": tags } }), {}, { paginate: true });

	// TakeShape's order, from the export
	const rows = readFileSync(join(fixture, "data.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const shapeOf = (r: Record<string, unknown>) => r._shapeId ?? r._contentTypeId;
	const tagName = new Map(rows.filter((r) => shapeOf(r) === "rJBYXVyuQ").map((r) => [r._id, r.rkZYm41d7]));
	const expected = new Map(rows.filter((r) => shapeOf(r) === "rJoobhv8W").map((r) => [String(r.BkJDGhw8W).trim(), (r.Hkb57EkOQ ?? []).map((ref: { id: string }) => tagName.get(ref.id))]));
	assert.equal(getPostList.items.length, 5);
	for (const item of getPostList.items) assert.deepEqual(item.tags.map((t: { name: string }) => t.name), expected.get(String(item.title).trim()), item.title);
	assert.deepEqual(getPostList.items.find((p: any) => p.title.startsWith("Reinventing")).tags, [{ name: "Vestibulum Tellus" }, { name: "Pellentesque" }]);
});

test("a getX with no id gives null without reading", async () => {
	const api = stubApi({ collections: { books: [entry({ title: "Newest", takeshape_id: "b1" })] } });
	assert.equal(await getEntry(api, "books", null), null);
	assert.equal(api.calls.length, 0);
	assert.equal((await getEntry(api, "books", "b1"))?.data.title, "Newest");
	const load = await loader("data/by-id.graphql", `query ($id: ID!) { book: getBook(_id: $id) { title kind: __typename name: _contentTypeName } byId: getBook(_id: "b1") { title kind: __typename name: _contentTypeName } }`);
	const result = await load(api);
	assert.equal(result.book, null);
	assert.deepEqual(result.byId, { title: "Newest", kind: "Book", name: "book" });
});

test("without legacy fields, lists come in EmDash's order", async () => {
	const bare = convert("bare", ["--no-legacy-fields"]);
	const posts = [
		entry({ title: "older", createdAt: new Date("2020-01-01T00:00:00.000Z"), id: "01A" }),
		entry({ title: "tie-low-id", createdAt: new Date("2020-06-01T00:00:00.000Z"), id: "01B" }),
		entry({ title: "newer", createdAt: new Date("2021-01-01T00:00:00.000Z"), id: "01C" }),
		entry({ title: "tie-high-id", createdAt: new Date("2020-06-01T00:00:00.000Z"), id: "01D" }),
		entry({ title: "draft", createdAt: new Date("2022-01-01T00:00:00.000Z"), id: "01E" }, "draft"),
	];
	const load = await loader("data/bare-posts.graphql", `query { getPostList(where: {title: {in: ["older", "tie-low-id", "newer", "tie-high-id", "draft"]}}) { items { title } } }`, bare.fieldMap);
	const { getPostList } = await load(stubApi({ collections: { posts } }));
	// EmDash orders by created_at, then id, both descending
	assert.deepEqual(getPostList.items.map((p: { title: string }) => p.title), ["draft", "newer", "tie-high-id", "tie-low-id", "older"]);
});
