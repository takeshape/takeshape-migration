#!/usr/bin/env node
/**
 * End to end: a test site goes through the whole migration and the result is compared with its golden build (the
 * HTML the real takeshape-ssg wrote, from npm run test:tsg-golden). Node mode always runs; --cloudflare then moves
 * the content to local D1 and R2 through EmDash's site transfer and compares the Workers build too.
 *
 *   npm run test:tsg-e2e -- <site> [--cloudflare]
 *     for example: npm run test:tsg-e2e -- shape-books --cloudflare
 *
 * It runs without TakeShape's CDN. The site needs its saved assets (sites/<site>/assets/, else exit 2) and should
 * have its image index (see the site's SOURCE.md):
 *   - sites/<site>/assets/ holds the original files, laid out as ts2emdash --download-assets writes them. The
 *     converter preloads the media from there: test/fake-fetch.mts in dir mode answers assets.takeshape.io from
 *     that folder and refuses every other host, and emdash seed then downloads nothing.
 *   - sites/<site>/image-index.json holds the old image's size and hash for one golden image per setting (the
 *     site's SOURCE.md says how its entries were made). Each compare makes the golden's other TakeShape images
 *     from the preloaded originals (--media <work>) and checks its rules against those entries (--image-index),
 *     so it asks imgix nothing.
 * Every request is recorded: fake-fetch's log for the preload, compare-sites --fetch-log for each compare. Any
 * request to a *.takeshape.io host fails the run (exit 4).
 *
 * It works in test/.cache/tsg-e2e/<site>/, which is kept between runs so node_modules stays.
 *   1. ts2emdash.mts with --site writes the seed, the field map and the content report into <work>/takeshape/.
 *      data.db, uploads/ and the media ledger are deleted first, and it runs with
 *      --preload-media local --database <work>/data.db --uploads-dir <work>/uploads. Its summary must say
 *      0 failed.
 *   2. tsg2astro writes the Astro project into <work>.
 *   3. npm install (skipped when package.json and the lockfile are what the last install left), then the seed.
 *      npm run takeshape:seed applies the seed to the preloaded data.db and must download nothing.
 *      A media file the seed could not store fails the run.
 *   4. npm run build:node, then the Node server with the node arguments of the project's start:node script
 *      (so it loads .env as a customer's server does), on port 4510 under the fixed clock (TSG_FIXED_NOW from
 *      golden.json, so dates printed for "now" match the golden). The server is ready when / answers 200.
 *   5. compare-sites.mts compares sites/<site>/golden with http://localhost:4510 and writes
 *      test/.out/tsg-e2e-<site>.md. Every file in golden/ is passed with --urls (written to
 *      test/.out/tsg-e2e-<site>-urls.txt), so files no page links to, like robots.txt, are compared too.
 *      The server is stopped afterwards.
 *
 * With --cloudflare, after step 5 (the Node compare's differences do not stop it):
 *   6. astro dev on the Node config (port 4511), emdash site export into <work>/site.emdash, then that server stops.
 *   7. .wrangler/state is deleted (only that: astro preview needs .wrangler/deploy), so local D1 and R2 start empty.
 *   8. astro dev on the Cloudflare config (port 4512, workerd). emdash site import --analyze must give a plan
 *      without blockers; the import then runs with that plan's digest and its receipt must say verified. The
 *      server stops. The import needs a dev server: only dev lets localhost in without a token.
 *   9. EMDASH_SITE_URL=http://localhost:4513 goes into <work>/.env, so the build and the preview's
 *      dist/server/.dev.vars agree (checked after the build). npm run build, then astro preview on port 4513.
 *  10. compare-sites.mts compares the golden with http://localhost:4513 into test/.out/tsg-e2e-<site>-cloudflare.md,
 *      ignoring "Published <date>": workerd can't take the fixed clock, and the book page prints the current date
 *      for a field the page does not query.
 *
 * Astro 7.4 starts dev and preview servers in the background when it detects an agent; --ignore-lock keeps them
 * in the foreground, where this script can stop them. Every server runs in its own process group and is stopped
 * with all it started (workerd included) once its step is done, and on every way out of the script.
 *
 * The export is sites/<site>/export/. Until that folder exists, test/fixtures/<site>/ is used and a line says so.
 * Server output goes to test/.out/tsg-e2e-<site>-server.log (Node) and tsg-e2e-<site>-<export|import|preview>-server.log.
 * Request logs: test/.out/tsg-e2e-<site>-preload-fetches.txt and tsg-e2e-<site>[-cloudflare]-fetches.txt.
 *
 * Exit codes:
 *   0  no compare found differences
 *   1  a compare found differences, or stopped at its page cap
 *   2  usage error, or a compare could not run
 *   3  not compared: sites/<site>/golden/ is missing. Every step up to starting the last server ran.
 *   4  the run stopped before its last compare: a port this run needs was in use; a step failed (its output is above);
 *      a server did not answer / with 200; with --cloudflare, the site export failed, the import plan had
 *      blockers, the import did not end complete and verified, or .dev.vars disagrees with the build;
 *      the preload failed a file, emdash seed downloaded one, or any request went to a TakeShape host; or an
 *      unexpected error (a malformed golden.json, a process that could not start). The message names the step.
 * 130  interrupted by SIGINT, SIGTERM or SIGHUP. Every server and command it started is stopped first.
 *
 * The generated project needs Node 22.22 or later.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withSiteUrl } from "../../tsg2astro/scaffold.mts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const PORT = 4510;
const SITE_URL = `http://localhost:${PORT}`;
const PORTS = { export: 4511, import: 4512, preview: 4513 };
// build-golden.mts uses this clock when golden.json has none
const DEFAULT_NOW = "2026-10-15T16:00:00.000Z";
// The book page prints "Published <current date>" for a field it does not query, and workerd runs on the real
// clock.
const CLOUDFLARE_IGNORE_TEXT = "Published [A-Z][a-z]+ \\d{1,2}, \\d{4}";

const EXIT = { usage: 2, notCompared: 3, stopped: 4 };
const USAGE = "Usage: node test/tsg/e2e.mts <site> [--cloudflare]   (a folder under test/tsg/sites/)";
const FLAGS = ["--cloudflare"];

/** The site name and flags, or what is wrong with them. */
export function parseArgs(argv: string[]): { name: string; cloudflare: boolean } | { error: string } {
	const flags = argv.filter((a) => a.startsWith("--"));
	const names = argv.filter((a) => !a.startsWith("--"));
	const unknown = flags.filter((f) => !FLAGS.includes(f));
	if (unknown.length) return { error: `Unknown option ${unknown.join(", ")}. ${USAGE}` };
	if (names.length > 1) return { error: `Give one site, not ${names.join(", ")}. ${USAGE}` };
	const name = names[0];
	if (!name || !/^[\w.-]+$/.test(name) || name === "." || name === "..") return { error: USAGE };
	return { name, cloudflare: flags.includes("--cloudflare") };
}

