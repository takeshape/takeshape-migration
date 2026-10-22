import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import sharp from "sharp";
import { compareDetailed, compareSites, serveDir } from "../../compare/compare-sites.mts";
import { hashDistance, hashHex, imageOf, parseImageIndex } from "../../compare/images.mts";
import type { CompareOptions, Difference } from "../../compare/compare-sites.mts";
import { renderReport } from "../../compare/report.mts";

const CASES = fileURLToPath(new URL("./cases/", import.meta.url));
const CLI = fileURLToPath(new URL("../../compare/compare-sites.mts", import.meta.url));

// Copies the case to a temp folder (so __ORIGIN__ can become each site's real address), serves both sides, runs the compare.
async function withCase<T>(name: string, run: (oldUrl: string, newUrl: string, oldDir: string, newDir: string) => Promise<T>): Promise<T> {
	const tmp = await mkdtemp(join(tmpdir(), "compare-case-"));
	await cp(join(CASES, name), tmp, { recursive: true });
	const o = await serveDir(join(tmp, "old"));
	const n = await serveDir(join(tmp, "new"));
	try {
		for (const [dir, url] of [["old", o.url], ["new", n.url]] as const) {
			for (const f of await readdir(join(tmp, dir))) {
				if (!f.endsWith(".xml")) continue;
				const p = join(tmp, dir, f);
				await writeFile(p, (await readFile(p, "utf8")).replaceAll("__ORIGIN__", url));
			}
		}
		return await run(o.url, n.url, join(tmp, "old"), join(tmp, "new"));
	} finally {
		await o.close();
		await n.close();
		await rm(tmp, { recursive: true, force: true });
	}
}

const opts: CompareOptions = { seeds: [], concurrency: 4, delayMs: 0, ignoreText: [] };
const run = (name: string, extra: Partial<CompareOptions> = {}) => withCase(name, (o, n) => compareSites(o, n, { ...opts, ...extra }));
const kinds = (d: Difference[]) => [...new Set(d.map((x) => x.kind))].sort();

test("identical", async () => {
	assert.deepEqual(await run("identical"), []);
});

// A site's JSON-LD can name its logo on TakeShape's image CDN. Re-hosted, the URL is EmDash's media path: an image
// URL inside JSON-LD compares as an image, as it does in an attribute
/**
 * Runs a case whose old pages name images on TakeShape's CDN: each gets a picture in the new folder at `file` and an
 * image index entry under its old URL, so the image check runs offline. Returns the differences and every fetch.
 */
async function withImages(name: string, images: Array<{ old: string; file: string }>, files: string[] = []) {
	return withCase(name, async (o, n, _oldDir, newDir) => {
		for (const f of files) {
			await mkdir(dirname(join(newDir, f)), { recursive: true });
			await writeFile(join(newDir, f), "not an image");
		}
		const index = new Map<string, Awaited<ReturnType<typeof imageOf>>>();
		for (const [i, im] of images.entries()) {
			const b = await sharp({ create: { width: 10 + i, height: 8, channels: 3, background: { r: 40 * i, g: 100, b: 200 } } }).png().toBuffer();
			await mkdir(dirname(join(newDir, im.file)), { recursive: true });
			await writeFile(join(newDir, im.file), b);
			index.set(im.old, await imageOf(b));
		}
		return recordingFetches(() => compareSites(o, n, { ...opts, imageIndex: index }));
	});
}

// A TakeShape CDN URL with no path (what a template printed where an image was missing) showed nothing, as the new
// site's empty value does
const JSONLD_IMAGES = [
	{ old: "https://images.takeshape.io/p1/dev/a1/logo.png?auto=format%2Ccompress", file: "_emdash/api/media/file/ts-a1.png" },
	{ old: "https://images.takeshape.io/p1/dev/a2/12%20Harbor%20View%20cc.jpeg", file: "_emdash/api/media/file/ts-a2.jpeg" },
];

test("jsonld-image-hosts", async () => {
	const { result, fetched } = await withImages("jsonld-image-hosts", JSONLD_IMAGES, ["_emdash/api/media/file/ts-v1.mp4"]);
	assert.deepEqual(result, []);
	assert.ok(!fetched.some((u) => u.includes("takeshape.io")), fetched.join("\n"));
});

