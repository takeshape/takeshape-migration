/**
 * runtime/rows.ts against a real EmDash 1.3.0 database: a collection with one field of each kind, applied with
 * `emdash seed`, read with chosen columns. Each entry must be what EmDash's public list read gives for those columns
 * (loader.ts mapRowToData, normalizeLocalMediaValue, entryIdForRow, buildFieldConditions): the expectations below
 * follow that source rule by rule. Whole pages through the real getEmDashCollection and rows.ts are compared in the
 * e2e site build.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Kysely } from "kysely";
import { createDialect } from "emdash/db/sqlite";
import { entryOf, readRows } from "../../tsg2astro/runtime/rows.ts";
import type { RowDeps } from "../../tsg2astro/runtime/rows.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const work = join(root, "test", ".out", `tsg-rows-${process.pid}`);
const emdashPkg = join(root, "node_modules", "emdash", "package.json");
const emdashCli = join(dirname(emdashPkg), JSON.parse(readFileSync(emdashPkg, "utf8")).bin.emdash);
after(() => rmSync(work, { recursive: true, force: true }));

const picture = { provider: "local", src: "abc123.jpg", alt: "A picture", width: 4, height: 3, mimeType: "image/jpeg" };
const MANY = 60;
const seed = {
	version: "1",
	meta: { name: "rows test" },
	taxonomies: [{ name: "topic", label: "Topics", hierarchical: false, collections: ["things"], terms: [{ slug: "birds", label: "Birds" }] }],
	collections: [
		{ slug: "owners", label: "Owners", fields: [{ slug: "name", label: "Name", type: "string" }] },
		{
			slug: "things",
			label: "Things",
			supports: ["drafts"],
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "bracket", label: "Bracket", type: "string" },
				{ slug: "body", label: "Body", type: "portableText" },
				{ slug: "flag", label: "Flag", type: "boolean" },
				{ slug: "count", label: "Count", type: "integer" },
				{ slug: "price", label: "Price", type: "number" },
				{ slug: "happened", label: "Happened", type: "datetime" },
				{ slug: "extra", label: "Extra", type: "json" },
				{ slug: "picture", label: "Picture", type: "image" },
				{ slug: "owner", label: "Owner", type: "reference", validation: { targetCollection: "owners" } },
			],
		},
	],
	content: {
		owners: [{ id: "ann", slug: "ann", status: "published", data: { name: "Ann" } }],
		things: [
			{
				id: "full",
				slug: "full",
				status: "published",
				data: {
					title: "Full",
					bracket: "[not json",
					body: [{ _type: "block", _key: "k1", style: "normal", markDefs: [], children: [{ _type: "span", _key: "s1", text: "Hello", marks: [] }] }],
					flag: true,
					count: 3,
					price: 2.5,
					happened: "2020-10-22T20:23:35.708Z",
					extra: { nested: [{ provider: "local", src: "/_emdash/api/media/file/key2.png" }, { provider: "external", src: "https://example.com/x.png" }] },
					picture,
					owner: "$ref:ann",
				},
				taxonomies: { topic: ["birds"] },
			},
			{ id: "off", slug: "off", status: "published", data: { title: "Off", flag: false, count: 0 } },
			{ id: "draft", slug: "draft", status: "draft", data: { title: "Draft", flag: true } },
			{ id: "gone", slug: "gone", status: "published", data: { title: "Gone" } },
			...Array.from({ length: MANY }, (_, i) => ({ id: `m${i}`, slug: `m${i}`, status: "published", data: { title: `M${i}`, count: i } })),
		],
	},
};

let db: Kysely<any>;
let queries: string[] = [];
const ids = new Map<string, string>(); // slug to EmDash id

before(async () => {
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, "seed.json"), JSON.stringify(seed));
	const res = spawnSync(process.execPath, ["--no-warnings", emdashCli, "seed", join(work, "seed.json"), "--database", join(work, "data.db"), "--on-conflict", "update"], { cwd: work, encoding: "utf8" });
	assert.equal(res.status, 0, `emdash seed exited ${res.status}: ${res.stdout}${res.stderr}`);
	db = new Kysely<any>({ dialect: createDialect({ url: `file:${join(work, "data.db")}` }), log: (e) => void (e.level === "query" && queries.push(e.query.sql)) });
	await db.updateTable("ec_things").set({ deleted_at: new Date().toISOString() }).where("slug", "=", "gone").execute();
	for (const row of await db.selectFrom("ec_things").select(["id", "slug"]).execute()) ids.set(row.slug, row.id);
});
after(() => db?.destroy());

function request(): RowDeps {
	const store = new Map<string, unknown>();
	return { db: async () => db as never, store: () => store };
}

test("a row as EmDash maps it, with the columns asked for", async () => {
	const deps = request();
	queries = [];
	const found = (await readRows(deps, "things", { status: "published" }, ["title", "bracket", "flag", "count", "price", "happened", "extra", "picture", "owner", "nope"])) ?? [];
	// The fields and the rows together; the table has no `owner` or `nope`, so that read fails (logged as an error,
	// not counted here) and goes again without them
	assert.equal(queries.length, 2);
	assert.match(queries[0] ?? "", /_emdash_fields/);
	assert.doesNotMatch(queries.at(-1) ?? "", /"owner"|"nope"/);
	const full = found.find((e) => e.id === "full");
	assert.ok(full, "the entry's id is its slug");
	const raw = await db.selectFrom("ec_things").selectAll().where("slug", "=", "full").executeTakeFirstOrThrow();
	assert.deepEqual(full.data, {
		// System columns by EmDash's names, dates as Date objects, the slug under its own name
		id: raw.id,
		slug: "full",
		status: "published",
		authorId: raw.author_id,
		primaryBylineId: raw.primary_byline_id,
		createdAt: new Date(raw.created_at),
		updatedAt: new Date(raw.updated_at),
		publishedAt: raw.published_at ? new Date(raw.published_at) : null,
		scheduledAt: null,
		locale: raw.locale,
		translationGroup: raw.translation_group,
		title: "Full",
		// Text that starts with [ but is no JSON stays text
		bracket: "[not json",
		// SQLite keeps booleans as 1 and 0; EmDash's boolean fields read as booleans
		flag: true,
		count: 3,
		price: 2.5,
		// A datetime field is text, as stored
		happened: raw.happened,
		// JSON parsed; a local media value with a file URL gets its id, one with a bare key gets the file URL
		extra: { nested: [{ provider: "local", src: "/_emdash/api/media/file/key2.png", id: "key2.png" }, { provider: "external", src: "https://example.com/x.png" }] },
		picture: { ...picture, id: "abc123.jpg", src: "/_emdash/api/media/file/abc123.jpg" },
		// No `owner` (a reference has no column), no `nope`, no body (not asked for), no revision ids
	});
	const off = found.find((e) => e.id === "off");
	assert.equal(off?.data.flag, false);
	assert.equal(off?.data.count, 0);
	assert.equal(found.find((e) => e.id === "off")?.data.picture, null, "an empty field reads as stored");
});

test("rows a public list read returns: not deleted, one status, newest first, limit", async () => {
	const deps = request();
	const published = (await readRows(deps, "things", { status: "published" }, ["title"])) ?? [];
	assert.equal(published.length, 2 + MANY);
	assert.ok(!published.some((e) => e.id === "gone"), "a deleted row is left out");
	assert.ok(!published.some((e) => e.id === "draft"));
	const raw = await db.selectFrom("ec_things").select(["slug"]).where("deleted_at", "is", null).where("status", "=", "published").orderBy("created_at", "desc").orderBy("id", "desc").execute();
	assert.deepEqual(
		published.map((e) => e.id),
		raw.map((r) => r.slug),
	);
	assert.deepEqual(((await readRows(deps, "things", { status: "draft" }, ["title"])) ?? []).map((e) => e.data.title), ["Draft"]);
	assert.equal(((await readRows(deps, "things", { status: "published", limit: 1 }, ["title"])) ?? []).length, 1);
});

test("conditions bound as EmDash binds them", async () => {
	const deps = request();
	const titles = async (where: Record<string, unknown>) => ((await readRows(deps, "things", { status: "published", where }, ["title"])) ?? []).map((e) => e.data.title).sort();
	assert.deepEqual(await titles({ flag: true }), ["Full"], "a boolean as 1");
	assert.deepEqual(await titles({ flag: false }), ["Off"], "a boolean as 0");
	assert.deepEqual(await titles({ slug: ["full", "off"] }), ["Full", "Off"]);
	assert.deepEqual(await titles({ count: 3, title: "Full" }), ["Full"]);
	// More than 50 values: one JSON parameter, compared as text, for D1's 100 bound parameters
	const many = Array.from({ length: MANY }, (_, i) => ids.get(`m${i}`) as string);
	queries = [];
	assert.equal((await titles({ id: many })).length, MANY);
	assert.match(queries.at(-1) ?? "", /json_each/);
	assert.deepEqual(await titles({ id: [] }), (await titles({})).sort(), "an empty list is no condition, as in EmDash");
});

test("reads left to EmDash: a condition on a taxonomy, a range, an unknown column or collection", async () => {
	const deps = request();
	assert.equal(await readRows(deps, "things", { status: "published", where: { topic: "birds" } }, ["title"]), null);
	assert.equal(await readRows(deps, "things", { status: "published", where: { count: { gt: 1 } } }, ["title"]), null);
	assert.equal(await readRows(deps, "things", { status: "published", where: { owner: "x" } }, ["title"]), null, "a reference has no column");
	assert.equal(await readRows(deps, "nothings", { status: "published" }, ["title"]), null);
});

test("the fields of every collection are read once a request", async () => {
	const deps = request();
	queries = [];
	await readRows(deps, "things", { status: "published" }, ["title"]);
	await readRows(deps, "owners", { status: "published" }, ["name"]);
	assert.equal(queries.filter((q) => q.includes("_emdash_fields")).length, 1);
	assert.equal(queries.length, 3);
});

test("entryOf leaves a value that is not text as it is", () => {
	const e = entryOf({ id: "01X", slug: null, status: "published", created_at: null, flag: 1, n: 2, obj: null }, new Set(["flag"]));
	assert.deepEqual(e, { id: "01X", data: { id: "01X", slug: null, status: "published", createdAt: null, flag: true, n: 2, obj: null } });
});
