/**
 * The parts of the end-to-end script (test/tsg/e2e.mts) that can be checked without a full run: what counts as a
 * failed media download, when the server counts as ready, the exit code of an unexpected error, and for
 * --cloudflare the arguments, the port check, stopping a server with what it started, and reading the site
 * import's plan and receipt.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { packageJson } from "../../tsg2astro/scaffold.mts";
import { devVarsSiteUrl, goldenUrls, hostCounts, mediaDownloads, mediaFailures, nodeServerArgs, parseArgs, planDigestOf, portInUse, preloadSummary, receiptCheck, startServer, stopServer, takeshapeRequests, waitForServer } from "./e2e.mts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

test("seed output: every way EmDash reports a missing file counts", () => {
	const output = [
		"  📥 Downloading: https://assets.takeshape.io/a.png",
		"  ✅ Uploaded: a.png",
		"  ⚠️ Failed to download https://assets.takeshape.io/b.png: 404",
		"  ⚠️ Error processing $media https://assets.takeshape.io/c.png: socket hang up",
		"Skipping $media reference (no storage configured): https://assets.takeshape.io/d.png",
		"ℹ Media: 1 created, 3 skipped",
	].join("\n");
	assert.deepEqual(mediaFailures(output).map((l) => l.trim().slice(0, 12)), ["⚠️ Failed to", "⚠️ Error pro", "Skipping $me"]);
	assert.deepEqual(mediaFailures("  ✅ Uploaded: a.png\nℹ Media: 1 created, 0 skipped"), []);
});

test("the server is ready only when / answers 200", async () => {
	let status = 503;
	const server = createServer((_req, res) => {
		res.statusCode = status;
		res.end("x");
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	try {
		const failed = await waitForServer(url, () => true, 2000);
		assert.equal(failed.ok, false);
		assert.match(failed.ok ? "" : failed.reason, /503/);
		status = 200;
		assert.deepEqual(await waitForServer(url, () => true, 2000), { ok: true });
	} finally {
		await new Promise((done) => server.close(done));
	}
	// Nothing listening, and the server process gone: no wait for the deadline
	const started = Date.now();
	const gone = await waitForServer(url, () => false, 60_000);
	assert.equal(gone.ok, false);
	assert.ok(Date.now() - started < 10_000);
});

test("every file of the golden build is a URL to compare, index.html as its folder", () => {
	const golden = join(here, "sites", `e2e-golden-${process.pid}`);
	try {
		for (const f of ["index.html", "robots.txt", "favicon.ico", "blog/index.html", "blog/page-2/index.html", "stylesheets/base.css", "about.html"]) {
			mkdirSync(dirname(join(golden, f)), { recursive: true });
			writeFileSync(join(golden, f), "x");
		}
		assert.deepEqual(goldenUrls(golden), ["/", "/about.html", "/blog/", "/blog/page-2/", "/favicon.ico", "/robots.txt", "/stylesheets/base.css"]);
	} finally {
		rmSync(golden, { recursive: true, force: true });
	}
});

const site = join(here, "sites", `e2e-test-${process.pid}`);
after(() => rmSync(site, { recursive: true, force: true }));

test("an unexpected error exits 4, not 1", { skip: Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1]) < 22 ? "the script needs Node 22.22" : false }, () => {
	mkdirSync(join(site, "site"), { recursive: true });
	mkdirSync(join(site, "export"), { recursive: true });
	writeFileSync(join(site, "site", "tsg.yml"), "routes: {}\n");
	writeFileSync(join(site, "golden.json"), "{ not json");
	const res = spawnSync(process.execPath, ["test/tsg/e2e.mts", `e2e-test-${process.pid}`], { cwd: root, encoding: "utf8" });
	assert.equal(res.status, 4, res.stdout + res.stderr);
	assert.match(res.stderr, /golden\.json/);
});

test("arguments: a site name, and --cloudflare for the Workers run", () => {
	assert.deepEqual(parseArgs(["shape-books"]), { name: "shape-books", cloudflare: false });
	assert.deepEqual(parseArgs(["--cloudflare", "shape-books"]), { name: "shape-books", cloudflare: true });
	assert.deepEqual(parseArgs(["shape-books", "--cloudflare"]), { name: "shape-books", cloudflare: true });
	assert.match(String((parseArgs(["shape-books", "--live-media"]) as { error: string }).error), /--live-media/);
	assert.match(String((parseArgs(["shape-books", "--cloudfare"]) as { error: string }).error), /--cloudfare/);
	assert.match(String((parseArgs([]) as { error: string }).error), /Usage/);
	assert.match(String((parseArgs(["a", "b"]) as { error: string }).error), /one site/);
	assert.match(String((parseArgs([".."]) as { error: string }).error), /Usage/);
});

const DIGEST = `sha256:${"ab".repeat(32)}`;
const plan = (over: Record<string, unknown> = {}) =>
	JSON.stringify({ operationId: "op", state: "planned", planDigest: DIGEST, executable: true, plan: { blockers: [], warnings: [], transformations: [], counts: { entry: 15 } }, ...over });

test("site import plan: its digest, or why it cannot run", () => {
	assert.deepEqual(planDigestOf(plan()), { digest: DIGEST });
	// The bare hex form gets its prefix
	assert.deepEqual(planDigestOf(plan({ planDigest: "ab".repeat(32) })), { digest: DIGEST });
	const blocked = planDigestOf(plan({ executable: false, plan: { blockers: [{ code: "TRANSFER_TARGET_NOT_EMPTY", message: "The site has content" }], warnings: [] } }));
	assert.match("error" in blocked ? blocked.error : "", /TRANSFER_TARGET_NOT_EMPTY: The site has content/);
	const failed = planDigestOf(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Token required" } }));
	assert.match("error" in failed ? failed.error : "", /UNAUTHORIZED: Token required/);
	assert.match(String((planDigestOf("Exported 3 files") as { error: string }).error), /not JSON/);
	assert.match(String((planDigestOf(plan({ planDigest: "md5:x" })) as { error: string }).error), /plan digest/);
});

const receipt = (over: Record<string, unknown> = {}, receiptOver: Record<string, unknown> = {}) =>
	JSON.stringify({ operationId: "op", state: "complete", receipt: { counts: { entry: 15, media: 19 }, warnings: [], verification: "verified", ...receiptOver }, receiptDigestValid: true, ...over });

test("site import receipt: complete, verified, with a valid digest", () => {
	assert.deepEqual(receiptCheck(receipt()), { ok: true, counts: { entry: 15, media: 19 }, warnings: [] });
	assert.match(String((receiptCheck(receipt({}, { verification: "unverified" })) as { reason: string }).reason), /verification is unverified/);
	assert.match(String((receiptCheck(receipt({ receiptDigestValid: false })) as { reason: string }).reason), /receipt digest/);
	assert.match(String((receiptCheck(JSON.stringify({ operationId: "op", state: "failed", operation: { errorCode: "VERIFY_FAILED" } })) as { reason: string }).reason), /failed.*VERIFY_FAILED/);
	assert.match(String((receiptCheck(JSON.stringify({ error: { code: "X", message: "boom" } })) as { reason: string }).reason), /X: boom/);
	assert.match(String((receiptCheck("") as { reason: string }).reason), /not JSON/);
});

test("a port is in use when anything listens on it, HTTP or not", async () => {
	const server = createTcpServer((socket) => socket.end());
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as AddressInfo).port;
	try {
		assert.equal(await portInUse(port), true);
	} finally {
		await new Promise((done) => server.close(done));
	}
	assert.equal(await portInUse(port), false);
});

test("stopping a server stops everything it started, even what ignores SIGTERM", async () => {
	const dir = join(tmpdir(), `e2e-group-${process.pid}`);
	mkdirSync(dir, { recursive: true });
	const pidFile = join(dir, "grandchild.pid");
	// The server starts a grandchild that ignores SIGTERM, as a stuck workerd might, and writes its pid
	const grandchild = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
	const parent = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
		require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
	try {
		const server = startServer(process.execPath, ["-e", parent], { cwd: dir, log: join(dir, "server.log") });
		const deadline = Date.now() + 10_000;
		let pid = 0;
		while (!pid && Date.now() < deadline) {
			try {
				pid = Number(readFileSync(pidFile, "utf8"));
			} catch {
				await new Promise((r) => setTimeout(r, 50));
			}
		}
		assert.ok(pid > 0, "the grandchild started");
		await new Promise((r) => setTimeout(r, 200));
		await stopServer(server, 500);
		const alive = (p: number) => {
			try {
				process.kill(p, 0);
				return true;
			} catch {
				return false;
			}
		};
		assert.equal(alive(pid), false, "the grandchild is gone");
		assert.equal(alive(server.child.pid!), false, "the server is gone");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const nodeOk = !(Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1]) < 22);

test("an unknown flag exits 2", { skip: nodeOk ? false : "the script needs Node 22.22" }, () => {
	const res = spawnSync(process.execPath, ["test/tsg/e2e.mts", "shape-books", "--cloudfare"], { cwd: root, encoding: "utf8" });
	assert.equal(res.status, 2, res.stdout + res.stderr);
	assert.match(res.stderr, /--cloudfare/);
});

const busySite = join(here, "sites", `e2e-ports-${process.pid}`);
after(() => rmSync(busySite, { recursive: true, force: true }));

test("--cloudflare checks all its ports first: a busy one exits 4 before any work", { skip: nodeOk ? false : "the script needs Node 22.22" }, async () => {
	mkdirSync(join(busySite, "site"), { recursive: true });
	mkdirSync(join(busySite, "export"), { recursive: true });
	writeFileSync(join(busySite, "site", "tsg.yml"), "routes: {}\n");
	const server = createTcpServer((socket) => socket.end());
	const listening = await new Promise<boolean>((done) => {
		server.once("error", () => done(false));
		server.listen(4513, "127.0.0.1", () => done(true));
	});
	try {
		const { spawn } = await import("node:child_process");
		const child = spawn(process.execPath, ["test/tsg/e2e.mts", `e2e-ports-${process.pid}`, "--cloudflare"], { cwd: root });
		let out = "";
		child.stdout.on("data", (b: Buffer) => (out += b.toString()));
		child.stderr.on("data", (b: Buffer) => (out += b.toString()));
		const code = await new Promise<number | null>((done) => child.on("close", done));
		assert.equal(code, 4, out);
		// Whatever held the port (this test's server, or something else already on it), the message names it
		assert.match(out, /port 4513/);
		assert.doesNotMatch(out, /== ts2emdash/);
	} finally {
		if (listening) await new Promise((done) => server.close(done));
	}
});

test("offline: the preload's summary line, and how many files emdash seed downloaded", () => {
	assert.deepEqual(preloadSummary("x\n✔ Preloaded 19 images and files into ../work/uploads (19 downloaded, 0 already there, 0 failed)\n✔ Wrote seed"), {
		entries: 19,
		downloaded: 19,
		present: 0,
		failed: 0,
	});
	assert.equal(preloadSummary("✔ Wrote seed.json"), null);
	const seed = ["  📥 Downloading: https://assets.takeshape.io/a.png", "  ✅ Uploaded: a.png", "ℹ Media: 1 created, 0 skipped"].join("\n");
	assert.deepEqual(mediaDownloads(seed), ["  📥 Downloading: https://assets.takeshape.io/a.png"]);
	assert.deepEqual(mediaDownloads("ℹ Media: 0 created, 0 skipped"), []);
});

test("offline: any request to a TakeShape host counts, whatever the subdomain", () => {
	const urls = [
		"http://127.0.0.1:5000/",
		"http://localhost:4513/_emdash/api/media/file/a.png",
		"https://images.takeshape.io/p/dev/a.png?auto=compress%2Cformat",
		"https://api.takeshape.io/project/x/graphql",
		"https://www.takeshape.io/",
		"https://takeshape.io.example.com/x",
		"https://nottakeshape.io/x",
		"not a url",
	];
	assert.deepEqual(takeshapeRequests(urls), [urls[2], urls[3], urls[4]]);
	assert.deepEqual(hostCounts(urls), [
		["127.0.0.1:5000", 1],
		["api.takeshape.io", 1],
		["images.takeshape.io", 1],
		["localhost:4513", 1],
		["nottakeshape.io", 1],
		["takeshape.io.example.com", 1],
		["www.takeshape.io", 1],
	]);
});

test("the site URL the Workers build gave the preview, from dist/server/.dev.vars", () => {
	assert.equal(devVarsSiteUrl("EMDASH_SITE_URL='http://localhost:4513'\n"), "http://localhost:4513");
	assert.equal(devVarsSiteUrl('A=1\nEMDASH_SITE_URL="http://localhost:4513"\n'), "http://localhost:4513");
	assert.equal(devVarsSiteUrl("EMDASH_SITE_URL=http://localhost:4513"), "http://localhost:4513");
	assert.equal(devVarsSiteUrl("OTHER=1\n"), null);
});

test("the Node server starts as npm run start:node does, .env included, under the fixed clock", () => {
	const script = (JSON.parse(packageJson("site")) as { scripts: Record<string, string> }).scripts["start:node"]!;
	assert.deepEqual(nodeServerArgs(script, "file:///clock.mts"), ["--import", "file:///clock.mts", "--env-file-if-exists=.env", "dist-node/server/entry.mjs"]);
	assert.throws(() => nodeServerArgs("astro preview", "file:///clock.mts"), /start:node/);
	assert.throws(() => nodeServerArgs("node", "file:///clock.mts"), /start:node/);
});