// A video's contentUrl compares as [file], so a missing one has to show up as a broken link
test("jsonld-files-that-answer-404-are-broken-links", async () => {
	const { result } = await withImages("jsonld-image-hosts", JSONLD_IMAGES);
	assert.deepEqual(
		result.map((d) => [d.kind, d.path, d.detail]),
		[["broken-link", "/", "Links to /_emdash/api/media/file/ts-v1.mp4, which answers 404."]],
	);
});

// Components can take image and video URLs in their own attributes (<hero-video :sources img>, <x-banner
// background>). Re-hosted, they compare as the image and file markers an <img src> gets.
const COMPONENT_IMAGES = [
	{ old: "https://images.takeshape.io/p1/dev/a2/still.jpg?w=10", file: "_emdash/api/media/file/ts-a2.jpg" },
	{ old: "https://images.takeshape.io/p1/dev/a3/sky.jpg?auto=compress%2Cformat", file: "_takeshape/image" },
];
const COMPONENT_FILES = ["_emdash/api/media/file/ts-a1.mp4", "_takeshape-files/0123456789ab/guide.pdf"];

test("component-attribute-hosts", async () => {
	const { result, fetched } = await withImages("component-attribute-hosts", COMPONENT_IMAGES, COMPONENT_FILES);
	assert.deepEqual(result, []);
	assert.ok(!fetched.some((u) => u.includes("takeshape.io")), fetched.join("\n"));
});

// The content compare sees those files only as markers, so a missing one has to show up as a broken link
test("component-attribute-files-that-answer-404-are-broken-links", async () => {
	const { result } = await withImages("component-attribute-hosts", COMPONENT_IMAGES);
	assert.deepEqual(
		result.map((d) => [d.kind, d.path, d.detail]),
		[
			["broken-link", "/", "Links to /_emdash/api/media/file/ts-a1.mp4, which answers 404."],
			["broken-link", "/", "Links to /_takeshape-files/0123456789ab/guide.pdf, which answers 404."],
		],
	);
});

test("missing-page", async () => {
	const d = await run("missing-page");
	// The home page lost its link too, so it also differs.
	assert.deepEqual(d.filter((x) => x.kind === "missing").map((x) => x.path), ["/about/"]);
	assert.deepEqual(kinds(d), ["content", "missing"]);
});

test("extra-page", async () => {
	const d = await run("extra-page");
	assert.deepEqual(d.filter((x) => x.kind === "extra").map((x) => x.path), ["/new-page/"]);
	assert.deepEqual(kinds(d), ["content", "extra"]);
});

test("text-change", async () => {
	const d = await run("text-change");
	assert.deepEqual(kinds(d), ["content"]);
	assert.match(d[0].detail, /- .*Hello world/);
	assert.match(d[0].detail, /\+ .*Hello there/);
});

test("attribute-change", async () => {
	const d = await run("attribute-change");
	assert.deepEqual(kinds(d), ["content"]);
	assert.equal(d[0].path, "/");
});

test("broken-link", async () => {
	const d = await run("broken-link");
	assert.ok(d.some((x) => x.kind === "broken-link" && x.path === "/" && x.detail.includes("/gone/")));
});

test("image-size-differs", async () => {
	const d = await run("image-size-differs");
	assert.deepEqual(kinds(d), ["image"]);
	assert.match(d[0].detail, /4x3.*3x4/);
});

test("image-content-differs", async () => {
	const d = await run("image-content-differs");
	assert.deepEqual(kinds(d), ["image"]);
	assert.match(d[0].detail, /look different/);
});

test("image-hosts-equal", async () => {
	assert.deepEqual(await run("image-hosts-equal"), []);
});

