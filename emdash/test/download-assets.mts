#!/usr/bin/env node
/**
 * --download-assets must never leave a partial file where a rerun counts it
 * as done. Runs the converter on the edge-cases fixture twice, offline, with
 * fetch replaced by test/fake-fetch.mts:
 *   1. every download dies mid-stream: no file may be left in the backup dir
 *   2. rerun with working downloads: every asset arrives whole
 *
 *   node test/download-assets.mts   (npm test runs it before the fixtures)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fakeFetch = pathToFileURL(join(root, "test", "fake-fetch.mts")).href;
const work = mkdtempSync(join(tmpdir(), "ts2emdash-downloads-"));
const backupDir = join(work, "assets");

// The three ASSET rows in test/fixtures/edge-cases/data.jsonl, sorted
const EXPECTED = ["proj/dev/img1/photo one.jpg", "proj/dev/img2/b.png", "proj/dev/pdf1/brochure.pdf"];
// What fake-fetch.mts serves in ok mode
const FULL_SIZE = 50_000;

const filesIn = (dir: string) =>
	existsSync(dir)
		? readdirSync(dir, { recursive: true, withFileTypes: true })
				.filter((d) => d.isFile())
				.map((d) => relative(dir, join(d.parentPath, d.name)))
				.sort()
		: [];

const convert = (mode: "ok" | "broken", dir = backupDir, env: Record<string, string> = {}) => {
	const report = join(work, "report.md");
	rmSync(report, { force: true });
	const res = spawnSync(
		process.execPath,
		["--no-warnings", "--import", fakeFetch, "ts2emdash.mts", join(root, "test", "fixtures", "edge-cases"), "--out", join(work, "seed.json"), "--report", report, "--download-assets", dir],
		{ cwd: root, encoding: "utf8", env: { ...process.env, FAKE_FETCH: mode, ...env } },
	);
	const m = existsSync(report) ? readFileSync(report, "utf8").match(/Asset backup: (\d+) downloaded .*?, (\d+) failed/) : null;
	return { status: res.status, stderr: res.stderr.trim(), downloaded: m ? Number(m[1]) : null, failed: m ? Number(m[2]) : null };
};

const problems: string[] = [];
const check = (ok: boolean, message: string) => {
	if (!ok) problems.push(message);
};

const broken = convert("broken");
check(broken.status === 0, `run 1 exited ${broken.status}: ${broken.stderr}`);
check(broken.downloaded === 0 && broken.failed === 3, `run 1 report says ${broken.downloaded} downloaded, ${broken.failed} failed (want 0 and 3)`);
const leftover = filesIn(backupDir);
check(!leftover.length, `run 1 left files behind: ${leftover.map((f) => `${f} (${statSync(join(backupDir, f)).size} bytes)`).join(", ")}`);

const ok = convert("ok");
check(ok.status === 0, `run 2 exited ${ok.status}: ${ok.stderr}`);
check(ok.downloaded === 3 && ok.failed === 0, `run 2 report says ${ok.downloaded} downloaded, ${ok.failed} failed (want 3 and 0)`);
const got = filesIn(backupDir);
check(JSON.stringify(got) === JSON.stringify(EXPECTED), `run 2 backup dir holds ${got.join(", ") || "nothing"}`);
for (const f of EXPECTED) {
	const size = existsSync(join(backupDir, f)) ? statSync(join(backupDir, f)).size : 0;
	check(size === FULL_SIZE, `run 2 ${f} is ${size} bytes (want ${FULL_SIZE})`);
}

// A body that ends early without an error (seen over HTTP/2 on Node 26) must not be kept either
const shortDir = join(work, "short");
const short = convert("ok", shortDir, { FAKE_FETCH_SHORT: "9" });
check(short.status === 0, `run 3 exited ${short.status}: ${short.stderr}`);
check(short.downloaded === 0 && short.failed === 3, `run 3 report says ${short.downloaded} downloaded, ${short.failed} failed (want 0 and 3)`);
const kept = filesIn(shortDir);
check(!kept.length, `run 3 kept short files: ${kept.map((f) => `${f} (${statSync(join(shortDir, f)).size} bytes)`).join(", ")}`);

console.log(`${problems.length ? "FAIL" : "ok  "} download-assets    interrupted or short downloads leave nothing behind, a rerun completes them`);
for (const p of problems) console.log(`       ${p}`);
if (problems.length) console.log(`       outputs kept in ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
