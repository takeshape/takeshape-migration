/**
 * fake-fetch.mts in dir mode: assets.takeshape.io answers from a folder laid out the way --download-assets
 * writes it, and every other host fails loudly.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fakeFetch = pathToFileURL(join(here, "fake-fetch.mts")).href;
const tmp = mkdtempSync(join(tmpdir(), "fake-fetch-dir-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Runs `script` with fetch replaced in dir mode and returns what it printed as JSON, plus stderr
function withDir(script: string, env: Record<string, string> = {}) {
	const res = spawnSync(process.execPath, ["--no-warnings", "--import", fakeFetch, "--input-type=module", "-e", script], {
		encoding: "utf8",
		env: { ...process.env, FAKE_FETCH: "dir", FAKE_FETCH_DIR: join(tmp, "assets"), ...env },
	});
	assert.equal(res.status, 0, res.stderr);
	return { out: JSON.parse(res.stdout), stderr: res.stderr };
}

const answer = `async (url) => {
	try {
		const r = await fetch(url);
		const body = new Uint8Array(await r.arrayBuffer());
		return { status: r.status, type: r.headers.get("content-type"), length: r.headers.get("content-length"), bytes: body.length, first: body[0] ?? null };
	} catch (e) {
		return { error: e.message };
	}
}`;

test("dir mode: assets.takeshape.io answers from the folder, by URL path", () => {
	const project = "00000006-0000-4000-8000-000000000006/dev";
	const files = {
		[`${project}/aaa/4 pexels-photo copy.jpeg`]: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]),
		[`${project}/bbb/800px-De_Alice's_Abenteuer.png`]: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]),
		[`${project}/ccc/manual.pdf`]: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
		[`${project}/ddd/notes.xyz`]: new Uint8Array([7]),
	};
	for (const [path, bytes] of Object.entries(files)) {
		mkdirSync(dirname(join(tmp, "assets", path)), { recursive: true });
		writeFileSync(join(tmp, "assets", path), bytes);
	}
	const log = join(tmp, "fetch.log");
	const urls = [
		// What ts2emdash asks for: each segment through encodeURIComponent, so the space is %20 and ' stays
		`https://assets.takeshape.io/${project}/aaa/4%20pexels-photo%20copy.jpeg`,
		`https://assets.takeshape.io/${project}/bbb/800px-De_Alice's_Abenteuer.png`,
		`https://assets.takeshape.io/${project}/bbb/800px-De_Alice%27s_Abenteuer.png`,
		`https://assets.takeshape.io/${project}/ccc/manual.pdf`,
		`https://assets.takeshape.io/${project}/ddd/notes.xyz`,
		`https://assets.takeshape.io/${project}/zzz/missing.png`,
		`https://assets.takeshape.io/${project}/../../../etc/passwd`,
		`https://assets.takeshape.io/${project}/..%2F..%2F..%2Fetc%2Fpasswd`,
	];
	const { out } = withDir(`const answer = ${answer}; console.log(JSON.stringify(await Promise.all(${JSON.stringify(urls)}.map(answer))));`, { FAKE_FETCH_LOG: log });
	assert.deepEqual(out, [
		{ status: 200, type: "image/jpeg", length: "6", bytes: 6, first: 0xff },
		{ status: 200, type: "image/png", length: "5", bytes: 5, first: 0x89 },
		{ status: 200, type: "image/png", length: "5", bytes: 5, first: 0x89 },
		{ status: 200, type: "application/pdf", length: "4", bytes: 4, first: 0x25 },
		{ status: 200, type: "application/octet-stream", length: "1", bytes: 1, first: 7 },
		{ status: 404, type: null, length: null, bytes: 0, first: null },
		{ status: 404, type: null, length: null, bytes: 0, first: null },
		{ status: 404, type: null, length: null, bytes: 0, first: null },
	]);
	assert.equal(readFileSync(log, "utf8").trim().split("\n").length, urls.length);
});

test("dir mode: any other host fails loudly", () => {
	const urls = ["https://images.takeshape.io/x/y.png", "https://api.takeshape.io/project/x/graphql", "https://example.com/a.png"];
	const { out, stderr } = withDir(`const answer = ${answer}; console.log(JSON.stringify(await Promise.all(${JSON.stringify(urls)}.map(answer))));`);
	for (const [i, r] of out.entries()) assert.match(String(r.error), new RegExp(`fake-fetch: refused ${urls[i]!.replace(/[.?]/g, "\\$&")}`));
	for (const u of urls) assert.ok(stderr.includes(`fake-fetch: refused ${u}`), stderr);
});

test("dir mode needs FAKE_FETCH_DIR to be a folder", () => {
	const res = spawnSync(process.execPath, ["--no-warnings", "--import", fakeFetch, "-e", "0"], {
		encoding: "utf8",
		env: { ...process.env, FAKE_FETCH: "dir", FAKE_FETCH_DIR: join(tmp, "nope") },
	});
	assert.notEqual(res.status, 0);
	assert.match(res.stderr, /FAKE_FETCH_DIR/);
});
