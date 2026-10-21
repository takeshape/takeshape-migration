#!/usr/bin/env node
/**
 * Counts the database queries each page of a translated site makes on the Workers build, from EmDash's own
 * Server-Timing header (`db.count`) and its query log. Run it after `npm run test:tsg-e2e -- <site> --cloudflare`,
 * which leaves the Workers build and its local D1 in test/.cache/tsg-e2e/<site>/.
 *
 *   node test/tsg/query-counts.mts [site] [--sql] [path ...]
 *     for example: node test/tsg/query-counts.mts shape-books --sql / /books/peter-pan/
 *
 * It sets EMDASH_QUERY_LOG=1 in dist/server/.dev.vars for the run (and puts the file back), starts astro preview
 * on port 4513, the site URL the e2e built with, requests every path once so the isolate is warm, then requests
 * each again and prints its status, query count and time. --sql also prints each query. Local D1 answers in about
 * a millisecond, so the times leave out the round trips a deployed site pays for each query.
 */
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const showSql = args.includes("--sql");
const [site = "shape-books", ...given] = args.filter((a) => a !== "--sql");
const work = join(root, "test", ".cache", "tsg-e2e", site);
const PORT = 4513;
// One page of each kind in shape-books, and the 404s
const PATHS = given.length
	? given
	: ["/", "/blog/", "/blog/page-2/", "/blog/follow-the-rabbit/", "/books/peter-pan/", "/authors/c-s-lewis/", "/sitemap.xml", "/blog/nope/", "/blog/nope", "/books/nope/"];

const vars = join(work, "dist", "server", ".dev.vars");
if (!existsSync(vars)) {
	console.error(`No Workers build in ${work}. Run npm run test:tsg-e2e -- ${site} --cloudflare first.`);
	process.exit(2);
}
const saved = readFileSync(vars, "utf8");
const log = join(root, "test", ".out", `tsg-query-counts-${site}.log`);
writeFileSync(vars, `${saved.trimEnd()}\nEMDASH_QUERY_LOG='1'\n`);
const preview = spawn("npx", ["astro", "preview", "--port", String(PORT), "--ignore-lock"], { cwd: work, detached: true, stdio: ["ignore", openSync(log, "w"), openSync(log, "a")] });
let stopped = false;
const stop = () => {
	if (stopped) return;
	stopped = true;
	try {
		process.kill(-(preview.pid as number), "SIGTERM");
	} catch {}
	writeFileSync(vars, saved);
};
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(130));

const base = `http://localhost:${PORT}`;
for (let i = 0; ; i++) {
	try {
		if ((await fetch(`${base}/robots.txt`)).ok) break;
	} catch {}
	if (i > 120) throw new Error(`astro preview did not answer on port ${PORT}; see ${log}`);
	await new Promise((r) => setTimeout(r, 500));
}

let seen = 0;
/** The queries the log gained since the last call. */
function newQueries(): string[] {
	const text = readFileSync(log, "utf8");
	const fresh = text.slice(seen);
	seen = text.length;
	const prefix = "[emdash-query-log] ";
	return fresh
		.split("\n")
		.filter((l) => l.includes(prefix))
		.map((l) => {
			const event = JSON.parse(l.slice(l.indexOf(prefix) + prefix.length)) as { sql: string; params: unknown[] };
			return `${event.sql.replace(/\s+/g, " ").trim()} ${JSON.stringify(event.params)}`;
		});
}

for (const path of PATHS) await (await fetch(`${base}${path}`, { redirect: "manual" })).arrayBuffer();
await new Promise((r) => setTimeout(r, 300));
newQueries();
for (const path of PATHS) {
	const started = performance.now();
	const res = await fetch(`${base}${path}`, { redirect: "manual" });
	await res.arrayBuffer();
	const ms = Math.round(performance.now() - started);
	// The log line for the last query can land just after the response
	await new Promise((r) => setTimeout(r, 300));
	const queries = newQueries();
	const count = /db\.count;dur=(\d+)/.exec(res.headers.get("server-timing") ?? "")?.[1] ?? "0";
	console.log(`${path.padEnd(30)} ${res.status}  ${count.padStart(3)} queries  ${ms} ms`);
	if (showSql) for (const q of queries) console.log(`    ${q}`);
}
stop();
process.exit(0);