test("requested-files: every path given in --urls is compared, assets too", async () => {
	// No page links to these, as with robots.txt and favicon.ico on a takeshape-ssg site
	const seeds = ["/robots.txt", "/same.css", "/style.css", "/favicon.ico", "/gone.css", "/photo.png", "/recompressed.jpg"];
	const pixels = sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 120, b: 40 } } });
	const photo = await pixels.clone().png().toBuffer();
	const { differences, pagesCompared } = await withCase("requested-files", async (o, n, oldDir, newDir) => {
		for (const dir of [oldDir, newDir]) await writeFile(join(dir, "photo.png"), photo);
		// The same picture: a recompressed JPEG on the old host, the original PNG bytes on the new site
		await writeFile(join(oldDir, "recompressed.jpg"), await sharp(photo).jpeg({ quality: 60 }).toBuffer());
		await writeFile(join(newDir, "recompressed.jpg"), photo);
		return compareDetailed(o, n, { ...opts, seeds });
	});
	const byPath = Object.fromEntries(differences.map((d) => [d.path, d.kind]));
	assert.deepEqual(byPath, { "/favicon.ico": "content", "/gone.css": "missing", "/style.css": "content" });
	assert.match(differences.find((d) => d.path === "/style.css")!.detail, /red/);
	// The home page, /sitemap.xml (404 on both) and the seven files
	assert.equal(pagesCompared, 9);
});

test("image-recompressed", async () => {
	// The old host served a recompressed JPEG of the photo the new site serves as the original file. source.jpg is
	// a generated 360x240 picture: a nearly flat sky, a hill, a house and a textured corner. Its flat areas made a
	// 9x8 resample flip hash bits between the two encodings: with hash version 1 the quality-60 JPEG and the PNG
	// differ by 8 bits, over the compare's threshold of 6; with version 2 they match.
	const source = await readFile(join(CASES, "image-recompressed", "source.jpg"));
	const d = await withCase("image-recompressed", async (o, n, oldDir, newDir) => {
		await writeFile(join(oldDir, "photo.jpg"), await sharp(source).jpeg({ quality: 60 }).toBuffer());
		await writeFile(join(newDir, "photo.png"), await sharp(source).png().toBuffer());
		return compareSites(o, n, opts);
	});
	assert.deepEqual(d, []);
});

test("image hash: transparent pixels count as a white page shows them", async () => {
	// A black logo on a transparent background: imgix's PNG and the endpoint's WebP hid different colors
	// under the transparent pixels, and the hash read those. A browser shows neither.
	const square = { create: { width: 30, height: 30, channels: 4 as const, background: { r: 0, g: 0, b: 0, alpha: 1 } } };
	const onClear = await sharp({ create: { width: 90, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: await sharp(square).png().toBuffer(), left: 30, top: 25 }]).png().toBuffer();
	const onWhite = await sharp({ create: { width: 90, height: 80, channels: 3, background: "#ffffff" } }).composite([{ input: await sharp(square).png().toBuffer(), left: 30, top: 25 }]).png().toBuffer();
	assert.equal(hashDistance((await imageOf(onClear)).hash, (await imageOf(onWhite)).hash), 0);
});

test("image hash: EXIF orientation counts as a browser applies it", async () => {
	// imgix applied the orientation and dropped it; the new site serves the stored JPEG, which browsers turn
	const shown = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#ffffff" } })
		.composite([{ input: await sharp({ create: { width: 15, height: 30, channels: 3, background: "#000000" } }).png().toBuffer(), left: 0, top: 0 }])
		.png()
		.toBuffer();
	const stored = await sharp(await sharp(shown).rotate(270).png().toBuffer()).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer();
	const a = await imageOf(await sharp(shown).jpeg({ quality: 100 }).toBuffer());
	const b = await imageOf(stored);
	assert.deepEqual([b.width, b.height], [40, 30]);
	assert.ok(hashDistance(a.hash, b.hash) <= 1, `distance ${hashDistance(a.hash, b.hash)}`);
});

test("image hash: cells within one gray level of each other don't flip bits", async () => {
	// A sky's neighboring cells differ by less than a gray level, so two encoders of one photo ordered them differently
	const stripes = async (even: number, odd: number) => {
		const px = Buffer.alloc(90 * 80);
		for (let y = 0; y < 80; y++) for (let x = 0; x < 90; x++) px[y * 90 + x] = Math.floor(x / 10) % 2 ? odd : even;
		return imageOf(await sharp(px, { raw: { width: 90, height: 80, channels: 1 } }).png().toBuffer());
	};
	assert.equal(hashDistance((await stripes(128, 129)).hash, (await stripes(129, 128)).hash), 0);
	// A step a viewer sees still sets bits
	assert.notEqual((await stripes(100, 140)).hash, 0n);
});

test("takeshape-leftover", async () => {
	const d = await run("takeshape-leftover");
	assert.deepEqual(kinds(d), ["takeshape-host"]);
	assert.equal(d[0].path, "/app.js");
	assert.match(d[0].detail, /api\.takeshape\.io/);
});

