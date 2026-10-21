// compare-sites --media: the old site's TakeShape images are made from the preload's originals, imgix is asked once
// per setting (the rules check), and what imgix answered is written back to --image-index. Offline: a stub stands in
// for fetch on TakeShape's hosts, in this process or, for the CLI, through --import.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import sharp from "sharp";
import { compareDetailed, serveDir } from "../../compare/compare-sites.mts";
import type { CompareOptions } from "../../compare/compare-sites.mts";
import { HASH_VERSION, hashHex, imageOf } from "../../compare/images.mts";
import type { IndexedImage } from "../../compare/images.mts";
import { IMGIX_ACCEPT } from "../../compare/old-images.mts";
import { openMedia } from "../../compare/originals.mts";
import { imagePlan } from "../../tsg2astro/runtime/imgix.ts";
import { sharpTransform } from "../../tsg2astro/runtime/image-sharp.ts";

const CLI = fileURLToPath(new URL("../../compare/compare-sites.mts", import.meta.url));
const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string) => {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
};

/** A photo-like PNG: a gradient and two blocks, so its hash has something to read. */
const photo = async (width: number, height: number, tint = "#c63") =>
	sharp({ create: { width, height, channels: 3, background: "#2a6" } })
		.composite([
			{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect x="10%" y="20%" width="30%" height="40%" fill="${tint}"/><rect x="60%" y="50%" width="25%" height="30%" fill="#36c"/></svg>`) },
		])
		.png()
		.toBuffer();

/** A project folder whose preload ledger holds each asset path (on assets.takeshape.io) and its file in uploads/. */
function mediaProject(originals: Record<string, Buffer>): string {
	const dir = temp("compare-media-");
	mkdirSync(join(dir, "takeshape"));
	mkdirSync(join(dir, "uploads"));
	const db = new DatabaseSync(join(dir, "takeshape", "takeshape-media.db"));
	db.exec("CREATE TABLE takeshape_media_sources (source_key text primary key, source_url text not null, source_size integer, source_etag text, media_id text not null, storage_key text not null, updated_at text not null)");
	const insert = db.prepare("INSERT INTO takeshape_media_sources VALUES (?, ?, ?, ?, ?, ?, ?)");
	Object.entries(originals).forEach(([path, bytes], i) => {
		const key = `ts-${i}${path.slice(path.lastIndexOf("."))}`;
		insert.run(`k${i}`, `https://assets.takeshape.io/${path.split("/").map(encodeURIComponent).join("/")}`, bytes.length, null, `m${i}`, key, "2026-10-20T00:00:00.000Z");
		writeFileSync(join(dir, "uploads", key), bytes);
	});
	db.close();
	return dir;
}

/** The new site's copy of an old imgix URL: the original through the endpoint's plan, as the site serves it. */
async function endpointCopy(query: string, original: Buffer): Promise<Buffer> {
	const plan = imagePlan(new URLSearchParams(query));
	assert.ok(plan);
	return Buffer.from((await sharpTransform(new Uint8Array(original), plan)).body);
}

/** Two folders, old/ and new/, written from `files` (path to HTML text or bytes), served on localhost. */
async function sites(oldFiles: Record<string, string | Buffer>, newFiles: Record<string, string | Buffer>) {
	const root = temp("compare-sites-");
	for (const [side, files] of [["old", oldFiles], ["new", newFiles]] as const) {
		for (const [path, data] of Object.entries(files)) {
			const file = join(root, side, path);
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, data);
		}
	}
	const o = await serveDir(join(root, "old"));
	const n = await serveDir(join(root, "new"));
	return { oldUrl: o.url, newUrl: n.url, root, close: async () => (await o.close(), await n.close()) };
}

const page = (...srcs: string[]) => `<!doctype html><html><head><title>t</title></head><body>${srcs.map((s) => `<img src="${s}" alt="">`).join("")}</body></html>`;

