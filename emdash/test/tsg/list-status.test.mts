/**
 * Which entries a TakeShape list returns by status, decided once in list-status.mts and used by both the
 * loader planner and the site slugs. Each case runs through the module, a planned loader against a stub, and
 * computeSiteSlugs, which must all agree.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FieldMap } from "../../ts2emdash.mts";
import { listStatus, onlyEnabledFilters } from "../../tsg2astro/list-status.mts";
import type { ListStatus } from "../../tsg2astro/list-status.mts";
import { listOptions, planQuery } from "../../tsg2astro/queries.mts";
import { Report } from "../../tsg2astro/report.mts";
import { listEntries } from "../../tsg2astro/runtime/query.ts";
import type { EmDashApi, Entry } from "../../tsg2astro/runtime/query.ts";
import { loadTakeShapeSchema } from "../../tsg2astro/schema.mts";
import { computeSiteSlugs } from "../../tsg2astro/site-slugs.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = join(root, "test", "fixtures", "shape-books");
const work = mkdtempSync(join(tmpdir(), "list-status-"));
after(() => rmSync(work, { recursive: true, force: true }));

const res = spawnSync(process.execPath, ["--no-warnings", "ts2emdash.mts", fixture, "--out", join(work, "seed.json"), "--report", join(work, "report.md")], { cwd: root, encoding: "utf8" });
assert.equal(res.status, 0, res.stderr);
const fieldMap: FieldMap = JSON.parse(readFileSync(join(work, "takeshape-field-map.json"), "utf8"));
const rawSchema = JSON.parse(readFileSync(join(fixture, "schema.json"), "utf8"));
const schema = loadTakeShapeSchema(rawSchema);
const POST = rawSchema.shapes.Post;
const TITLE_KEY = String(POST.schema.properties.title["@mapping"]).split(".").pop();

test("listStatus follows TakeShape's onlyEnabled and status clauses", () => {
	const cases: Array<[string, Record<string, unknown>, ListStatus]> = [
		["no where or filter", {}, "published"],
		["onlyEnabled false", { onlyEnabled: false }, "all"],
		["onlyEnabled true", { onlyEnabled: true }, "published"],
		["where on a field", { where: { title: { eq: "A" } } }, "all"],
		["empty where", { where: {} }, "all"],
		["null where", { where: null }, "published"],
		["_enabled eq true", { where: { _enabled: { eq: true } } }, "published"],
		["_enabled eq false", { where: { _enabled: { eq: false } } }, "drafts"],
		["_enabled in both", { where: { _enabled: { in: [true, false] } } }, "all"],
		["_status by name", { where: { _status: { eq: "enabled" } } }, "published"],
		["_status by key", { where: { _status: { eq: "r1uCfi4ZL" } } }, "drafts"],
		["_enabled inside AND", { where: { AND: [{ title: { eq: "A" } }, { _enabled: { eq: true } }] } }, "published"],
		["_enabled inside OR", { where: { OR: [{ _enabled: { eq: true } }, { title: { eq: "A" } }] } }, "all"],
		["contradiction", { where: { _enabled: { eq: true } }, filter: { term: { _enabled: false } } }, "none"],
		["filter match", { filter: { bool: { must: { match: { _enabled: true } } } } }, "published"],
		["filter must_not", { filter: { bool: { must_not: { match: { _enabled: true } } } } }, "drafts"],
		["filter must_not on a field", { filter: { bool: { must_not: { match: { deck: "x" } } } } }, "all"],
		["filter should", { filter: { bool: { should: [{ term: { _enabled: true } }] } } }, "all"],
		["onlyEnabled ignored with where", { where: { title: { eq: "A" } }, onlyEnabled: true }, "all"],
	];
	for (const [name, args, want] of cases) assert.equal(listStatus(args).status, want, name);
	assert.equal(listStatus({ where: { OR: [{ _enabled: { eq: true } }] } }).guessed, true);
	assert.equal(listStatus({ where: { _status: { eq: "inReview" } } }).guessed, true);
	assert.equal(listStatus({ where: { _enabled: { eq: false } } }).guessed, false);
});

// ---------------------------------------------------------------------------
// The planner and the site slugs agree on every case
// ---------------------------------------------------------------------------

const AGREEMENT: Array<{ name: string; args: string; variables?: Record<string, unknown>; want: ListStatus }> = [
	{ name: "plain", args: "", want: "published" },
	{ name: "status-enabled", args: `(where: {_status: {eq: "enabled"}})`, want: "published" },
	{ name: "status-disabled", args: `(where: {_status: {eq: "disabled"}})`, want: "drafts" },
	{ name: "or-enabled", args: `(where: {OR: [{_enabled: {eq: true}}, {title: {eq: "Live"}}]})`, want: "all" },
	{ name: "enabled-false", args: `(where: {_enabled: {eq: false}})`, want: "drafts" },
	{ name: "only-enabled-false", args: `(onlyEnabled: false)`, want: "all" },
	{ name: "variable-drafts", args: `(where: $where)`, variables: { where: { _enabled: { eq: false } } }, want: "drafts" },
	{ name: "variable-unset", args: `(where: $where)`, want: "published" },
];

const statusOf = (e: Entry) => (e.data.status === "published" ? "live" : "draft");
function stub(entries: Entry[]): EmDashApi {
	return {
		async collection(_type, filter) {
			return { entries: entries.filter((e) => e.data.status === ((filter.status as string | undefined) ?? "published")) };
		},
		async entry() {
			return null;
		},
		async byIds() {
			return [];
		},
		async terms() {
			return new Map();
		},
		async references() {
			return new Map();
		},
		async referrers() {
			return new Map();
		},
	};
}
const entries: Entry[] = [
	{ id: "live", data: { id: "e1", status: "published", title: "Live", takeshape_id: "p1", takeshape_created_at: "2020-01-02T00:00:00.000Z" } },
	{ id: "draft", data: { id: "e2", status: "draft", title: "Draft", takeshape_id: "p2", takeshape_created_at: "2020-01-01T00:00:00.000Z" } },
];
const EXPECT: Record<ListStatus, string[]> = { published: ["live"], drafts: ["draft"], all: ["live", "draft"], none: [] };

test("the planned loader lists what TakeShape listed", async () => {
	for (const c of AGREEMENT) {
		const query = `query${c.args.includes("$where") ? "($where: TSWhereInput)" : ""} { getPostList${c.args} { items { title } } }`;
		// tsg.yml variables decide the status, as they do for the site slugs
		const field = planQuery("data/status.graphql", query, schema, fieldMap, new Report(), c.variables ?? {}).fields[0]!;
		const listed = await listEntries(stub(entries), "posts", field.args, listOptions(field));
		assert.deepEqual(listed.map(statusOf), EXPECT[c.want], c.name);
	}
});

test("site slugs give pages to what TakeShape listed", async () => {
	const rows = [
		{ _id: "p1", _shapeId: POST.id, _enabled: true, [TITLE_KEY!]: "Live" },
		{ _id: "p2", _shapeId: POST.id, _enabled: false, [TITLE_KEY!]: "Draft" },
	];
	for (const c of AGREEMENT) {
		const dir = join(work, `site-${c.name}`);
		mkdirSync(join(dir, "templates"), { recursive: true });
		const data = c.variables ? `\n        query: posts.graphql\n        variables:\n          where: ${JSON.stringify(c.variables.where)}` : " posts.graphql";
		writeFileSync(join(dir, "tsg.yml"), `routes:\n  posts:\n    path: /:title/\n    paginate:\n      data:${data}\n`);
		const query = `query${c.args.includes("$where") ? "($where: TSWhereInput)" : ""} { getPostList${c.args} { items { title } } }`;
		writeFileSync(join(dir, "templates", "posts.graphql"), query);
		const { slugs } = await computeSiteSlugs(dir, { schema: rawSchema, rows });
		const want = EXPECT[c.want].map((s) => (s === "live" ? "p1" : "p2"));
		assert.deepEqual([...slugs.keys()], want, c.name);
	}
});

// ---------------------------------------------------------------------------
// apiVersion 1: no default workflow, so onlyEnabled filters nothing
// ---------------------------------------------------------------------------

const v1Schema = { ...rawSchema, apiVersion: "1", workflows: {} };

test("onlyEnabled keeps published entries only where the shape has a workflow", () => {
	assert.equal(onlyEnabledFilters(rawSchema, "Post"), true);
	assert.equal(onlyEnabledFilters({ ...rawSchema, apiVersion: "2.1" }, "Post"), true);
	assert.equal(onlyEnabledFilters(v1Schema, "Post"), false);
	// A workflow the project defines itself counts in any apiVersion, through its live steps
	const flow = (live: boolean) => ({ name: "review", title: "Review", steps: [{ key: "a1", name: "draft", title: "Draft", live: false }, { key: "a2", name: "out", title: "Out", live }] });
	const withShapeFlow = (live: boolean) => ({ ...v1Schema, workflows: { review: flow(live) }, shapes: { ...v1Schema.shapes, Post: { ...POST, workflow: "review" } } });
	assert.equal(onlyEnabledFilters(withShapeFlow(true), "Post"), true);
	assert.equal(onlyEnabledFilters(withShapeFlow(false), "Post"), false);
	assert.equal(onlyEnabledFilters({ ...v1Schema, workflows: { default: flow(true) } }, "Post"), true);
	// A shape naming a workflow the project lacks gets no filter, in apiVersion 2 too
	assert.equal(onlyEnabledFilters({ ...rawSchema, shapes: { ...rawSchema.shapes, Post: { ...POST, workflow: "gone" } } }, "Post"), false);
});

test("listStatus without a workflow: a plain list returns every entry", () => {
	const none = { onlyEnabledFilters: false };
	assert.equal(listStatus({}, none).status, "all");
	assert.equal(listStatus({ onlyEnabled: true }, none).status, "all");
	assert.equal(listStatus({ where: { _enabled: { eq: true } } }, none).status, "published");
	assert.equal(listStatus({ filter: { bool: { must: { match: { _enabled: false } } } } }, none).status, "drafts");
	assert.equal(listStatus({}, { onlyEnabledFilters: true }).status, "published");
});

const V1_CASES: Array<{ name: string; args: string; want: ListStatus }> = [
	{ name: "plain", args: "", want: "all" },
	{ name: "onlyEnabled-true", args: "(onlyEnabled: true)", want: "all" },
	{ name: "enabled-true", args: `(where: {_enabled: {eq: true}})`, want: "published" },
	{ name: "enabled-false", args: `(where: {_enabled: {eq: false}})`, want: "drafts" },
	{ name: "filter-enabled", args: `(filter: {term: {_enabled: true}})`, want: "published" },
];

test("apiVersion 1 and 2: the planned loader lists what TakeShape listed", async () => {
	const v1 = loadTakeShapeSchema(v1Schema);
	for (const [label, model, plainWant] of [["2", schema, "published"], ["1", v1, "all"]] as const) {
		for (const c of V1_CASES) {
			const want = c.name === "plain" || c.name === "onlyEnabled-true" ? plainWant : c.want;
			const field = planQuery("data/status.graphql", `query { getPostList${c.args} { items { title } } }`, model, fieldMap, new Report()).fields[0]!;
			const listed = await listEntries(stub(entries), "posts", field.args, listOptions(field));
			assert.deepEqual(listed.map(statusOf), EXPECT[want], `apiVersion ${label}, ${c.name}`);
		}
	}
});

test("apiVersion 1 and 2: site slugs give pages to what TakeShape listed", async () => {
	const rows = [
		{ _id: "p1", _shapeId: POST.id, _enabled: true, [TITLE_KEY!]: "Live" },
		{ _id: "p2", _shapeId: POST.id, _enabled: false, [TITLE_KEY!]: "Draft" },
	];
	for (const [label, raw, plainWant] of [["2", rawSchema, "published"], ["1", v1Schema, "all"]] as const) {
		for (const c of V1_CASES) {
			const want = c.name === "plain" || c.name === "onlyEnabled-true" ? plainWant : c.want;
			const dir = join(work, `site-v${label}-${c.name}`);
			mkdirSync(join(dir, "templates"), { recursive: true });
			writeFileSync(join(dir, "tsg.yml"), `routes:\n  posts:\n    path: /:title/\n    paginate:\n      data: posts.graphql\n`);
			writeFileSync(join(dir, "templates", "posts.graphql"), `query { getPostList${c.args} { items { title } } }`);
			const { slugs } = await computeSiteSlugs(dir, { schema: raw, rows });
			assert.deepEqual([...slugs.keys()], EXPECT[want].map((s) => (s === "live" ? "p1" : "p2")), `apiVersion ${label}, ${c.name}`);
		}
	}
});


test("apiVersion 1: a reverse field says the loader leaves out drafts TakeShape listed", () => {
	const query = `query { getAuthorList { items { name authored { items { title } } } } }`;
	const notes = (model: ReturnType<typeof loadTakeShapeSchema>) => {
		const report = new Report();
		planQuery("data/authors.graphql", query, model, fieldMap, report);
		return report.items().filter((i) => i.kind === "query" && /authored/.test(i.message) && /draft/i.test(i.message));
	};
	assert.equal(notes(loadTakeShapeSchema(v1Schema)).length, 1);
	assert.equal(notes(schema).length, 0);
});