/** The counts on ts2emdash's "Preloaded" line, or null when it printed none. */
export function preloadSummary(output: string): { entries: number; downloaded: number; present: number; failed: number } | null {
	const m = /Preloaded (\d+) images and files into .* \((\d+) downloaded, (\d+) already there, (\d+) failed\)/.exec(output);
	return m ? { entries: Number(m[1]), downloaded: Number(m[2]), present: Number(m[3]), failed: Number(m[4]) } : null;
}

/** The lines of `emdash seed` output that say it downloaded a media file. */
export function mediaDownloads(seedOutput: string): string[] {
	return seedOutput.split("\n").filter((l) => /Downloading: /.test(l));
}

const hostOf = (url: string): string | null => {
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
};

/** The requests that went to takeshape.io or any of its subdomains. */
export function takeshapeRequests(urls: string[]): string[] {
	return urls.filter((u) => {
		const host = hostOf(u)?.toLowerCase();
		return host !== undefined && /(^|\.)takeshape\.io(:\d+)?$/.test(host);
	});
}

/** How many requests went to each host, sorted by host. */
export function hostCounts(urls: string[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const u of urls) {
		const host = hostOf(u);
		if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
	}
	return [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** EMDASH_SITE_URL from a .dev.vars file, unquoted, or null when it has none. */
export function devVarsSiteUrl(text: string): string | null {
	const m = /^\s*EMDASH_SITE_URL\s*=\s*(.*?)\s*$/m.exec(text);
	if (!m) return null;
	const v = m[1]!;
	return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
}

/**
 * The Node server's arguments: the generated project's `start:node` script (`node <args>`), with the fixed clock
 * imported first, so the e2e serves the build the way a customer does, `.env` included.
 */
export function nodeServerArgs(startScript: string, clock: string): string[] {
	const [command, ...args] = startScript.trim().split(/\s+/);
	if (command !== "node" || !args.length) throw new Error(`start:node is not a node command with arguments: ${startScript}`);
	return ["--import", clock, ...args];
}

/** The lines of `emdash seed` output that say a media file was not stored. */
export function mediaFailures(seedOutput: string): string[] {
	return seedOutput.split("\n").filter((l) => /Failed to download|Error processing \$media|Skipping \$media reference/.test(l));
}

/** The status `url` answers with, or null when nothing answers. */
async function statusOf(url: string): Promise<number | null> {
	try {
		const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) });
		await res.body?.cancel();
		return res.status;
	} catch {
		return null;
	}
}