/** A fetch for this process: TakeShape's hosts answer from `answer` (undefined refuses), everything else is real. */
function stubFetch(t: { after(fn: () => void): void }, answer: (url: URL) => Response | undefined = () => undefined) {
	const real = globalThis.fetch;
	const requests: Array<{ url: string; accept: string | null }> = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (!url.hostname.endsWith("takeshape.io")) return real(input, init);
		requests.push({ url: url.href, accept: new Headers(init?.headers).get("accept") });
		const res = answer(url);
		if (!res) throw new TypeError(`stub: refused ${url.href}`);
		return res;
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = real;
	});
	return requests;
}

const png = (bytes: Buffer) => new Response(new Uint8Array(bytes), { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) } });
const base: Omit<CompareOptions, "media" | "imageIndex"> = { seeds: [], concurrency: 4, delayMs: 0, ignoreText: [] };

test("local media: old TakeShape images are made locally, and imgix is asked once, as a browser asks", async (t) => {
	const original = await photo(800, 600);
	const query = "w=200&auto=compress,format";
	const url = `https://images.takeshape.io/p1/dev/a1/photo.png?${query}`;
	const copy = await endpointCopy(query, original);
	const s = await sites({ "index.html": page(url.replace("&", "&amp;")) }, { "index.html": page("/img/photo.png"), "img/photo.png": copy });
	t.after(s.close);
	const requests = stubFetch(t, () => png(copy));
	const media = openMedia(mediaProject({ "p1/dev/a1/photo.png": original }));
	const r = await compareDetailed(s.oldUrl, s.newUrl, { ...base, media });
	assert.deepEqual(r.differences, []);
	assert.deepEqual(requests, [{ url, accept: IMGIX_ACCEPT }]);
	assert.deepEqual([...r.sampled.keys()], [url]);
});

test("image-rules: a sample that doesn't match imgix is reported once per setting", async (t) => {
	const originals: Record<string, Buffer> = {};
	const copies: Record<string, Buffer> = {};
	for (const id of ["a1", "a2", "a3", "a4"]) {
		originals[`p1/dev/${id}/${id}.png`] = await photo(800, 600, id === "a2" ? "#fc0" : "#c63");
		copies[`img/${id}.png`] = await endpointCopy("w=200", originals[`p1/dev/${id}/${id}.png`]!);
	}
	const src = (id: string) => `https://images.takeshape.io/p1/dev/${id}/${id}.png?w=200`;
	const s = await sites(
		{ "index.html": page(src("a1"), src("a2")), "two/index.html": page(src("a3"), src("a4")) },
		{ "index.html": page("/img/a1.png", "/img/a2.png"), "two/index.html": page("/img/a3.png", "/img/a4.png"), ...copies },
	);
	t.after(s.close);
	const other = await sharp({ create: { width: 150, height: 100, channels: 3, background: "#000" } }).png().toBuffer();
	stubFetch(t, () => png(other));
	const r = await compareDetailed(s.oldUrl, s.newUrl, { ...base, seeds: ["/two/"], media: openMedia(mediaProject(originals)) });
	assert.deepEqual(r.differences.filter((d) => d.kind === "image"), []);
	const rules = r.differences.filter((d) => d.kind === "image-rules");
	assert.equal(rules.length, 1);
	assert.match(rules[0]!.detail, /a1\.png\?w=200/);
	assert.match(rules[0]!.detail, /150x100/);
	assert.match(rules[0]!.detail, /200x150/);
});