test("takeshape-leftover-subdomain-in-html", async () => {
	const d = await run("takeshape-images-host");
	assert.ok(d.some((x) => x.kind === "takeshape-host" && x.path === "/" && x.detail.includes("images.takeshape.io")));
});

test("takeshape-site-link-does-not-fail", async () => {
	const r = await withCase("takeshape-site-link", (o, n) => compareDetailed(o, n, opts));
	assert.deepEqual(r.differences, []);
	assert.deepEqual(r.takeshapeSiteLinks, [{ path: "/", links: ["https://www.takeshape.io/"] }]);
	const md = renderReport(r, { oldSite: "old", newSite: "new" });
	assert.match(md, /## Links to TakeShape's website, which go dead after January 15\n[\s\S]*### \/\n\n- https:\/\/www\.takeshape\.io\//);
});

test("sitemap-hosts", async () => {
	assert.deepEqual(await run("sitemap-hosts"), []);
});

test("status-404", async () => {
	const d = await run("status-404");
	assert.deepEqual(kinds(d), ["status"]);
	assert.equal(d[0].path, "/s/");
});

test("trailing-slash", async () => {
	const d = await run("trailing-slash");
	assert.ok(d.some((x) => x.kind === "redirect" && x.path === "/blog"));
});

test("redirect-same-target", async () => {
	assert.deepEqual(await run("redirect-same"), []);
});

test("ignore-text", async () => {
	assert.deepEqual(kinds(await run("ignore-text")), ["content"]);
	assert.deepEqual(await run("ignore-text", { ignoreText: [/Published [A-Z][a-z]+ \d{1,2}, \d{4}/] }), []);
});

test("serve-dir", async () => {
	const s = await serveDir(join(CASES, "trailing-slash", "old"));
	try {
		const r = await fetch(`${s.url}/blog`, { redirect: "manual" });
		assert.equal(r.status, 301);
		assert.equal(r.headers.get("location"), "/blog/");
		assert.equal((await fetch(`${s.url}/blog/`)).status, 200);
		assert.equal((await fetch(`${s.url}/nope`)).status, 404);
		assert.equal((await fetch(`${s.url}/../../etc/passwd`)).status, 404);
	} finally {
		await s.close();
	}
});

test("cli-exit-codes-and-report", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "compare-cli-"));
	try {
		const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
		const same = run(join(CASES, "identical/old"), join(CASES, "identical/new"), "--out", join(tmp, "a.md"));
		assert.equal(same.status, 0, same.stderr);
		const out = join(tmp, "b.md");
		const json = join(tmp, "b.json");
		const diff = run(join(CASES, "text-change/old"), join(CASES, "text-change/new"), "--out", out, "--json", json);
		assert.equal(diff.status, 1, diff.stderr);
		const md = await readFile(out, "utf8");
		assert.match(md, /^# Site comparison/);
		assert.match(md, /\| content \|/);
		assert.match(md, /### \//);
		assert.doesNotMatch(md, /—/);
		assert.equal(JSON.parse(await readFile(json, "utf8")).differences[0].kind, "content");
		assert.equal(run().status, 2);
		assert.equal(run("http://127.0.0.1:1", "http://127.0.0.1:1", "--out", join(tmp, "c.md")).status, 2);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});

// ---- fix round 1 ----

async function mini(handle: (req: IncomingMessage, res: ServerResponse) => void) {
	const server = createServer(handle);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections();
				server.close(() => done());
			}),
	};
}
const html = (res: ServerResponse, body: string, status = 200) => {
	res.writeHead(status, { "content-type": "text/html" });
	res.end(`<!doctype html><html><body>${body}</body></html>`);
};
async function withMinis<T>(a: Parameters<typeof mini>[0], b: Parameters<typeof mini>[0], f: (o: string, n: string) => Promise<T>): Promise<T> {
	const o = await mini(a);
	const n = await mini(b);
	try {
		return await f(o.url, n.url);
	} finally {
		await o.close();
		await n.close();
	}
}
const path = (req: IncomingMessage) => new URL(req.url ?? "/", "http://x").pathname;

