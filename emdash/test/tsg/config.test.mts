import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadTsgConfig } from "../../tsg2astro/config.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const work = mkdtempSync(join(tmpdir(), "tsg-config-"));
after(() => rmSync(work, { recursive: true, force: true }));

function site(name: string, yml: string): string {
	const dir = join(work, name);
	rmSync(dir, { recursive: true, force: true });
	writeFileSync(join(work, `${name}.yml`), yml);
	return join(work, `${name}.yml`);
}

test("config-defaults", async () => {
	const c = await loadTsgConfig(site("empty", ""), {});
	assert.equal(c.templatePath, "templates");
	assert.equal(c.staticPath, "static");
	assert.equal(c.buildPath, "build");
	assert.equal(c.locale, "en-us");
	assert.deepEqual(c.dates, { tz: "America/New_York", format: "LLL" });
	assert.deepEqual(c.numbers, { format: "," });
	assert.equal(c.imageBaseUrl, "https://images.takeshape.io");
	assert.equal(c.assetBaseUrl, "https://assets.takeshape.io");
	assert.deepEqual(c.imageDefaults, { auto: "compress,format" });
	assert.equal(c.pathPrefix, "");
});

test("image-defaults-merge", async () => {
	const c = await loadTsgConfig(site("imgs", "imageDefaults: {}\n"), {});
	assert.deepEqual(c.imageDefaults, { auto: "compress,format" });
});

test("env-interpolation", async () => {
	const file = site("env", "pathPrefix: ${env.FOO}\n");
	assert.equal((await loadTsgConfig(file, { FOO: "bar" })).pathPrefix, "bar");
	const missing = site("env2", "pathPrefix: ${env.MISSING}\n");
	await assert.rejects(loadTsgConfig(missing, {}), /env\.MISSING/);
});

test("route-order", async () => {
	const c = await loadTsgConfig(join(root, "test/tsg/sites/shape-books/site"), {});
	assert.deepEqual(Object.keys(c.routes), ["sitemap", "homepage", "posts", "books", "authors"]);
});
