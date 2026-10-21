#!/usr/bin/env node
/**
 * Measures each page of a deployed translated site: D1 queries and DB time from EmDash's Server-Timing header,
 * CPU and wall time from `wrangler tail`, joined by cf-ray. Run it against a deploy, not a local preview.
 *
 *   CLOUDFLARE_ACCOUNT_ID=<id> node test/tsg/deploy-timing.mts <site URL> [<site URL> ...] [path ...]
 *                                  [--runs 8] [--delay-ms 1000] [--out file.json] [--project dir] [--worker site]
 *                                  [--no-tail]
 *     for example: node test/tsg/deploy-timing.mts https://site.<subdomain>.workers.dev --out t.json
 *
 * It starts `npx wrangler tail <worker> --format json` in --project (default test/.cache/tsg-deploy/shape-books,
 * which has wrangler installed) and requests a 404 until tail shows it, since tail prints nothing when it attaches.
 * Then it requests every path once to warm the isolates and makes --runs rounds over all paths, one request at a
 * time, so drift over the run spreads over every page. With several URLs, for example two versions' preview URLs
 * (https://<first 8 of the version id>-<worker>.<subdomain>.workers.dev), each path goes to every URL in turn, in
 * reverse order every other round: runs made one after the other differed more than the versions did (on
 * 2026-10-16 the same build's home page took 428 ms of DB time in one run and 230 ms in the next). It waits
 * --delay-ms before each request: at 3 to 4 requests a second tail delivered only 23 to 41 of 90 events, at about
 * one a second all of them.
 *
 * A request whose Server-Timing has `setup` or `rt.db` ran EmDash's runtime init (a fresh isolate; warm requests
 * carry only `rt;dur=0`): its query counts are listed apart, and the medians use only requests without it. DB time
 * is `db.last`, when the last query finished, counted from the start of EmDash's middleware, so it stays a span
 * when queries overlap. `db.total` adds up each query's own time, so a batch counts once per query in it.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		runs: { type: "string", default: "8" },
		"delay-ms": { type: "string", default: "1000" },
		out: { type: "string" },
		project: { type: "string", default: join(root, "test", ".cache", "tsg-deploy", "shape-books") },
		worker: { type: "string", default: "site" },
		"no-tail": { type: "boolean", default: false },
	},
});
const bases = positionals.filter((p) => /^https?:\/\//.test(p));
const given = positionals.filter((p) => !/^https?:\/\//.test(p));
if (!bases.length) {
	console.error("Usage: node test/tsg/deploy-timing.mts <site URL> [<site URL> ...] [path ...] [--runs 8] [--delay-ms 1000] [--out file.json] [--project dir] [--worker site] [--no-tail]");
	process.exit(2);
}
const runs = Number(values.runs);
const delayMs = Number(values["delay-ms"]);
// One page of each kind in shape-books, with the deploy table's labels, and the 404s
const PAGES: Array<[string, string]> = given.length
	? given.map((p) => [p, p])
	: [
			["home", "/"],
			["post", "/blog/follow-the-rabbit/"],
			["listing /blog/", "/blog/"],
			["listing page 2", "/blog/page-2/"],
			["book", "/books/peter-pan/"],
			["author", "/authors/lewis-carroll/"],
			["sitemap", "/sitemap.xml"],
			["404 at the root", "/nope/"],
			["404 under /blog/", "/blog/nope/"],
			["404 /blog/nope (no slash)", "/blog/nope"],
		];

let stopping = false;
type TailEvent = { cpuTime: number; wallTime: number; outcome: string; scriptVersion?: { id: string }; event?: { request?: { url: string; headers?: Record<string, string> } } };
const tail = new Map<string, TailEvent>();
let tailProc: ReturnType<typeof spawn> | undefined;
if (!values["no-tail"]) {
	tailProc = spawn("npx", ["wrangler", "tail", values.worker, "--format", "json"], { cwd: values.project, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	// wrangler prints each event as indented JSON: a line "{" to a line "}"
	let lines: string[] = [];
	let rest = "";
	tailProc.stdout?.on("data", (chunk: Buffer) => {
		const text = rest + chunk.toString();
		const parts = text.split("\n");
		rest = parts.pop() ?? "";
		for (const line of parts) {
			if (line === "{") lines = [];
			lines.push(line);
			if (line === "}") {
				const event = JSON.parse(lines.join("\n")) as TailEvent;
				const ray = event.event?.request?.headers?.["cf-ray"];
				if (ray) tail.set(ray, event);
			}
		}
	});
	let err = "";
	tailProc.stderr?.on("data", (c: Buffer) => (err += c.toString()));
	tailProc.on("exit", (code) => {
		if (code && !stopping) console.error(`wrangler tail exited ${code}: ${err.trim()}`);
	});
}
const stop = () => {
	stopping = true;
	if (tailProc?.pid) {
		try {
			process.kill(-tailProc.pid, "SIGTERM");
		} catch {}
	}
};
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(130));

type Sample = { base: string; label: string; path: string; round: number; status: number; ray: string; clientMs: number; timings: Record<string, number> };
const ranInit = (s: Sample) => "setup" in s.timings || "rt.db" in s.timings;
function timingsOf(header: string | null): Record<string, number> {
	const out: Record<string, number> = {};
	for (const part of (header ?? "").split(",")) {
		const m = /^\s*([\w.]+)(?:;dur=([\d.]+))?/.exec(part);
		if (m) out[m[1] as string] = Number(m[2] ?? 0);
	}
	return out;
}
async function get(base: string, label: string, path: string, round: number): Promise<Sample> {
	await new Promise((r) => setTimeout(r, delayMs));
	const started = performance.now();
	const res = await fetch(new URL(path, base), { redirect: "manual" });
	await res.arrayBuffer();
	const clientMs = Math.round(performance.now() - started);
	return { base, label, path, round, status: res.status, ray: (res.headers.get("cf-ray") ?? "").replace(/-\w+$/, ""), clientMs, timings: timingsOf(res.headers.get("server-timing")) };
}

if (tailProc) {
	for (let i = 0; ; i++) {
		if (i === 30) throw new Error("wrangler tail delivered no event for 30 probe requests");
		const probe = await get(bases[0] as string, "tail probe", "/nope/", -1);
		await new Promise((r) => setTimeout(r, 2_000));
		if (tail.has(probe.ray)) break;
	}
}

const samples: Sample[] = [];
for (let round = 0; round <= runs; round++) {
	const order = round % 2 ? [...bases].reverse() : bases;
	for (const [label, path] of PAGES) for (const base of order) samples.push(await get(base, label, path, round));
}
if (tailProc) await new Promise((r) => setTimeout(r, 8_000));
stop();

const median = (xs: number[]) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : Math.round(((s[mid - 1] as number) + (s[mid] as number)) / 2);
};
const rows = bases.flatMap((base) =>
	PAGES.map(([label, path]) => {
		const all = samples.filter((s) => s.base === base && s.label === label);
		const warm = all.filter((s) => s.round > 0 && !ranInit(s));
		const withTail = warm.map((s) => tail.get(s.ray)).filter((e): e is TailEvent => !!e);
		return {
			base,
			label,
			path,
			status: [...new Set(all.map((s) => s.status))].join("/"),
			warm: warm.length,
			init: all.filter(ranInit).map((s) => s.timings["db.count"] ?? 0),
			queries: [...new Set(warm.map((s) => s.timings["db.count"] ?? 0))].join("/"),
			dbLastMs: median(warm.map((s) => s.timings["db.last"] ?? 0)),
			dbTotalMs: median(warm.map((s) => s.timings["db.total"] ?? 0)),
			renderMs: median(warm.map((s) => s.timings.render ?? 0)),
			cpuMs: median(withTail.map((e) => e.cpuTime)),
			cpuMaxMs: withTail.length ? Math.max(...withTail.map((e) => e.cpuTime)) : null,
			wallMs: median(withTail.map((e) => e.wallTime)),
			clientMs: median(warm.map((s) => s.clientMs)),
			tailed: withTail.length,
			versions: [...new Set(withTail.map((e) => e.scriptVersion?.id ?? "?"))],
		};
	}),
);

for (const base of bases) {
	const mine = rows.filter((r) => r.base === base);
	console.log(`\n${base} (version ${[...new Set(mine.flatMap((r) => r.versions))].join(", ") || "unknown"})`);
	console.log(`${runs} rounds after one warm-up, ${delayMs} ms apart, medians over requests without runtime init`);
	console.log("page".padEnd(28), "status queries  db.last  db.total  render   cpu (max)   wall  client tailed  init");
	for (const r of mine) {
		console.log(
			r.label.padEnd(28),
			String(r.status).padEnd(6),
			r.queries.padStart(7),
			`${r.dbLastMs}`.padStart(8),
			`${r.dbTotalMs}`.padStart(9),
			`${r.renderMs}`.padStart(7),
			`${r.cpuMs ?? "-"} (${r.cpuMaxMs ?? "-"})`.padStart(11),
			`${r.wallMs ?? "-"}`.padStart(6),
			`${r.clientMs}`.padStart(7),
			`${r.tailed}/${r.warm}`.padStart(6),
			r.init.length ? ` ${r.init.length}x: ${r.init.join(",")} queries` : "",
		);
	}
}
if (values.out) writeFileSync(values.out, `${JSON.stringify({ bases, measuredAt: new Date().toISOString(), runs, delayMs, rows, samples, tail: Object.fromEntries([...tail].map(([ray, e]) => [ray, { cpuTime: e.cpuTime, wallTime: e.wallTime, outcome: e.outcome, version: e.scriptVersion?.id, url: e.event?.request?.url }])) }, null, 2)}\n`);
process.exit(0);