/** Whether anything accepts connections on `port` on localhost, over IPv4 or IPv6, whatever it speaks. */
export async function portInUse(port: number): Promise<boolean> {
	const accepts = (host: string) =>
		new Promise<boolean>((done) => {
			const socket = connect({ port, host });
			const finish = (inUse: boolean) => {
				socket.destroy();
				done(inUse);
			};
			socket.setTimeout(1000, () => finish(false));
			socket.once("connect", () => finish(true));
			socket.once("error", () => finish(false));
		});
	const results = await Promise.all(["127.0.0.1", "::1"].map(accepts));
	return results.some(Boolean);
}

/**
 * Waits for the server at `url`. It is ready when `url` answers 200. Any other status fails at once, and so does
 * a server that is no longer `alive` or still silent at the deadline.
 */
export async function waitForServer(url: string, alive: () => boolean, timeoutMs = 60_000): Promise<{ ok: true } | { ok: false; reason: string }> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = await statusOf(url);
		if (status === 200) return { ok: true };
		if (status !== null) return { ok: false, reason: `${url} answered ${status}, not 200` };
		if (!alive()) return { ok: false, reason: "the server exited" };
		if (Date.now() > deadline) return { ok: false, reason: `nothing answered ${url} within ${Math.round(timeoutMs / 1000)} s` };
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** The URL path of every file in a golden build, sorted: `x/index.html` is `/x/`, as the old host served it. */
export function goldenUrls(golden: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
			else if (e.name !== ".DS_Store") out.push(e.name === "index.html" ? `/${prefix}` : `/${prefix}${e.name}`);
		}
	};
	walk(golden, "");
	return out.sort();
}

type Json = Record<string, unknown>;
const parsed = (text: string): Json | null => {
	try {
		const v: unknown = JSON.parse(text);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
	} catch {
		return null;
	}
};
const cliError = (j: Json): string | null => {
	const e = j.error as { code?: string; message?: string } | undefined;
	return e ? `${e.code ?? "error"}: ${e.message ?? JSON.stringify(e)}` : null;
};
type Issue = { code: string; message?: string; kind?: string };
const issueList = (issues: Issue[]) => issues.map((i) => `${i.code}${i.kind ? ` [${i.kind}]` : ""}${i.message ? `: ${i.message}` : ""}`).join("; ");

/** The plan digest from the JSON `emdash site import <file> --analyze --json` prints, or why the plan cannot run. */
export function planDigestOf(stdout: string): { digest: string } | { error: string } {
	const j = parsed(stdout.trim());
	if (!j) return { error: `its output is not JSON: ${stdout.trim().slice(0, 200) || "(empty)"}` };
	const failed = cliError(j);
	if (failed) return { error: failed };
	const blockers = ((j.plan as { blockers?: Issue[] } | undefined)?.blockers ?? []) as Issue[];
	if (blockers.length || j.executable === false) return { error: `the plan has ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}: ${issueList(blockers) || "(none listed)"}` };
	const digest = typeof j.planDigest === "string" ? j.planDigest : "";
	if (/^sha256:[0-9a-f]{64}$/.test(digest)) return { digest };
	if (/^[0-9a-f]{64}$/.test(digest)) return { digest: `sha256:${digest}` };
	return { error: `no plan digest in its output (planDigest is ${JSON.stringify(j.planDigest)})` };
}

/** Whether `emdash site import <file> --plan <digest> --confirm --json` ended complete, verified, with a valid receipt. */
export function receiptCheck(stdout: string): { ok: true; counts: Record<string, number>; warnings: Issue[] } | { ok: false; reason: string } {
	const j = parsed(stdout.trim());
	if (!j) return { ok: false, reason: `its output is not JSON: ${stdout.trim().slice(0, 200) || "(empty)"}` };
	const failed = cliError(j);
	if (failed) return { ok: false, reason: failed };
	if (j.state !== "complete") {
		const op = (j.operation ?? {}) as { errorCode?: string; errorDetail?: unknown };
		return { ok: false, reason: `the import is ${String(j.state)}${op.errorCode ? ` (${op.errorCode}${op.errorDetail ? ` ${JSON.stringify(op.errorDetail)}` : ""})` : ""}` };
	}
	const receipt = (j.receipt ?? {}) as { verification?: string; counts?: Record<string, number>; warnings?: Issue[] };
	if (receipt.verification !== "verified") return { ok: false, reason: `the receipt's verification is ${receipt.verification ?? "missing"}, not verified` };
	if (j.receiptDigestValid !== true) return { ok: false, reason: "the receipt digest does not match the receipt" };
	return { ok: true, counts: receipt.counts ?? {}, warnings: receipt.warnings ?? [] };
}