test("cli-missing-folder-exits-2", async () => {
	const r = spawnSync(process.execPath, [CLI, "/nonexistent-a-folder", "/nonexistent-b-folder"], { encoding: "utf8" });
	assert.equal(r.status, 2);
	assert.match(r.stderr, /does not exist/);
});

test("cli-root-404-exits-2", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "compare-empty-"));
	try {
		const r = spawnSync(process.execPath, [CLI, tmp, tmp, "--out", join(tmp, "r.md")], { encoding: "utf8" });
		assert.equal(r.status, 2);
		assert.match(r.stderr, /old site.*404/i);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});

test("root-404-on-one-side-rejects", async () => {
	await withMinis(
		(_q, res) => html(res, "ok"),
		(_q, res) => html(res, "nope", 404),
		async (o, n) => {
			await assert.rejects(compareSites(o, n, opts), /new site.*404/i);
		},
	);
});

test("hanging-and-resetting-urls-become-differences", async () => {
	const png = await readFile(join(CASES, "image-hosts-equal/old/img/a.png"));
	const old = (req: IncomingMessage, res: ServerResponse) => {
		const p = path(req);
		if (p === "/a.png") {
			res.writeHead(200, { "content-type": "image/png" });
			res.end(png);
		} else html(res, p === "/" ? '<a href="/hang">h</a><a href="/reset">r</a><img src="/a.png"><a href="/fine">f</a>' : "same");
	};
	const neu = (req: IncomingMessage, res: ServerResponse) => {
		const p = path(req);
		if (p === "/hang" || p === "/b.png") return; // never answers
		if (p === "/reset") return void req.socket.destroy();
		html(res, p === "/" ? '<a href="/hang">h</a><a href="/reset">r</a><img src="/b.png"><a href="/fine">f</a>' : "same");
	};
	const d = await withMinis(old, neu, (o, n) => compareSites(o, n, { ...opts, timeoutMs: 300 }));
	assert.ok(d.some((x) => x.path === "/hang" && x.kind === "status"), JSON.stringify(d));
	assert.ok(d.some((x) => x.path === "/reset" && x.kind === "status"), JSON.stringify(d));
	assert.ok(d.some((x) => x.kind === "image" && /cannot read/.test(x.detail)), JSON.stringify(d));
	assert.ok(!d.some((x) => x.path === "/fine"));
});

const many = (n: number, q: boolean) => (req: IncomingMessage, res: ServerResponse) => {
	if (path(req) !== "/") return html(res, "leaf");
	html(res, Array.from({ length: n }, (_v, i) => `<a href="${q ? `/?page=${i}` : `/p${i}/`}">x</a>`).join(""));
};

test("max-pages-cap-notes-in-report", async () => {
	const r = await withMinis(many(20, false), many(20, false), (o, n) => compareDetailed(o, n, { ...opts, maxPages: 5 }));
	assert.ok(r.pagesCompared <= 6, String(r.pagesCompared));
	const md = renderReport(r, { oldSite: "o", newSite: "n" });
	assert.match(md, /stopped at 5 pages/i);
});

test("ignore-query", async () => {
	const full = await withMinis(many(20, true), many(20, true), (o, n) => compareDetailed(o, n, opts));
	assert.ok(full.pagesCompared >= 20);
	const cut = await withMinis(many(20, true), many(20, true), (o, n) => compareDetailed(o, n, { ...opts, ignoreQuery: true }));
	assert.ok(cut.pagesCompared < 5, String(cut.pagesCompared));
});

test("origin-option", async () => {
	const without = await run("origin-www");
	assert.ok(without.length > 0);
	const withO = await run("origin-www", { origins: ["https://example.com", "https://www.example.com"] });
	assert.deepEqual(withO, []);
});

test("broken-link-via-redirect-to-404", async () => {
	const mk = (neu: boolean) => (req: IncomingMessage, res: ServerResponse) => {
		const p = path(req);
		if (p === "/") return html(res, '<a href="/moved">m</a>');
		if (p === "/moved" && neu) {
			res.writeHead(301, { location: "/gone" });
			return void res.end();
		}
		if (p === "/moved") return html(res, "here");
		html(res, "nope", 404);
	};
	const d = await withMinis(mk(false), mk(true), (o, n) => compareSites(o, n, opts));
	assert.ok(d.some((x) => x.kind === "broken-link" && x.path === "/" && /\/gone/.test(x.detail)), JSON.stringify(d));
});

