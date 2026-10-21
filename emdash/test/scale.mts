#!/usr/bin/env node
/**
 * Measures --preload-media on a large synthetic export, offline: <count>
 * assets and <count> posts, each post with one gallery image, served by
 * test/fake-fetch.mts. Runs the converter, runs it again (nothing left to do),
 * then applies the seed with the emdash CLI and prints one table.
 *
 *   node test/scale.mts [count]   default 30000
 *
 * Exits 1 if a run fails or the apply downloads anything.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeSyntheticExport } from "./synthetic-export.mts";

const count = Number(process.argv[2] ?? 30000);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fakeFetch = pathToFileURL(join(root, "test", "fake-fetch.mts")).href;
const emdashPkg = join(root, "node_modules", "emdash");
const emdashCli = join(emdashPkg, JSON.parse(readFileSync(join(emdashPkg, "package.json"), "utf8")).bin.emdash);
const ws = mkdtempSync(join(tmpdir(), "ts2emdash-scale-"));

writeSyntheticExport(join(ws, "export"), {
	assets: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, path: `proj/dev/s${i}/img${i}.jpg`, filename: `img${i}.jpg`, mimeType: "image/jpeg" })),
	posts: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, title: `Post ${i}`, slug: `post-${i}`, gallery: [`s${i}`] })),
});

const timed = (args: string[], env: Record<string, string> = {}) => {
	const start = performance.now();
	const res = spawnSync(process.execPath, ["--no-warnings", ...args], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env } });
	return { ...res, seconds: (performance.now() - start) / 1000 };
};
const convertArgs = [
	"--import", fakeFetch, "ts2emdash.mts", join(ws, "export"),
	"--out", join(ws, "seed.json"), "--report", join(ws, "report.md"),
	"--preload-media", "local", "--database", join(ws, "data.db"), "--uploads-dir", join(ws, "uploads"),
];
const env = { FAKE_FETCH: "images", FAKE_FETCH_STATS: join(ws, "stats.json") };

const problems: string[] = [];
const first = timed(convertArgs, env);
if (first.status !== 0) problems.push(`preload run exited ${first.status}: ${first.stderr.trim().split("\n").pop()}`);
const stats = existsSync(join(ws, "stats.json")) ? JSON.parse(readFileSync(join(ws, "stats.json"), "utf8")) : {};
const rerun = timed(convertArgs, env);
if (rerun.status !== 0) problems.push(`rerun exited ${rerun.status}: ${rerun.stderr.trim().split("\n").pop()}`);
const apply = timed([emdashCli, "seed", join(ws, "seed.json"), "--database", join(ws, "data.db"), "--uploads-dir", join(ws, "uploads"), "--on-conflict", "update"]);
const out = apply.stdout + apply.stderr;
const downloads = (out.match(/Downloading/g) ?? []).length;
if (apply.status !== 0) problems.push(`emdash seed exited ${apply.status}`);
if (downloads) problems.push(`emdash seed downloaded ${downloads} file(s)`);

const mb = (file: string) => {
	const bytes = [file, `${file}-wal`].filter(existsSync).reduce((n, f) => n + statSync(f).size, 0);
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
const table: [string, string][] = [
	["assets and posts", String(count)],
	["preload run", `${first.seconds.toFixed(1)} s`],
	["rerun, nothing to do", `${rerun.seconds.toFixed(1)} s`],
	["peak memory, preload run", `${((stats.maxRssBytes ?? 0) / 1024 / 1024).toFixed(0)} MB`],
	["ledger", mb(join(ws, "takeshape-media.db"))],
	["seed", mb(join(ws, "seed.json"))],
	["data.db after apply", mb(join(ws, "data.db"))],
	["emdash seed apply", `${apply.seconds.toFixed(1)} s (${out.match(/Content:.*/)?.[0] ?? "no Content line"})`],
	["downloads during apply", String(downloads)],
];
console.log("| Measure | Value |\n| --- | --- |");
for (const [k, v] of table) console.log(`| ${k} | ${v} |`);
for (const p of problems) console.log(`FAIL ${p}`);
if (problems.length) console.log(`workspace kept in ${ws}`);
else rmSync(ws, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
