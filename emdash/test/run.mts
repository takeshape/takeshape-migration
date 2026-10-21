#!/usr/bin/env node
/**
 * End-to-end test: every fixture in test/fixtures goes through
 *   1. ts2emdash.mts (convert)
 *   2. emdash seed --validate
 *   3. emdash seed into a fresh SQLite database (--on-conflict update)
 * and the database is checked for the expected entry count.
 *
 *   npm test                 all fixtures
 *   npm test -- shape-blog   one fixture
 *
 * Every fixture's asset URLs are made up, so emdash seed reports their
 * downloads as failed. The counts are printed, not failed on.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(root, "test", "fixtures");
const work = join(root, "test", ".out");

// emdash's exports map hides package.json, so look for it in node_modules directly
let emdashCli: string;
for (let dir = root; ; dir = dirname(dir)) {
	const pkgPath = join(dir, "node_modules", "emdash", "package.json");
	if (existsSync(pkgPath)) {
		emdashCli = join(dirname(pkgPath), JSON.parse(readFileSync(pkgPath, "utf8")).bin.emdash);
		break;
	}
	if (dirname(dir) === dir) {
		console.error("emdash is not installed. Run npm install first.");
		process.exit(1);
	}
}

const only = process.argv.slice(2);
const fixtures = readdirSync(fixturesDir).filter((f) => existsSync(join(fixturesDir, f, "schema.json")) && (!only.length || only.includes(f)));
if (!fixtures.length) {
	console.error(`No fixtures matched ${only.join(", ")}`);
	process.exit(1);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const run = (args: string[], opts: { timeout?: number } = {}) =>
	spawnSync(process.execPath, ["--no-warnings", ...args], { cwd: root, encoding: "utf8", ...opts });

let failures = 0;
const results: { name: string; ok: boolean; created: number; updated: number; media: { uploaded: number; failed: number }; problems: string[] }[] = [];
for (const name of fixtures) {
	const seed = join(work, `${name}.seed.json`);
	const report = join(work, `${name}.report.md`);
	const db = join(work, `${name}.db`);
	const problems: string[] = [];

	const convert = run(["ts2emdash.mts", join(fixturesDir, name), "--out", seed, "--report", report]);
	if (convert.status !== 0) problems.push(`convert failed: ${(convert.stderr || convert.stdout).trim().split("\n").pop()}`);

	let expected = 0;
	if (!problems.length) {
		const parsed: { content?: Record<string, unknown[]> } = JSON.parse(readFileSync(seed, "utf8"));
		expected = Object.values(parsed.content ?? {}).reduce((n, list) => n + list.length, 0);
		const validate = run([emdashCli, "seed", seed, "--validate"]);
		if (validate.status !== 0 || !/Seed file is valid/.test(validate.stdout + validate.stderr)) problems.push("seed --validate failed");
	}

	let media = { uploaded: 0, failed: 0 };
	let created = 0;
	let updated = 0;
	if (!problems.length) {
		const apply = run([emdashCli, "seed", seed, "--database", db, "--on-conflict", "update", "--uploads-dir", join(work, `${name}-uploads`)], { timeout: 600_000 });
		const out = apply.stdout + apply.stderr;
		if (apply.status !== 0 || /ERROR/.test(out)) problems.push(`seed apply failed: ${out.split("\n").find((l) => /ERROR|rror:/.test(l)) ?? `exit ${apply.status}`}`);
		if (/did not resolve/.test(out)) problems.push("a $ref did not resolve");
		const m = out.match(/Content:\s*(\d+) created,\s*(\d+) skipped,\s*(\d+) updated/);
		if (m) {
			created = Number(m[1]);
			updated = Number(m[3]);
			// Placeholder (stub) entries are created and then updated, so created + updated covers every seed row
			if (created + updated !== expected) problems.push(`expected ${expected} seed rows, got ${created} created + ${updated} updated`);
		} else if (!problems.length) problems.push("no Content summary in seed output");
		media.uploaded = (out.match(/Uploaded:/g) ?? []).length;
		// A failed URL is retried at every place it is used, so count distinct URLs
		const failedUrls = new Set([...out.matchAll(/(?:Failed to download|Error processing \$media) (https?:\/\/\S+?):? /g)].map((x) => x[1]));
		media.failed = failedUrls.size;
	}

	if (problems.length) failures++;
	results.push({ name, ok: !problems.length, created, updated, media, problems });
	const status = problems.length ? "FAIL" : "ok  ";
	console.log(`${status} ${name.padEnd(18)} entries ${String(created).padStart(3)} created ${String(updated).padStart(2)} updated   media ${media.uploaded} copied, ${media.failed} failed`);
	for (const p of problems) console.log(`       ${p}`);
}

console.log(`\n${fixtures.length - failures}/${fixtures.length} fixtures passed. Seeds, reports and databases are in test/.out/`);
console.log("The fixtures' asset URLs are made up, so emdash seed reports their downloads as failed.");
process.exit(failures ? 1 : 0);