test("broken-link-new-only-link-to-path-404-on-both", async () => {
	assert.ok((await run("broken-link-new-only")).some((x) => x.kind === "broken-link" && x.detail.includes("/typo/")));
});

test("broken-link-suppressed-when-old-page-has-it-too", async () => {
	assert.deepEqual(await run("broken-link-both"), []);
});

test("image-count-differs", async () => {
	const d = (await run("image-count-differs")).filter((x) => x.kind === "image");
	assert.equal(d.length, 1);
	assert.match(d[0].detail, /2 images on the old page, 1 on the new/);
});

test("usage-text-explains-ignore-text", () => {
	const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
	assert.equal(r.status, 2);
	assert.match(r.stderr, /HTML text only/);
	assert.match(r.stderr, /without flags/);
});

test("cap-hit-exits-1-and-says-incomplete", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "compare-cap-"));
	try {
		const site = join(tmp, "site");
		await cp(join(CASES, "identical/old"), site, { recursive: true });
		const links = Array.from({ length: 10 }, (_v, i) => `<a href="/p${i}/">x</a>`).join("");
		await writeFile(join(site, "index.html"), `<!doctype html><html><body>${links}</body></html>`);
		for (let i = 0; i < 10; i++) {
			await cp(join(site, "about"), join(site, `p${i}`), { recursive: true });
		}
		const out = join(tmp, "r.md");
		const r = spawnSync(process.execPath, [CLI, site, site, "--max-pages", "3", "--out", out], { encoding: "utf8" });
		assert.equal(r.status, 1, r.stdout + r.stderr);
		const md = await readFile(out, "utf8");
		assert.match(md, /incomplete/i);
		assert.match(md, /--max-pages/);
		assert.match(md, /--ignore-query/);
		assert.match(md, /stopped at 3 pages/);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});

// ---- --image-index: the old site's images from a saved index, so the compare runs after TakeShape's CDN is gone ----

const REMOTE = "https://images.takeshape.io/p/dev/a/photo.png?auto=compress%2Cformat";

/** An old page with a TakeShape CDN image and a local one, a new page with both as EmDash media. */
async function withIndexCase<T>(f: (o: string, n: string, photo: Buffer) => Promise<T>, given?: Buffer): Promise<T> {
	const photo =
		given ??
		(await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 120, b: 40 } } })
			.composite([{ input: { create: { width: 20, height: 30, channels: 3, background: { r: 20, g: 40, b: 220 } } }, left: 0, top: 0 }])
			.png()
			.toBuffer());
	const local = await sharp({ create: { width: 20, height: 10, channels: 3, background: { r: 10, g: 200, b: 90 } } }).png().toBuffer();
	const png = (res: ServerResponse, b: Buffer) => {
		res.writeHead(200, { "content-type": "image/png" });
		res.end(b);
	};
	return withMinis(
		(req, res) => {
			const p = path(req);
			if (p === "/local.png") return png(res, local);
			if (p === "/") return html(res, `<img src="${REMOTE}"><img src="/local.png">`);
			html(res, "nope", 404);
		},
		(req, res) => {
			const p = path(req);
			if (p === "/_emdash/api/media/file/a.png") return png(res, photo);
			if (p === "/_emdash/api/media/file/b.png") return png(res, local);
			if (p === "/") return html(res, '<img src="/_emdash/api/media/file/a.png"><img src="/_emdash/api/media/file/b.png">');
			html(res, "nope", 404);
		},
		(o, n) => f(o, n, photo),
	);
}

/** Runs `f` with every fetch recorded. */
async function recordingFetches<T>(f: () => Promise<T>): Promise<{ result: T; fetched: string[] }> {
	const real = globalThis.fetch;
	const fetched: string[] = [];
	globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
		fetched.push(input instanceof Request ? input.url : String(input));
		return real(input, init);
	};
	try {
		return { result: await f(), fetched };
	} finally {
		globalThis.fetch = real;
	}
}

