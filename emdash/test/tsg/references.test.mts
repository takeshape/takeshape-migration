/**
 * runtime/references.ts against a real EmDash 1.3.0 database: a small site applied with `emdash seed`, then the
 * reader's reads checked for what getEmDashReferences answers (stored order from either end of a relation,
 * published entries only) and counted, query by query. Unlike getEmDashReferences, a draft entry a loader renders
 * gets its links too, as TakeShape returned them.
 *
 * `published` stands in for getEmDashCollection's read by translation group, which needs Astro: one query here,
 * as there.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Kysely } from "kysely";
import { createDialect } from "emdash/db/sqlite";
import type { Entry } from "../../tsg2astro/runtime/query.ts";
import { byGroup, PUBLISHED_LIST, readByIds, readReferences, readReferrers } from "../../tsg2astro/runtime/references.ts";
import type { ReaderDeps } from "../../tsg2astro/runtime/references.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const work = join(root, "test", ".out", `tsg-references-${process.pid}`);
const emdashPkg = join(root, "node_modules", "emdash", "package.json");
const emdashCli = join(dirname(emdashPkg), JSON.parse(readFileSync(emdashPkg, "utf8")).bin.emdash);
after(() => rmSync(work, { recursive: true, force: true }));

/** Posts written by authors (a declared relation, with Author.authored as its child end) and related posts (bound by EmDash). */
const MANY = 120;
const seed = {
	version: "1",
	meta: { name: "references test" },
	relations: [{ slug: "posts_author", parentCollection: "posts", childCollection: "authors", parentLabel: "Authored", childLabel: "Author", maxChildrenPerParent: 1, maxParentsPerChild: null }],
	collections: [
		{
			slug: "authors",
			label: "Authors",
			supports: ["drafts"],
			fields: [
				{ slug: "name", label: "Name", type: "string" },
				{ slug: "authored", label: "Authored", type: "reference", validation: { relation: "posts_author" } },
			],
		},
		{
			slug: "posts",
			label: "Posts",
			supports: ["drafts"],
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "author", label: "Author", type: "reference", validation: { relation: "posts_author" } },
				{ slug: "related", label: "Related", type: "reference", validation: { targetCollection: "posts", multiple: true } },
			],
		},
	],
	content: {
		authors: [
			{ id: "ann", slug: "ann", status: "published", data: { name: "Ann" } },
			{ id: "dee", slug: "dee", status: "draft", data: { name: "Dee" } },
		],
		posts: [
			{ id: "two", slug: "two", status: "published", data: { title: "Two", author: "$ref:ann" } },
			{ id: "three", slug: "three", status: "draft", data: { title: "Three", author: "$ref:ann" } },
			{ id: "four", slug: "four", status: "published", data: { title: "Four", author: "$ref:dee" } },
			{ id: "one", slug: "one", status: "published", data: { title: "One", author: "$ref:ann", related: ["$ref:four", "$ref:three", "$ref:two"] } },
			...Array.from({ length: MANY }, (_, i) => ({ id: `m${i}`, slug: `m${i}`, status: "published", data: { title: `M${i}`, author: "$ref:ann", related: ["$ref:one"] } })),
		],
	},
};

let db: Kysely<any>;
let queries: string[] = [];
const all = new Map<string, Entry>(); // by slug

before(() => {
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, "seed.json"), JSON.stringify(seed));
	const res = spawnSync(process.execPath, ["--no-warnings", emdashCli, "seed", join(work, "seed.json"), "--database", join(work, "data.db"), "--on-conflict", "update"], { cwd: work, encoding: "utf8" });
	assert.equal(res.status, 0, `emdash seed exited ${res.status}: ${res.stdout}${res.stderr}`);
	db = new Kysely<any>({ dialect: createDialect({ url: `file:${join(work, "data.db")}` }), log: (e) => void (e.level === "query" && queries.push(e.query.sql)) });
});
after(() => db?.destroy());

/** An entry as getEmDashCollection gives it, with the fields this test reads. */
function toEntry(collection: string, row: Record<string, unknown>): Entry {
	return { id: String(row.slug), data: { id: row.id, status: row.status, translationGroup: row.translation_group, [collection === "posts" ? "title" : "name"]: row[collection === "posts" ? "title" : "name"] } };
}