test("image-rules: no answer from imgix is a note for this run, not a difference", async (t) => {
	const original = await photo(800, 600);
	const s = await sites({ "index.html": page("https://images.takeshape.io/p1/dev/a1/photo.png?w=200") }, { "index.html": page("/img/photo.png"), "img/photo.png": await endpointCopy("w=200", original) });
	t.after(s.close);
	stubFetch(t);
	const r = await compareDetailed(s.oldUrl, s.newUrl, { ...base, media: openMedia(mediaProject({ "p1/dev/a1/photo.png": original })) });
	assert.deepEqual(r.differences, []);
	assert.deepEqual(r.notes, []);
	assert.equal(r.info.filter((l) => /rules check couldn't run for 1 setting/.test(l)).length, 1);
});

test("a saved index entry is the old side, and nothing is fetched", async (t) => {
	const original = await photo(800, 600);
	const url = "https://images.takeshape.io/p1/dev/a1/photo.png?w=200";
	const s = await sites({ "index.html": page(url) }, { "index.html": page("/img/photo.png"), "img/photo.png": await endpointCopy("w=200", original) });
	t.after(s.close);
	const requests = stubFetch(t);
	const imageIndex = new Map<string, IndexedImage>([[url, { width: 100, height: 50, hash: 0n, version: HASH_VERSION }]]);
	const r = await compareDetailed(s.oldUrl, s.newUrl, { ...base, imageIndex, media: openMedia(mediaProject({ "p1/dev/a1/photo.png": original })) });
	assert.equal(r.differences.filter((d) => d.kind === "image").length, 1);
	assert.match(r.differences.find((d) => d.kind === "image")!.detail, /100x50/);
	// the entry is imgix's answer for this setting, and the local image doesn't match it
	assert.equal(r.differences.filter((d) => d.kind === "image-rules").length, 1);
	assert.deepEqual(requests, []);
	assert.equal(r.sampled.size, 0);
});

test("crops where imgix picks the spot are fetched from imgix and saved", async (t) => {
	const original = await photo(800, 600);
	const url = "https://images.takeshape.io/p1/dev/a1/photo.png?w=100&h=100&fit=crop&crop=faces";
	const answer = await sharp(original).resize(100, 100).png().toBuffer();
	const s = await sites({ "index.html": page(url.replaceAll("&", "&amp;")) }, { "index.html": page("/img/photo.png"), "img/photo.png": answer });
	t.after(s.close);
	const requests = stubFetch(t, () => png(answer));
	const r = await compareDetailed(s.oldUrl, s.newUrl, { ...base, media: openMedia(mediaProject({ "p1/dev/a1/photo.png": original })) });
	assert.deepEqual(r.differences, []);
	assert.deepEqual(requests, [{ url, accept: IMGIX_ACCEPT }]);
	assert.deepEqual([...r.sampled.keys()], [url]);
});

test("an original imgix showed as an image (a PDF) is reported, and its setting skipped", async (t) => {
	const pdf = Buffer.from("%PDF-1.4\n% a report\n");
	// The new page asks its image endpoint for it, which sends the PDF as stored. (A plain link to report.pdf
	// counts as a file, not an image, so that page reports a different image count, as before.)
	const s = await sites(
		{ "index.html": page("https://images.takeshape.io/p1/dev/a5/report.pdf?w=200") },
		{ "index.html": page("/_takeshape/image?href=%2Ffiles%2Freport.pdf&amp;w=200"), "_takeshape/image": pdf },
	);
	t.after(s.close);
	const requests = stubFetch(t);
	const r = await compareDetailed(s.oldUrl, s.newUrl, { ...base, media: openMedia(mediaProject({ "p1/dev/a5/report.pdf": pdf })) });
	const images = r.differences.filter((d) => d.kind === "image");
	assert.equal(images.length, 1);
	assert.match(images[0]!.detail, /as an image/);
	assert.equal(r.info.filter((l) => /skipped 1 setting/.test(l)).length, 1);
	assert.deepEqual(requests, []);
});

test("an image on assets.takeshape.io with its original makes no request: the old site served the original", async (t) => {
	const original = await photo(800, 600);
	const url = "https://assets.takeshape.io/p1/dev/a1/photo.png";
	const s = await sites({ "index.html": page(url) }, { "index.html": page("/img/photo.png"), "img/photo.png": original });
	t.after(s.close);
	const requests = stubFetch(t, () => png(original));
	const r = await compareDetailed(s.oldUrl, s.newUrl, { ...base, media: openMedia(mediaProject({ "p1/dev/a1/photo.png": original })) });
	assert.deepEqual(r.differences, []);
	assert.deepEqual(requests, []);
	assert.equal(r.sampled.size, 0);
	assert.deepEqual(r.info, []);
});

test("an index entry recorded as unreadable isn't sampled", async (t) => {
	const original = await photo(800, 600);
	const url = "https://images.takeshape.io/p1/dev/a1/photo.png?w=200";
	const s = await sites({ "index.html": page(url) }, { "index.html": page("/img/photo.png"), "img/photo.png": await endpointCopy("w=200", original) });
	t.after(s.close);
	const requests = stubFetch(t);
	const imageIndex = new Map<string, IndexedImage>([[url, { error: "answered 404" }]]);
	const r = await compareDetailed(s.oldUrl, s.newUrl, { ...base, imageIndex, media: openMedia(mediaProject({ "p1/dev/a1/photo.png": original })) });
	// the page reports what the index recorded, as before
	assert.match(r.differences.find((d) => d.kind === "image")?.detail ?? "", /answered 404, when the image index was built/);
	assert.deepEqual(requests, []);
	assert.deepEqual(r.info, []);
});

test("without --media, TakeShape images are fetched as before, with a note", async (t) => {
	const original = await photo(800, 600);
	const copy = await endpointCopy("w=200", original);
	const s = await sites({ "index.html": page("https://images.takeshape.io/p1/dev/a1/photo.png?w=200") }, { "index.html": page("/img/photo.png"), "img/photo.png": copy });
	t.after(s.close);
	const requests = stubFetch(t, () => png(copy));
	const r = await compareDetailed(s.oldUrl, s.newUrl, base);
	assert.deepEqual(r.differences, []);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.accept, null);
	assert.equal(r.info.filter((l) => /1 old image .*TakeShape's hosts.*--media/.test(l)).length, 1);
	assert.equal(r.sampled.size, 0);
});

/** A module for `node --import`: TakeShape's hosts answer with STUB_IMGIX_FILE's bytes, or are refused without it. */
function stubModule(): string {
	const file = join(temp("compare-stub-"), "stub.mjs");
	writeFileSync(
		file,
		`import { readFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (!url.hostname.endsWith("takeshape.io")) return real(input, init);
	if (!process.env.STUB_IMGIX_FILE) throw new TypeError("stub: refused " + url.href);
	const bytes = readFileSync(process.env.STUB_IMGIX_FILE);
	return new Response(bytes, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) } });
};
`,
	);
	return pathToFileURL(file).href;
}

const cli = (args: string[], env: Record<string, string> = {}) =>
	spawnSync(process.execPath, ["--no-warnings", "--import", stubModule(), CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("CLI: no answer from imgix leaves the exit code at 0", async () => {
	const original = await photo(800, 600);
	const root = temp("compare-cli-");
	for (const [side, files] of [
		["old", { "index.html": page("https://images.takeshape.io/p1/dev/a1/photo.png?w=200") }],
		["new", { "index.html": page("/img/photo.png"), "img/photo.png": await endpointCopy("w=200", original) }],
	] as const) {
		for (const [path, data] of Object.entries(files)) {
			mkdirSync(join(root, side, path, ".."), { recursive: true });
			writeFileSync(join(root, side, path), data);
		}
	}
	const project = mediaProject({ "p1/dev/a1/photo.png": original });
	const r = cli([join(root, "old"), join(root, "new"), "--media", project, "--out", join(root, "report.md")]);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	assert.match(readFileSync(join(root, "report.md"), "utf8"), /## Notes for this run[\s\S]*rules check couldn't run/);
});

test("CLI: --media without a ledger exits 2 with what to run", () => {
	const root = temp("compare-cli-");
	mkdirSync(join(root, "old"));
	mkdirSync(join(root, "new"));
	const r = cli([join(root, "old"), join(root, "new"), "--media", root]);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /No media ledger at .*Run the converter with --preload-media local first, then compare with --media\./);
});

test("CLI: write-back keeps old entries as they were and adds the new sample in order", async () => {
	const original = await photo(800, 600);
	const copy = await endpointCopy("w=200", original);
	const root = temp("compare-cli-");
	const url = "https://images.takeshape.io/p1/dev/a1/photo.png?w=200";
	for (const [side, files] of [
		["old", { "index.html": page(url) }],
		["new", { "index.html": page("/img/photo.png"), "img/photo.png": copy }],
	] as const) {
		for (const [path, data] of Object.entries(files)) {
			mkdirSync(join(root, side, path, ".."), { recursive: true });
			writeFileSync(join(root, side, path), data);
		}
	}
	const index = join(root, "image-index.json");
	const old = {
		"https://images.takeshape.io/p1/dev/zz/gone.png?w=10": { error: "answered 404" },
		"https://other.example/old.png": { width: 1, height: 1, hash: "0" },
	};
	writeFileSync(index, `${JSON.stringify(old, null, "\t")}\n`);
	const answer = join(root, "answer.png");
	writeFileSync(answer, copy);
	const r = cli([join(root, "old"), join(root, "new"), "--media", mediaProject({ "p1/dev/a1/photo.png": original }), "--image-index", index, "--out", join(root, "report.md")], { STUB_IMGIX_FILE: answer });
	assert.equal(r.status, 0, r.stderr + r.stdout);
	const written = JSON.parse(readFileSync(index, "utf8")) as Record<string, unknown>;
	assert.deepEqual(Object.keys(written), [...Object.keys(old), url].sort());
	for (const [k, v] of Object.entries(old)) assert.deepEqual(written[k], v);
	const info = await imageOf(new Uint8Array(copy));
	assert.deepEqual(written[url], { width: info.width, height: info.height, hash: hashHex(info.hash), version: HASH_VERSION });
});

test("CLI: an index with nothing new to add is left as it was", async () => {
	const original = await photo(800, 600);
	const copy = await endpointCopy("w=200", original);
	const url = "https://images.takeshape.io/p1/dev/a1/photo.png?w=200";
	const root = temp("compare-cli-");
	for (const [side, files] of [
		["old", { "index.html": page(url) }],
		["new", { "index.html": page("/img/photo.png"), "img/photo.png": copy }],
	] as const) {
		for (const [path, data] of Object.entries(files)) {
			mkdirSync(join(root, side, path, ".."), { recursive: true });
			writeFileSync(join(root, side, path), data);
		}
	}
	const info = await imageOf(new Uint8Array(copy));
	// imgix's answer is already there, in a layout writeImageIndex wouldn't write
	const index = join(root, "image-index.json");
	const text = JSON.stringify({ [url]: { width: info.width, height: info.height, hash: hashHex(info.hash), version: HASH_VERSION } });
	writeFileSync(index, text);
	const r = cli([join(root, "old"), join(root, "new"), "--media", mediaProject({ "p1/dev/a1/photo.png": original }), "--image-index", index, "--out", join(root, "report.md")]);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	assert.equal(readFileSync(index, "utf8"), text);
});

test("CLI: a missing --image-index file is created with --media and refused without it", async () => {
	const root = temp("compare-cli-");
	mkdirSync(join(root, "old"));
	mkdirSync(join(root, "new"));
	writeFileSync(join(root, "old", "index.html"), page());
	writeFileSync(join(root, "new", "index.html"), page());
	const missing = join(root, "nope.json");
	const without = cli([join(root, "old"), join(root, "new"), "--image-index", missing, "--out", join(root, "r1.md")]);
	assert.equal(without.status, 2);
	assert.match(without.stderr, /Cannot read the --image-index file/);
	const withMedia = cli([join(root, "old"), join(root, "new"), "--image-index", missing, "--media", mediaProject({}), "--out", join(root, "r2.md")]);
	assert.equal(withMedia.status, 0, withMedia.stderr + withMedia.stdout);
	assert.ok(existsSync(missing));
	assert.deepEqual(JSON.parse(readFileSync(missing, "utf8")), {});
});
