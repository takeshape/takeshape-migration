/**
 * runtime/html-compression.ts against minimize 2.2.0 itself, the package and version takeshape-ssg ran over every
 * page when tsg.yml turned htmlCompression on.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { compressHtml, compressResponse } from "../../tsg2astro/runtime/html-compression.ts";

const require = createRequire(import.meta.url);
const Minimize = require("minimize") as new (options: Record<string, unknown>) => { parse(html: string): string };

// The markup a site's pages differed on: a comment, quoted attributes, whitespace in <noscript> and JSON-LD
const page = `<!DOCTYPE html>
<html><head>
  <!-- Page styles -->
  <link rel="stylesheet" href="/css/site.css">
</head>
<body class="page-home">
  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=X" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
  <p>  Hello   <b>world</b> </p>
<script type="application/ld+json">
{
  "@context": "http://schema.org"
}
</script></body></html>`;

test("compresses as minimize 2.2.0 does with the same options", async () => {
	const options = { loose: true, comments: true };
	assert.equal(await compressHtml(page, options), new Minimize(options).parse(page));
	assert.match(await compressHtml(page, options), /<!--Page styles--> <link rel=stylesheet href=\/css\/site\.css>/);
});

test("other options give other output, as they did on TakeShape", async () => {
	assert.equal(await compressHtml(page, { loose: true }), new Minimize({ loose: true }).parse(page));
	assert.doesNotMatch(await compressHtml(page, { loose: true }), /Page styles/);
});

// The middleware's step: HTML pages only, EmDash's own and bodyless answers as they are. A 304 with text/html came
// back through `new Response("", { status: 304 })`, which throws, so cache revalidation answered 500.
test("compressResponse leaves bodyless answers and EmDash's own pages alone", async () => {
	const html = (status: number, body: string | null) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "content-length": "10" } });
	const notModified = html(304, null);
	assert.equal(await compressResponse(notModified, "/about/", { loose: true }), notModified);
	const noContent = html(204, null);
	assert.equal(await compressResponse(noContent, "/about/", { loose: true }), noContent);
	const admin = html(200, page);
	assert.equal(await compressResponse(admin, "/_emdash/admin", { loose: true }), admin);
	const off = html(200, page);
	assert.equal(await compressResponse(off, "/about/", null), off);
	const compressed = await compressResponse(html(200, page), "/about/", { loose: true });
	assert.equal(await compressed.text(), new Minimize({ loose: true }).parse(page));
	assert.equal(compressed.headers.get("content-length"), null);
	assert.equal(compressed.status, 200);
});

// Vite's dependency optimizer on workerd (astro dev with the Cloudflare config, where the site import runs) could not
// resolve htmlparser2 3.x's require("../"), which minimize 2.2.0 loads, so the dev server stopped before it started
test("the Vite plugin points htmlparser2's require of its package root at lib/index.js", async () => {
	const file = new URL("../../tsg2astro/scaffold/takeshape-vite.mjs", import.meta.url).href;
	const { htmlparser2Root } = (await import(file)) as { htmlparser2Root: () => { resolveId(source: string, importer?: string): string | null } };
	const stream = require.resolve("htmlparser2/lib/Stream.js", { paths: [dirname(require.resolve("minimize"))] });
	const resolved = htmlparser2Root().resolveId("../", stream);
	assert.equal(resolved, join(dirname(stream), "index.js"));
	assert.ok(existsSync(resolved!));
	assert.equal(htmlparser2Root().resolveId("../", "/x/other/lib/a.js"), null);
	assert.equal(htmlparser2Root().resolveId("./x", stream), null);
});