async function load(collection: string): Promise<Entry[]> {
	const rows = await db.selectFrom(`ec_${collection}`).selectAll().where("deleted_at", "is", null).execute();
	return rows.map((row) => toEntry(collection, row));
}

/** The reader on this database, with a fresh store: one request. */
function request(): ReaderDeps & { store(): Map<string, unknown> } {
	const store = new Map<string, unknown>();
	return {
		db: async () => db as never,
		async published(collection, groups) {
			const rows = await db
				.selectFrom(`ec_${collection}`)
				.selectAll()
				.where("status", "=", "published")
				.where("deleted_at", "is", null)
				.where("translation_group", "in", (eb: any) => eb.selectFrom(eb.fn("json_each", [eb.val(JSON.stringify(groups))]).as("j")).select("j.value"))
				.execute();
			return rows.map((row) => toEntry(collection, row));
		},
		async publishedByIds(collection, ids) {
			const rows = await db
				.selectFrom(`ec_${collection}`)
				.selectAll()
				.where("status", "=", "published")
				.where("deleted_at", "is", null)
				.where("id", "in", (eb: any) => eb.selectFrom(eb.fn("json_each", [eb.val(JSON.stringify(ids))]).as("j")).select("j.value"))
				.execute();
			return rows.map((row) => toEntry(collection, row));
		},
		store: () => store,
	};
}

const names = (entries: Entry[] | undefined) => (entries ?? []).map((e) => e.data.title ?? e.data.name);
const of = (found: Map<string, Entry[]>, slug: string) => found.get((all.get(slug) as Entry).data.id as string);
const counted = async <T,>(run: () => Promise<T>): Promise<{ result: T; count: number }> => {
	queries = [];
	const result = await run();
	return { result, count: queries.length };
};

test("a reference field of a whole list is one read of its links and one of its targets", async () => {
	for (const e of [...(await load("posts")), ...(await load("authors"))]) all.set(e.id, e);
	const posts = (await load("posts")).filter((p) => !p.id.startsWith("m"));
	const deps = request();

	// Bindings, the links of every post, and the authors they point at
	const { result: authors, count } = await counted(() => readReferences(deps, "posts", posts, "author"));
	assert.equal(count, 3);
	assert.deepEqual(names(of(authors, "one")), ["Ann"]);
	assert.deepEqual(names(of(authors, "two")), ["Ann"]);
	// A draft post the loader renders gets its published author, as TakeShape returned it; a draft author is left out
	assert.deepEqual(names(of(authors, "three")), ["Ann"]);
	assert.deepEqual(names(of(authors, "four")), []);

	// A multiple reference keeps its stored order, without the draft
	const { result: related, count: relatedCount } = await counted(() => readReferences(deps, "posts", posts, "related"));
	assert.equal(relatedCount, 2, "bindings are read once a request");
	assert.deepEqual(names(of(related, "one")), ["Four", "Two"]);

	// The same read again in the request costs nothing
	assert.equal((await counted(() => readReferences(deps, "posts", posts, "author"))).count, 0);
	// Nor does a field that is not a reference
	assert.deepEqual(names(of((await counted(() => readReferences(deps, "posts", posts, "title"))).result, "one")), []);
});

test("from the child end, links come in the order EmDash stores them", async () => {
	const ann = all.get("ann") as Entry;
	const { result } = await counted(() => readReferences(request(), "authors", [ann, all.get("dee") as Entry], "authored"));
	// getParentsPageById orders by edge id: the order the seed wrote the links in
	const expected = (await db.selectFrom("_emdash_content_references").select("parent_group").where("child_group", "=", ann.data.translationGroup).orderBy("id").execute()).map((r) => r.parent_group);
	const published = new Set([...all.values()].filter((e) => e.data.status === "published").map((e) => e.data.translationGroup));
	assert.deepEqual(
		(of(result, "ann") ?? []).map((e) => e.data.translationGroup),
		expected.filter((g) => published.has(g)),
	);
	assert.equal(of(result, "ann")?.length, MANY + 2);
	// A draft author the loader renders still lists the published post that points at it
	assert.deepEqual(names(of(result, "dee")), ["Four"]);
});

