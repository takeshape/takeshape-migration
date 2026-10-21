// compare/originals.mts finds the original of an old page's TakeShape image: the file the preload stored, through
// its ledger, or a download from assets.takeshape.io kept in the project's cache folder. Offline: a stub stands in
// for fetch.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { MediaError, openMedia, takeshapeAssetPath } from "../../compare/originals.mts";

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A project folder with a preload ledger holding `rows` (source URL and storage key) and the given uploads. */
function project(rows: Array<{ url: string; key: string }>, uploads: Record<string, Buffer> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "compare-originals-"));
	dirs.push(dir);
	mkdirSync(join(dir, "takeshape"));
	mkdirSync(join(dir, "uploads"));
	const db = new DatabaseSync(join(dir, "takeshape", "takeshape-media.db"));
	db.exec(
		"CREATE TABLE takeshape_media_sources (source_key text primary key, source_url text not null, source_size integer, source_etag text, media_id text not null, storage_key text not null, updated_at text not null)",
	);
	const insert = db.prepare("INSERT INTO takeshape_media_sources VALUES (?, ?, ?, ?, ?, ?, ?)");
	rows.forEach((r, i) => insert.run(`k${i}`, r.url, null, null, `m${i}`, r.key, "2026-10-20T00:00:00.000Z"));
	db.close();
	for (const [key, bytes] of Object.entries(uploads)) writeFileSync(join(dir, "uploads", key), bytes);
	return dir;
}