/** A step that failed and said why; the run stops with exit 4. */
class Stopped extends Error {}

const timings: { step: string; seconds: number; note?: string }[] = [];
// The step under way, for the message of an unexpected error
let currentStep = "setup";

function printTimings() {
	if (!timings.length) return;
	console.log("\nStep times:");
	for (const t of timings) console.log(`  ${t.step.padEnd(22)} ${t.seconds.toFixed(1).padStart(6)} s${t.note ? `  (${t.note})` : ""}`);
}

// Commands running now, so a signal to this script stops them too and not only the servers
const steps = new Set<ChildProcess>();

type RunOptions = { env?: NodeJS.ProcessEnv; echoStdout?: boolean };

/** Runs a command, passing its output through (stdout only when `echoStdout`), and returns its exit code and output. */
function run(command: string, args: string[], cwd: string, options: RunOptions = {}): Promise<{ code: number; output: string; stdout: string }> {
	const echoStdout = options.echoStdout ?? true;
	return new Promise((done) => {
		// Its own process group, like a server's, so stopping it reaches what npm or npx started
		const child = spawn(command, args, { cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		steps.add(child);
		child.on("close", () => steps.delete(child));
		let output = "";
		let stdout = "";
		child.stdout.on("data", (b: Buffer) => {
			output += b.toString();
			stdout += b.toString();
			if (echoStdout) process.stdout.write(b);
		});
		child.stderr.on("data", (b: Buffer) => {
			output += b.toString();
			process.stderr.write(b);
		});
		child.on("error", (e) => {
			output += String(e);
			done({ code: 127, output, stdout });
		});
		child.on("close", (code) => done({ code: code ?? 1, output, stdout }));
	});
}

const shown = (command: string, args: string[]) => [command === process.execPath ? "node" : command, ...args].join(" ");

async function step(label: string, command: string, args: string[], cwd: string, options: RunOptions = {}): Promise<{ output: string; stdout: string }> {
	currentStep = label;
	console.log(`\n== ${label}: ${shown(command, args)}`);
	const started = performance.now();
	const { code, output, stdout } = await run(command, args, cwd, options);
	timings.push({ step: label, seconds: (performance.now() - started) / 1000 });
	if (code !== 0) throw new Stopped(`${label} failed with exit code ${code}.`);
	return { output, stdout };
}

/**
 * Runs an emdash CLI command that prints JSON on stdout (its progress goes to stderr and is passed through).
 * Returns the exit code and the parsed JSON, or null when stdout held none. The caller judges the result.
 */
async function jsonStep(label: string, args: string[], cwd: string): Promise<{ code: number; json: Json | null; stdout: string }> {
	currentStep = label;
	console.log(`\n== ${label}: npx ${args.join(" ")}`);
	const started = performance.now();
	const { code, stdout } = await run("npx", args, cwd, { echoStdout: false });
	timings.push({ step: label, seconds: (performance.now() - started) / 1000 });
	return { code, json: parsed(stdout.trim()), stdout };
}

/** A server this script started. It leads its own process group, so stopping it reaches what it started too. */
export type Server = { child: ChildProcess; error: Error | null };

const servers = new Set<Server>();

/** Sends `signal` to the server's process group. False when the group is gone. */
function signalGroup(server: Server, signal: NodeJS.Signals | 0): boolean {
	const pid = server.child.pid;
	if (pid === undefined) return false;
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}

/** Starts a server in a process group of its own, with its output in `log`. */
export function startServer(command: string, args: string[], options: { cwd: string; log: string; env?: NodeJS.ProcessEnv }): Server {
	const fd = openSync(options.log, "w");
	try {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", fd, fd], detached: true });
		const server: Server = { child, error: null };
		child.on("error", (e) => {
			server.error = e;
		});
		servers.add(server);
		return server;
	} finally {
		closeSync(fd);
	}
}

const running = (server: Server) => server.error === null && server.child.exitCode === null && server.child.signalCode === null;

/** Stops a server and everything in its process group: SIGTERM, then SIGKILL for whatever is left after `graceMs`. */
export async function stopServer(server: Server, graceMs = 5000): Promise<void> {
	servers.delete(server);
	const gone = async (ms: number) => {
		const deadline = Date.now() + ms;
		while (signalGroup(server, 0)) {
			if (Date.now() > deadline) return false;
			await new Promise((r) => setTimeout(r, 50));
		}
		return true;
	};
	if (!signalGroup(server, "SIGTERM")) return;
	if (await gone(graceMs)) return;
	signalGroup(server, "SIGKILL");
	await gone(5000);
}

/** Stops every server and command still running, at once. For the exit paths that cannot wait. */
function killAll() {
	for (const server of servers) signalGroup(server, "SIGKILL");
	servers.clear();
	for (const child of steps) {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	steps.clear();
}

const hashOf = (file: string) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null);

async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	if ("error" in args) {
		console.error(args.error);
		return EXIT.usage;
	}
	const { name, cloudflare } = args;
	const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
	if (major < 22 || (major === 22 && minor < 22)) {
		console.error(`The generated project needs Node 22.22 or later (Astro 7.4). This is Node ${process.versions.node}.`);
		return EXIT.usage;
	}

	const siteRoot = join(here, "sites", name);
	const site = join(siteRoot, "site");
	const golden = join(siteRoot, "golden");
	const goldenJson = join(siteRoot, "golden.json");
	const work = join(root, "test", ".cache", "tsg-e2e", name);
	const outDir = join(root, "test", ".out");
	const reportFile = join(outDir, `tsg-e2e-${name}.md`);
	const serverLog = join(outDir, `tsg-e2e-${name}-server.log`);
	const rel = (p: string) => relative(root, p) || ".";
	const assetsDir = join(siteRoot, "assets");
	const imageIndex = join(siteRoot, "image-index.json");
	// The media come from sites/<site>/assets/ and no request may reach TakeShape

	if (!existsSync(join(site, "tsg.yml"))) {
		console.error(`No site at ${rel(site)} (it needs a tsg.yml).`);
		return EXIT.usage;
	}
	let exportDir = join(siteRoot, "export");
	if (!existsSync(exportDir)) {
		const fixture = join(root, "test", "fixtures", name);
		if (!existsSync(join(fixture, "schema.json"))) {
			console.error(`No export at ${rel(exportDir)}, and no fixture at ${rel(fixture)}.`);
			return EXIT.usage;
		}
		console.log(`${rel(exportDir)} does not exist yet, so the export is ${rel(fixture)}.`);
		exportDir = fixture;
	}
	let now = DEFAULT_NOW;
	if (existsSync(goldenJson)) {
		try {
			now = JSON.parse(readFileSync(goldenJson, "utf8")).now ?? DEFAULT_NOW;
		} catch (e) {
			throw new Error(`${rel(goldenJson)} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	const ports = cloudflare ? [PORT, PORTS.export, PORTS.import, PORTS.preview] : [PORT];
	for (const port of ports) if (await portInUse(port)) throw new Stopped(`Something already listens on port ${port}, which this run needs. Stop it and run again.`);

	if (!existsSync(assetsDir)) {
		console.error(`The e2e needs ${rel(assetsDir)}, the site's original files, since it makes no request to TakeShape.`);
		return EXIT.usage;
	}

	mkdirSync(work, { recursive: true });
	mkdirSync(outDir, { recursive: true });
	console.log(`Offline: media from ${rel(assetsDir)}, the golden's images made from them${existsSync(imageIndex) ? ` and checked against the entries in ${rel(imageIndex)}` : ""}. A request to a TakeShape host fails the run.`);

	/** Fails the run when any of the requests in `logFile` went to a TakeShape host. Prints the hosts. */
	const checkRequests = (label: string, logFile: string, allowed: (url: string) => boolean = () => false) => {
		const urls = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : [];
		const hosts = hostCounts(urls).map(([h, n]) => `${h} ${n}`).join(", ");
		console.log(`Requests by ${label}: ${urls.length}${hosts ? ` (${hosts})` : ""}, listed in ${rel(logFile)}.`);
		const leaked = takeshapeRequests(urls).filter((u) => !allowed(u));
		if (leaked.length) {
			const more = existsSync(imageIndex) ? ` A setting ${rel(imageIndex)} has no entry for makes the compare ask imgix. The site's SOURCE.md says how its entries were made.` : ` ${rel(imageIndex)} is missing, so the compare asks imgix for every setting. The site's SOURCE.md says how its entries were made.`;
			throw new Stopped(`${label} sent ${leaked.length} request${leaked.length === 1 ? "" : "s"} to TakeShape while running offline, for example ${leaked[0]}.${more}`);
		}
	};

	/** Starts a server and waits until / answers 200 on `port`. The port is checked again first. */
	const serve = async (label: string, command: string, args: string[], port: number, log: string, env?: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<Server> => {
		currentStep = label;
		if (await portInUse(port)) throw new Stopped(`${label}: something already listens on port ${port}. Stop it and run again.`);
		console.log(`\n== ${label}: ${shown(command, args)}  (port ${port}, output in ${rel(log)})`);
		const started = performance.now();
		const server = startServer(command, args, { cwd: work, log, env });
		const ready = await waitForServer(`http://localhost:${port}/`, () => running(server), timeoutMs);
		if (!ready.ok) throw new Stopped(`${label}: the server is not ready: ${server.error ? String(server.error) : ready.reason}. Its output is in ${rel(log)}.`);
		timings.push({ step: label, seconds: (performance.now() - started) / 1000 });
		return server;
	};

	const urlsFile = join(outDir, `tsg-e2e-${name}-urls.txt`);
	/** Compares the golden with `url`; returns the compare's exit code. */
	const compare = async (label: string, url: string, report: string, extra: string[] = []): Promise<number> => {
		currentStep = label;
		const urls = goldenUrls(golden);
		writeFileSync(urlsFile, `${urls.join("\n")}\n`);
		const started = performance.now();
		const fetchLog = report.replace(/\.md$/, "-fetches.txt");
		const indexArgs = existsSync(imageIndex) ? ["--image-index", rel(imageIndex)] : [];
		// The preload stored every original in the project, and the compare makes the old images from them
		indexArgs.push("--media", rel(work));
		const compareArgs = ["compare/compare-sites.mts", rel(golden), url, "--urls", rel(urlsFile), "--out", rel(report), "--fetch-log", rel(fetchLog), ...indexArgs, ...extra];
		console.log(`\n== ${label} (${urls.length} files in golden/): node ${compareArgs.map((a) => (/[\s\\[]/.test(a) ? `'${a}'` : a)).join(" ")}`);
		const compared = await run(process.execPath, compareArgs, root);
		timings.push({ step: label, seconds: (performance.now() - started) / 1000 });
		checkRequests(label, fetchLog);
		return compared.code;
	};
	const removeDatabase = () => {
		for (const f of ["data.db", "data.db-shm", "data.db-wal", "data.db-journal"]) rmSync(join(work, f), { force: true });
		rmSync(join(work, "uploads"), { recursive: true, force: true });
	};

	// 1. Content. The repo scripts run from emdash/, so paths are given relative to it.
	const takeshapeDir = join(work, "takeshape");
	const fieldMap = join(takeshapeDir, "takeshape-field-map.json");
	const convertArgs = ["ts2emdash.mts", rel(exportDir), "--site", rel(site), "--out", rel(join(takeshapeDir, "takeshape.seed.json")), "--report", rel(join(takeshapeDir, "content-report.md"))];
	// A clean preload: no database, uploads or ledger from an earlier run
	removeDatabase();
	rmSync(join(takeshapeDir, "takeshape-media.db"), { force: true });
	const preloadLog = join(outDir, `tsg-e2e-${name}-preload-fetches.txt`);
	writeFileSync(preloadLog, "");
	const converted = await step(
		"ts2emdash",
		process.execPath,
		["--import", pathToFileURL(join(root, "test", "fake-fetch.mts")).href, ...convertArgs, "--preload-media", "local", "--database", rel(join(work, "data.db")), "--uploads-dir", rel(join(work, "uploads"))],
		root,
		{ env: { ...process.env, FAKE_FETCH: "dir", FAKE_FETCH_DIR: assetsDir, FAKE_FETCH_LOG: preloadLog } },
	);
	const summary = preloadSummary(converted.output);
	if (!summary) throw new Stopped("ts2emdash printed no preload summary, so the media were not preloaded.");
	if (summary.failed) throw new Stopped(`ts2emdash could not preload ${summary.failed} of ${summary.entries} media files from ${rel(assetsDir)}. Its report lists them.`);
	timings[timings.length - 1]!.note = `preloaded ${summary.entries} media from ${rel(assetsDir)}`;
	// fake-fetch answers assets.takeshape.io from the folder; anything else it refused, and none may be tried
	checkRequests("the preload", preloadLog, (u) => hostOf(u) === "assets.takeshape.io");

	// 2. Templates
	await step("tsg2astro", process.execPath, ["tsg2astro/tsg2astro.mts", rel(site), "--export", rel(exportDir), "--field-map", rel(fieldMap), "--out", rel(work), "--site-url", SITE_URL], root);

	// 3. Install and seed
	const stampFile = join(work, "node_modules", ".tsg-e2e-install.json");
	const installState = () => ({ packageJson: hashOf(join(work, "package.json")), lockfile: hashOf(join(work, "package-lock.json")) });
	const stamp = existsSync(stampFile) ? readFileSync(stampFile, "utf8") : null;
	if (stamp && stamp === JSON.stringify(installState())) {
		console.log("\n== npm install: skipped, package.json and package-lock.json are unchanged since the last install");
		timings.push({ step: "npm install", seconds: 0, note: "skipped" });
	} else {
		await step("npm install", "npm", ["install", "--no-audit", "--no-fund"], work);
		writeFileSync(stampFile, JSON.stringify(installState()));
	}

	const seedOutput = (await step("seed", "npm", ["run", "takeshape:seed"], work)).output;
	const failed = mediaFailures(seedOutput);
	if (failed.length) throw new Stopped(`${failed.length} media file${failed.length === 1 ? " was" : "s were"} not stored, so pages would miss images. The preload missed a file, or an asset path in the export doesn't match assets/.`);
	const downloads = mediaDownloads(seedOutput);
	if (downloads.length) throw new Stopped(`seed downloaded ${downloads.length} media file${downloads.length === 1 ? "" : "s"} the preload should have stored, for example ${downloads[0]!.trim()}.`);
	const mediaLine = /Media: .*/.exec(seedOutput)?.[0];
	timings[timings.length - 1]!.note = `${downloads.length} downloads${mediaLine ? `, ${mediaLine}` : ""}`;

	// 4. Build and serve
	await step("build:node", "npm", ["run", "build:node"], work);
	const startScript = (JSON.parse(readFileSync(join(work, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts?.["start:node"] ?? "";
	const nodeServer = await serve(
		"server",
		process.execPath,
		nodeServerArgs(startScript, pathToFileURL(join(here, "fixed-clock.mts")).href),
		PORT,
		serverLog,
		{ ...process.env, PORT: String(PORT), TSG_FIXED_NOW: now },
	);
	console.log(`Serving on ${SITE_URL} under the fixed clock ${now}.`);

	// 5. Compare
	const hasGolden = existsSync(golden);
	const skipped = `Compare skipped: ${rel(golden)} is missing. Build it with npm run test:tsg-golden -- ${name}.`;
	const codes: { label: string; code: number; report: string }[] = [];
	if (hasGolden) codes.push({ label: "Node mode", code: await compare("compare", SITE_URL, reportFile), report: reportFile });
	else console.log(`\n${skipped}`);
	await stopServer(nodeServer);
	if (!cloudflare && !hasGolden) return EXIT.notCompared;

	if (cloudflare) {
		// 6. Export the Node-mode site through a dev server: only dev lets localhost in without a token
		const packageFile = join(work, "site.emdash");
		const exportServer = await serve("export server", "npx", ["astro", "dev", "--config", "astro.node.config.mjs", "--port", String(PORTS.export), "--ignore-lock"], PORTS.export, join(outDir, `tsg-e2e-${name}-export-server.log`), undefined, 120_000);
		currentStep = "site export";
		rmSync(packageFile, { force: true });
		const exported = await jsonStep("site export", ["emdash", "site", "export", "--url", `http://localhost:${PORTS.export}`, "--output", packageFile, "--json"], work);
		const exportError = exported.json ? cliError(exported.json) : `its output is not JSON: ${exported.stdout.trim().slice(0, 200) || "(empty)"}`;
		if (exported.code !== 0 || exportError || !existsSync(packageFile)) {
			throw new Stopped(`site export failed (exit ${exported.code})${exportError ? `: ${exportError}` : ""}. Its server's output is in ${rel(join(outDir, `tsg-e2e-${name}-export-server.log`))}.`);
		}
		const e = exported.json!;
		timings[timings.length - 1]!.note = `${String(e.files)} files, ${(Number(e.bytes) / 1024 / 1024).toFixed(1)} MiB`;
		console.log(`Exported ${rel(packageFile)}: ${timings[timings.length - 1]!.note}, ${String(e.packageDigest)}.`);
		await stopServer(exportServer);

		// 7. Empty local D1 and R2
		currentStep = "reset local D1 and R2";
		rmSync(join(work, ".wrangler", "state"), { recursive: true, force: true });
		console.log("\n== Deleted .wrangler/state, so local D1 and R2 start empty");

		// 8. Import on workerd
		const importLog = join(outDir, `tsg-e2e-${name}-import-server.log`);
		const importServer = await serve("import server", "npx", ["astro", "dev", "--port", String(PORTS.import), "--ignore-lock"], PORTS.import, importLog, undefined, 120_000);
		const importUrl = `http://localhost:${PORTS.import}`;
		const analyze = await jsonStep("import analyze", ["emdash", "site", "import", packageFile, "--url", importUrl, "--analyze", "--json"], work);
		const planned = planDigestOf(analyze.stdout);
		if ("error" in planned) throw new Stopped(`import analyze (exit ${analyze.code}): ${planned.error}. Its server's output is in ${rel(importLog)}.`);
		if (analyze.code !== 0) throw new Stopped(`import analyze failed with exit code ${analyze.code}. Its server's output is in ${rel(importLog)}.`);
		const plan = (analyze.json?.plan ?? {}) as { counts?: Record<string, number>; transformations?: { code: string; count?: number }[]; warnings?: Issue[] };
		const counts = (c: Record<string, number> = {}) => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ");
		const planNote = `${plan.transformations?.length ? plan.transformations.map((t) => `${t.code}${t.count !== undefined ? ` x${t.count}` : ""}`).join(", ") : "no transformations"}, ${plan.warnings?.length ?? 0} warnings, 0 blockers`;
		timings[timings.length - 1]!.note = planNote;
		console.log(`Plan ${planned.digest}: ${counts(plan.counts)}`);
		console.log(`  ${planNote}${plan.warnings?.length ? `: ${issueList(plan.warnings)}` : ""}`);
		const confirmed = await jsonStep("import", ["emdash", "site", "import", packageFile, "--url", importUrl, "--plan", planned.digest, "--confirm", "--json"], work);
		const verified = receiptCheck(confirmed.stdout);
		if (!verified.ok) throw new Stopped(`import (exit ${confirmed.code}): ${verified.reason}. Its server's output is in ${rel(importLog)}.`);
		if (confirmed.code !== 0) throw new Stopped(`import failed with exit code ${confirmed.code}. Its server's output is in ${rel(importLog)}.`);
		timings[timings.length - 1]!.note = `complete, verified${verified.warnings.length ? `, ${verified.warnings.length} warnings` : ""}`;
		console.log(`Import complete and verified: ${counts(verified.counts)}${verified.warnings.length ? `. Warnings: ${issueList(verified.warnings)}` : ""}`);
		await stopServer(importServer);

		// 9. Build for Workers and preview it
		const previewUrl = `http://localhost:${PORTS.preview}`;
		// The build reads .env, and the adapter copies it into dist/server/.dev.vars for the preview's worker
		const envFile = join(work, ".env");
		writeFileSync(envFile, withSiteUrl(existsSync(envFile) ? readFileSync(envFile, "utf8") : null, previewUrl));
		await step("build", "npm", ["run", "build"], work, { env: { ...process.env, EMDASH_SITE_URL: previewUrl } });
		const devVars = join(work, "dist", "server", ".dev.vars");
		const runtimeUrl = existsSync(devVars) ? devVarsSiteUrl(readFileSync(devVars, "utf8")) : null;
		if (runtimeUrl !== previewUrl) throw new Stopped(`build: ${rel(devVars)} gives the preview EMDASH_SITE_URL ${runtimeUrl ?? "(none)"}, the build used ${previewUrl}.`);
		timings[timings.length - 1]!.note = `EMDASH_SITE_URL ${previewUrl} in the build and .dev.vars`;
		const previewServer = await serve("preview server", "npx", ["astro", "preview", "--port", String(PORTS.preview), "--ignore-lock"], PORTS.preview, join(outDir, `tsg-e2e-${name}-preview-server.log`), undefined, 120_000);
		console.log(`Serving the Workers build on ${previewUrl}.`);

		// 10. Compare
		if (!hasGolden) {
			console.log(`\n${skipped}`);
			await stopServer(previewServer);
			return EXIT.notCompared;
		}
		const cfReport = join(outDir, `tsg-e2e-${name}-cloudflare.md`);
		codes.push({ label: "Cloudflare", code: await compare("compare cloudflare", previewUrl, cfReport, ["--ignore-text", CLOUDFLARE_IGNORE_TEXT]), report: cfReport });
		await stopServer(previewServer);
	}

	if (codes.length > 1) {
		console.log("\nCompares:");
		for (const c of codes) console.log(`  ${c.label.padEnd(10)} ${c.code === 0 ? "no differences" : c.code === 1 ? "differences" : `could not run (exit ${c.code})`}, ${rel(c.report)}`);
	}
	const all = codes.map((c) => c.code);
	return all.includes(2) ? 2 : all.includes(1) ? 1 : (all.find((c) => c !== 0) ?? 0);
}

if (import.meta.main) {
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			killAll();
			process.exit(130);
		});
	}
	process.on("exit", killAll);
	let code: number;
	try {
		code = await main(process.argv.slice(2));
	} catch (e) {
		if (e instanceof Stopped) console.error(`\n${e.message}`);
		else console.error(`\nThe run stopped on an unexpected error during ${currentStep}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
		code = EXIT.stopped;
	}
	await Promise.all([...servers].map((s) => stopServer(s)));
	printTimings();
	process.exit(code);
}