test("referrers: the published entries pointing at each target", async () => {
	const deps = request();
	const targets = [all.get("ann") as Entry, all.get("dee") as Entry];
	// Links into every target, then the posts they come from
	const { result, count } = await counted(() => readReferrers(deps, "posts", "author", targets));
	assert.equal(count, 3);
	assert.deepEqual(new Set(names(of(result, "ann"))), new Set(["One", "Two", ...Array.from({ length: MANY }, (_, i) => `M${i}`)]));
	// Four points at a draft author, which keeps it as a referrer: TakeShape answered reverse fields on drafts too
	assert.deepEqual(names(of(result, "dee")), ["Four"]);

	// Every M post lists One among its related posts; One lists Two and Four
	const posts = [all.get("one") as Entry, all.get("two") as Entry, all.get("four") as Entry];
	const { result: back, count: backCount } = await counted(() => readReferrers(deps, "posts", "related", posts));
	assert.equal(backCount, 1, "every post is known from the read above");
	assert.equal(of(back, "one")?.length, MANY);
	assert.deepEqual(names(of(back, "two")), ["One"]);
	assert.deepEqual(names(of(back, "four")), ["One"]);
});

test("a collection's whole published list answers for its entries", async () => {
	const deps = request();
	deps.store().set(PUBLISHED_LIST("authors"), [{ select: null, byGroup: Promise.resolve(byGroup((await load("authors")).filter((a) => a.data.status === "published"))) }]);
	const posts = (await load("posts")).filter((p) => p.id.startsWith("m"));
	// More than D1's 100 bound parameters: still one read of the links, and no read of the authors
	const { result, count } = await counted(() => readReferences(deps, "posts", posts, "author"));
	assert.equal(count, 2);
	assert.equal(queries.filter((q) => q.includes("ec_authors")).length, 0);
	assert.deepEqual(names(of(result, "m119")), ["Ann"]);
});

test("a whole list read with some columns answers only for reads that need no others", async () => {
	const deps = request();
	const published = byGroup((await load("authors")).filter((a) => a.data.status === "published"));
	deps.store().set(PUBLISHED_LIST("authors"), [{ select: ["name"], byGroup: Promise.resolve(published) }]);
	const posts = (await load("posts")).filter((p) => p.id === "two");
	const asked: Array<readonly string[] | null> = [];
	const watching = { ...deps, published: (c: string, g: string[], select: readonly string[] | null) => (asked.push(select), deps.published(c, g, select)) };
	assert.deepEqual(names(of(await readReferences(watching, "posts", posts, "author", ["name"]), "two")), ["Ann"]);
	assert.deepEqual(asked, [], "the list has the name");
	assert.deepEqual(names(of(await readReferences(watching, "posts", posts, "author", ["name", "bio"]), "two")), ["Ann"]);
	assert.deepEqual(asked, [["name", "bio"]], "the list has no bio: the authors are read with it");
	assert.deepEqual(names(of(await readReferences(watching, "posts", posts, "author", ["bio"]), "two")), ["Ann"]);
	assert.equal(asked.length, 1, "Ann read with name and bio stands in for a read of bio");
});

// JSON fields hold EmDash entry ids, and an id names an entry where its translation group may not: one made in another
// locale first, or one EmDash moved into another group. A read by group found nothing for those.
test("entries by id: found by their own id, read once a request, or from the whole published list", async () => {
	const two = all.get("two") as Entry;
	const id = two.data.id as string;
	await db.updateTable("ec_posts").set({ translation_group: "group-of-two" }).where("id", "=", id).execute();
	try {
		const deps = request();
		const { result, count } = await counted(() => readByIds(deps, "posts", [id, "gone"]));
		assert.deepEqual(names(result), ["Two"]);
		assert.equal(count, 1);
		assert.equal((await counted(() => readByIds(deps, "posts", [id]))).count, 0, "a second read in the request costs nothing");
		// A loader read the collection's whole published list: the entry comes from there
		const listed = request();
		listed.store().set(PUBLISHED_LIST("posts"), [{ select: null, byGroup: Promise.resolve(byGroup((await load("posts")).filter((e) => e.data.status === "published"))) }]);
		const { result: fromList, count: none } = await counted(() => readByIds(listed, "posts", [id]));
		assert.deepEqual(names(fromList), ["Two"]);
		assert.equal(none, 0);
	} finally {
		await db.updateTable("ec_posts").set({ translation_group: two.data.translationGroup }).where("id", "=", id).execute();
	}
});