test("image-index: an old image in the index is not fetched, one missing from it is fetched as before", async () => {
	const { result, fetched } = await withIndexCase(async (o, n, photo) => {
		const { width, height, hash } = await imageOf(photo);
		return recordingFetches(() => compareDetailed(o, n, { ...opts, imageIndex: new Map([[REMOTE, { width, height, hash }]]) }));
	});
	assert.deepEqual(result.differences, []);
	assert.ok(!fetched.some((u) => u.includes("takeshape.io")), fetched.join("\n"));
	assert.ok(fetched.some((u) => u.endsWith("/local.png")), fetched.join("\n"));
});

// An image the old site couldn't serve when the index was built (it answered 404) is a difference from the index
// alone, with no request to TakeShape's CDN
test("image-index: an image recorded as unreadable is reported without fetching it", async () => {
	const { result, fetched } = await withIndexCase((o, n) => recordingFetches(() => compareDetailed(o, n, { ...opts, imageIndex: parseImageIndex(JSON.stringify({ [REMOTE]: { error: "answered 404" } })) })));
	assert.equal(result.differences.length, 1, JSON.stringify(result.differences));
	assert.match(result.differences[0]!.detail, /Image 1 on this page: cannot read old .*photo\.png\S* \(answered 404, when the image index was built\)/);
	assert.ok(!fetched.some((u) => u.includes("takeshape.io")), fetched.join("\n"));
	assert.throws(() => parseImageIndex(JSON.stringify({ [REMOTE]: { error: 404 } })), /needs a whole width and height|error/);
});

test("image-index: a wrong size in the index is a difference", async () => {
	const d = await withIndexCase(async (o, n, photo) => {
		const { hash } = await imageOf(photo);
		return compareSites(o, n, { ...opts, imageIndex: new Map([[REMOTE, { width: 41, height: 30, hash }]]) });
	});
	assert.equal(d.length, 1, JSON.stringify(d));
	assert.equal(d[0].kind, "image");
	assert.match(d[0].detail, /Image 1 on this page: old .*photo\.png.* is 41x30, new .* is 40x30/);
});

test("image-index: a different picture under the same size is a difference", async () => {
	const d = await withIndexCase(async (o, n, photo) => {
		const { width, height, hash } = await imageOf(photo);
		return compareSites(o, n, { ...opts, imageIndex: new Map([[REMOTE, { width, height, hash: ~hash & 0xffffffffffffffffn }]]) });
	});
	assert.equal(d.length, 1, JSON.stringify(d));
	assert.match(d[0].detail, /look different/);
});