/** A fetch that answers from `answers` by URL and records every request. */
function stub(answers: Record<string, () => Response>) {
	const calls: string[] = [];
	const fetch = (async (input: string | URL | Request) => {
		const url = input instanceof Request ? input.url : String(input);
		calls.push(url);
		const answer = answers[url];
		if (!answer) throw new Error(`stub: no answer for ${url}`);
		return answer();
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

/** A response whose Content-Length is `length`, which may be more than the body holds. */
function body(bytes: Buffer, length = bytes.length): Response {
	return new Response(new Uint8Array(bytes), { status: 200, headers: { "Content-Length": String(length), "Content-Type": "image/jpeg" } });
}

test("takeshapeAssetPath: the decoded asset path on TakeShape's two hosts, else null", () => {
	assert.equal(takeshapeAssetPath(new URL("https://images.takeshape.io/p1/dev/a1/peter%20pan's%20caf%C3%A9.jpg?w=300")), "p1/dev/a1/peter pan's café.jpg");
	assert.equal(takeshapeAssetPath(new URL("https://assets.takeshape.io/p1/dev/a1/x.png")), "p1/dev/a1/x.png");
	assert.equal(takeshapeAssetPath(new URL("https://images.takeshape.io/")), null);
	assert.equal(takeshapeAssetPath(new URL("https://images.takeshape.io/p1/x.png")), null);
	assert.equal(takeshapeAssetPath(new URL("https://example.com/p1/dev/a1/x.png")), null);
	// A segment that decodes to a path step or a separator would let the cache folder's path climb out of it
	assert.equal(takeshapeAssetPath(new URL("https://images.takeshape.io/p1/dev/%2E%2E/x.png")), null);
	assert.equal(takeshapeAssetPath(new URL("https://images.takeshape.io/p1/dev/a1/a%2Fb.png")), null);
	assert.equal(takeshapeAssetPath(new URL("https://images.takeshape.io/p1/dev/a1/a%5Cb.png")), null);
});

test("original: a ledger row on assets.takeshape.io is the stored file, read without a request", async () => {
	const png = Buffer.from("not really a png, but the bytes the preload stored");
	const dir = project([{ url: "https://assets.takeshape.io/p1/dev/a1/x.png", key: "ts-a1.png" }], { "ts-a1.png": png });
	const s = stub({});
	const media = openMedia(dir, { fetch: s.fetch });
	try {
		const o = await media.original("p1/dev/a1/x.png");
		assert.deepEqual(Buffer.from(o.bytes), png);
		assert.equal(o.type, "image/png");
		assert.deepEqual(s.calls, []);
		assert.equal(media.downloaded, 0);
	} finally {
		media.close();
	}
});

test("original: a ledger row on images.takeshape.io doesn't count; the original is downloaded once and kept", async () => {
	const jpeg = Buffer.from("the original from S3");
	const dir = project([{ url: "https://images.takeshape.io/p1/dev/a2/y.jpg", key: "ts-url-abc.jpg" }], { "ts-url-abc.jpg": Buffer.from("imgix's copy") });
	const s = stub({ "https://assets.takeshape.io/p1/dev/a2/y.jpg": () => body(jpeg) });
	const media = openMedia(dir, { fetch: s.fetch });
	try {
		const [first, second] = await Promise.all([media.original("p1/dev/a2/y.jpg"), media.original("p1/dev/a2/y.jpg")]);
		assert.deepEqual(Buffer.from(first.bytes), jpeg);
		assert.deepEqual(Buffer.from(second.bytes), jpeg);
		assert.equal(first.type, "image/jpeg");
		assert.ok(existsSync(join(dir, "takeshape", "compare-originals", "p1", "dev", "a2", "y.jpg")));
		const again = await media.original("p1/dev/a2/y.jpg");
		assert.deepEqual(Buffer.from(again.bytes), jpeg);
		assert.deepEqual(s.calls, ["https://assets.takeshape.io/p1/dev/a2/y.jpg"]);
		assert.equal(media.downloaded, 1);
	} finally {
		media.close();
	}
});

test("original: a later run finds the cached download without a request", async () => {
	const dir = project([]);
	mkdirSync(join(dir, "takeshape", "compare-originals", "p1", "dev", "a3"), { recursive: true });
	writeFileSync(join(dir, "takeshape", "compare-originals", "p1", "dev", "a3", "z z.gif"), "cached");
	const s = stub({});
	const media = openMedia(dir, { fetch: s.fetch });
	try {
		assert.equal(Buffer.from((await media.original("p1/dev/a3/z z.gif")).bytes).toString(), "cached");
		assert.deepEqual(s.calls, []);
	} finally {
		media.close();
	}
});

test("original: a download is percent-encoded per segment", async () => {
	const dir = project([]);
	const s = stub({ "https://assets.takeshape.io/p1/dev/a4/peter%20pan's%20caf%C3%A9.jpg": () => body(Buffer.from("x")) });
	const media = openMedia(dir, { fetch: s.fetch });
	try {
		await media.original("p1/dev/a4/peter pan's café.jpg");
		assert.deepEqual(s.calls, ["https://assets.takeshape.io/p1/dev/a4/peter%20pan's%20caf%C3%A9.jpg"]);
	} finally {
		media.close();
	}
});

test("original: a body shorter than its Content-Length rejects and leaves nothing in the cache", async () => {
	const dir = project([]);
	const s = stub({ "https://assets.takeshape.io/p1/dev/a5/short.jpg": () => body(Buffer.from("half"), 1000) });
	const media = openMedia(dir, { fetch: s.fetch });
	try {
		await assert.rejects(media.original("p1/dev/a5/short.jpg"), /short\.jpg/);
		const cache = join(dir, "takeshape", "compare-originals", "p1", "dev", "a5");
		assert.deepEqual(existsSync(cache) ? readdirSync(cache) : [], []);
	} finally {
		media.close();
	}
});

test("original: a 404 rejects, naming the URL and the status", async () => {
	const dir = project([]);
	const s = stub({ "https://assets.takeshape.io/p1/dev/a6/gone.jpg": () => new Response("no", { status: 404 }) });
	const media = openMedia(dir, { fetch: s.fetch });
	try {
		await assert.rejects(media.original("p1/dev/a6/gone.jpg"), /https:\/\/assets\.takeshape\.io\/p1\/dev\/a6\/gone\.jpg.*404/);
	} finally {
		media.close();
	}
});

test("original: a download that failed isn't asked for again in the same run", async () => {
	const dir = project([]);
	const s = stub({ "https://assets.takeshape.io/p1/dev/a7/gone.png": () => new Response("no", { status: 403 }) });
	const media = openMedia(dir, { fetch: s.fetch });
	try {
		await assert.rejects(media.original("p1/dev/a7/gone.png"), /403/);
		// another URL of the same asset (imgix at another size) asks for the same original
		await assert.rejects(media.original("p1/dev/a7/gone.png"), /403/);
		assert.deepEqual(s.calls, ["https://assets.takeshape.io/p1/dev/a7/gone.png"]);
		assert.equal(media.downloaded, 0);
	} finally {
		media.close();
	}
});

test("openMedia: a project without the preload's ledger is a MediaError that says what to run", () => {
	const dir = mkdtempSync(join(tmpdir(), "compare-originals-"));
	dirs.push(dir);
	const ledger = join(dir, "takeshape", "takeshape-media.db");
	assert.throws(
		() => openMedia(dir),
		(e: unknown) => e instanceof MediaError && e.message === `No media ledger at ${ledger}. Run the converter with --preload-media local first, then compare with --media.`,
	);
});
