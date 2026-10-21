import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./build-golden.mts", import.meta.url));

function run(...args: string[]) {
	const env: NodeJS.ProcessEnv = { ...process.env, TAKESHAPE_CLI: process.execPath };
	delete env.TS_PROJECT_ID;
	delete env.TS_API_KEY;
	const r = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("a bare site name is parsed (no usage message)", () => {
	const r = run("no-such-site-for-smoke-test");
	assert.equal(r.status, 2);
	assert.match(r.out, /No site at/);
	assert.doesNotMatch(r.out, /Usage/);
});

test("no credentials and no cache names both env vars", () => {
	const dir = mkdtempSync(join(tmpdir(), "bg-smoke-"));
	try {
		writeFileSync(join(dir, "tsg.yml"), "templatePath: t\n");
		const r = run("smoke-no-cache", "--site-dir", dir);
		assert.equal(r.status, 2);
		assert.match(r.out, /TS_PROJECT_ID and TS_API_KEY/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a malformed .takeshaperc stops the build without quoting the file", () => {
	const dir = mkdtempSync(join(tmpdir(), "bg-rc-"));
	try {
		writeFileSync(join(dir, "tsg.yml"), "templatePath: t\n");
		writeFileSync(join(dir, ".takeshaperc"), '{"projectId":"p1","linkedApiKey":{"apiKey":"FAKE-KEY-0000"}} trailing');
		const r = run("smoke-bad-rc", "--site-dir", dir);
		assert.equal(r.status, 2);
		assert.match(r.out, /\.takeshaperc is not valid JSON/);
		assert.doesNotMatch(r.out, /FAKE-KEY|projectId|trailing/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("site names are validated and the name is required", () => {
	assert.equal(run("..").status, 2);
	assert.match(run("a/b").out, /Invalid site name/);
	assert.match(run().out, /Usage/);
});
