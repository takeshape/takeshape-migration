/**
 * plan-query on the books starter: the loader for a query a page's script sent TakeShape, as tsg2astro plans
 * tsg.yml's queries. ts2emdash writes the field map into a temp folder first.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const exportDir = join(root, "test", "fixtures", "shape-books");
const work = mkdtempSync(join(tmpdir(), "plan-query-"));
after(() => rmSync(work, { recursive: true, force: true }));

const run = (script: string, args: string[]) => spawnSync(process.execPath, ["--no-warnings", script, ...args], { cwd: root, encoding: "utf8" });
const converted = run("ts2emdash.mts", [exportDir, "--out", join(work, "seed.json"), "--report", join(work, "report.md")]);
assert.equal(converted.status, 0, converted.stderr);
const fieldMap = join(work, "takeshape-field-map.json");

function plan(name: string, query: string, extra: string[] = []) {
	const file = join(work, `${name}.graphql`);
	writeFileSync(file, query);
	return run("tsg2astro/plan-query.mts", [file, "--export", exportDir, "--field-map", fieldMap, ...extra]);
}

test("an author with a cut list of their books, written for src/loaders/browser/", () => {
	const res = plan("author-books", `{ getAuthor(_id: "a1") { name authored(size: 3, filter: { bool: { should: [{ match: { title: "x" } }] } }) { total items { title } } } }`);
	assert.equal(res.status, 0, res.stderr);
	assert.match(res.stdout, /^\/\/ Loads what browser\/author-books\.graphql asked TakeShape for/);
	assert.match(res.stdout, /from "\.\.\/\.\.\/lib\/takeshape\/query\.ts"/);
	assert.match(res.stdout, /getEntry\(api, "authors", "a1"/);
	assert.match(res.stdout, /reverseReferencesOf\(api, "books", "author", \[author\], \{ args: \{[^\n]*size: 3,/);
	// The planner says what it left out, for the person wiring the loader up
	assert.match(res.stderr, /"should" in the filter is left out/);
});

test("--out writes the loader to a file", () => {
	const out = join(work, "books.ts");
	const res = plan("books", "{ getBookList(size: 5) { items { title } } }", ["--out", out]);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.stdout, "");
	assert.match(readFileSync(out, "utf8"), /listEntries\(api, "books"/);
});

test("a query that doesn't parse exits 1, a usage error 2", () => {
	const broken = plan("broken", "{ getBookList( }");
	assert.equal(broken.status, 1);
	assert.match(broken.stderr, /could not be parsed/);
	assert.equal(run("tsg2astro/plan-query.mts", [join(work, "books.graphql")]).status, 2);
	assert.equal(plan("unknown", "{ getBookList { total } }", ["--sideways"]).status, 2);
});