// An index saved before the hash changed (no "version") may be the only record of the old site once TakeShape's CDN
// is gone: its entries compare against the new image hashed the way they were
test("image-index: an entry without a version compares with the hash it was made with", async () => {
	// Black stripes on transparent pixels: the first hash read them as black on black, the second as black on white
	const stripe = await sharp({ create: { width: 5, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
	const photo = await sharp({ create: { width: 45, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
		.composite([0, 10, 20, 30, 40].map((left) => ({ input: stripe, left, top: 0 })))
		.png()
		.toBuffer();
	const v1 = await imageOf(photo, 1);
	const v2 = await imageOf(photo);
	assert.ok(hashDistance(v1.hash, v2.hash) > 6, "the two hashes must tell this image apart for the test to mean anything");
	const entry = (version?: number) => JSON.stringify({ [REMOTE]: { width: v1.width, height: v1.height, hash: hashHex(v1.hash), ...(version ? { version } : {}) } });
	const legacy = await withIndexCase((o, n) => compareSites(o, n, { ...opts, imageIndex: parseImageIndex(entry()) }), photo);
	assert.deepEqual(legacy, []);
	// The same hash claimed as version 2 is compared as version 2, and differs
	const claimed = await withIndexCase((o, n) => compareSites(o, n, { ...opts, imageIndex: parseImageIndex(entry(2)) }), photo);
	assert.match(claimed[0]?.detail ?? "", /look different/);
});

test("cli: --image-index reads hex hashes, --fetch-log lists every request", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "compare-index-"));
	try {
		await withIndexCase(async (o, n, photo) => {
			const { width, height, hash } = await imageOf(photo);
			const index = join(tmp, "index.json");
			const log = join(tmp, "fetches.txt");
			await writeFile(index, JSON.stringify({ [REMOTE]: { width, height, hash: hashHex(hash) } }));
			const r = await new Promise<{ status: number | null; out: string }>((done) => {
				const child = spawn(process.execPath, [CLI, o, n, "--image-index", index, "--fetch-log", log, "--out", join(tmp, "r.md")]);
				let out = "";
				child.stdout.on("data", (b: Buffer) => (out += b));
				child.stderr.on("data", (b: Buffer) => (out += b));
				child.on("close", (status) => done({ status, out }));
			});
			assert.equal(r.status, 0, r.out);
			const fetched = (await readFile(log, "utf8")).trim().split("\n");
			assert.ok(fetched.includes(`${o}/`), fetched.join("\n"));
			assert.ok(fetched.includes(`${n}/_emdash/api/media/file/a.png`), fetched.join("\n"));
			assert.ok(!fetched.some((u) => u.includes("takeshape.io")), fetched.join("\n"));
		});
		assert.equal(hashHex(5n), "0000000000000005");
		await writeFile(join(tmp, "bad.json"), JSON.stringify({ [REMOTE]: { width: 40, height: 30, hash: "not hex" } }));
		const bad = spawnSync(process.execPath, [CLI, join(CASES, "identical/old"), join(CASES, "identical/new"), "--image-index", join(tmp, "bad.json"), "--out", join(tmp, "b.md")], { encoding: "utf8" });
		assert.equal(bad.status, 2);
		assert.match(bad.stderr, /--image-index/);
		assert.match(bad.stderr, /hash/);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});

// JSON-LD and component attributes hold images too (a logo, <x-banner background>): re-hosted, they compare
// as markers and join the image check, so a missing or changed file on the new site still shows
test("JSON-LD and component images are fetched and checked like an <img src>", async () => {
	const logo = await sharp({ create: { width: 30, height: 20, channels: 3, background: { r: 10, g: 90, b: 200 } } }).png().toBuffer();
	const bg = await sharp({ create: { width: 16, height: 9, channels: 3, background: { r: 230, g: 40, b: 40 } } }).png().toBuffer();
	const OLD_LOGO = "https://images.takeshape.io/p/dev/l/logo.png";
	const OLD_BG = "https://images.takeshape.io/p/dev/b/bg.png?w=16";
	const index = new Map([
		[OLD_LOGO, await imageOf(logo)],
		[OLD_BG, await imageOf(bg)],
	]);
	const png = (res: ServerResponse, b: Buffer) => {
		res.writeHead(200, { "content-type": "image/png" });
		res.end(b);
	};
	const page = (logoUrl: string, bgUrl: string) =>
		`<script type="application/ld+json">{ "logo": { "url": "${logoUrl}" } }</script><x-banner background="${bgUrl}" heading="Sky"></x-banner>`;
	const run = (serveBg: boolean) =>
		withMinis(
			(req, res) => html(res, path(req) === "/" ? page(OLD_LOGO, OLD_BG) : "nope", path(req) === "/" ? 200 : 404),
			(req, res) => {
				const p = path(req);
				if (p === "/_emdash/api/media/file/logo.png") return png(res, logo);
				if (p === "/_takeshape-files/abc/bg.png" && serveBg) return png(res, bg);
				html(res, p === "/" ? page("/_emdash/api/media/file/logo.png", "/_takeshape-files/abc/bg.png") : "nope", p === "/" ? 200 : 404);
			},
			(o, n) => compareSites(o, n, { ...opts, imageIndex: index }),
		);
	assert.deepEqual(await run(true), []);
	const missing = await run(false);
	assert.equal(missing.length, 1, JSON.stringify(missing));
	assert.match(missing[0]!.detail, /Image 2 on this page: cannot read new \/_takeshape-files\/abc\/bg\.png/);
});

// Text that ends like a file name is no URL: only known media, CDN and image endpoint URLs become markers outside
// the image attributes
test("an attribute's text ending in an image extension still compares as text", async () => {
	const page = (alt: string) => `<p data-file="${alt}" title="${alt}">x</p>`;
	const d = await withMinis(
		(req, res) => html(res, path(req) === "/" ? page("logo.png") : "nope", path(req) === "/" ? 200 : 404),
		(req, res) => html(res, path(req) === "/" ? page("different-logo.png") : "nope", path(req) === "/" ? 200 : 404),
		(o, n) => compareSites(o, n, opts),
	);
	assert.deepEqual(kinds(d), ["content"]);
	assert.match(d[0]!.detail, /different-logo\.png/);
});
