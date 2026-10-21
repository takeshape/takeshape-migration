#!/usr/bin/env node
/**
 * Offline end-to-end checks for --preload-media. Each scenario builds a small
 * export (test/synthetic-export.mts), runs the converter with fetch replaced
 * (test/fake-fetch.mts) and applies the seed with the emdash CLI, which runs
 * without the fake: any $media left in the seed shows up as a download.
 *
 *   node test/preload.mts                 every scenario
 *   node test/preload.mts <name> [...]    only those
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { FIELDS_ONLY, pngHeader, WITH_RICH_TEXT, writeSyntheticExport } from "./synthetic-export.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fakeFetch = pathToFileURL(join(root, "test", "fake-fetch.mts")).href;
const emdashPkg = join(root, "node_modules", "emdash");
const emdashCli = join(emdashPkg, JSON.parse(readFileSync(join(emdashPkg, "package.json"), "utf8")).bin.emdash);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logLines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

function convert(ws: string, extraArgs: string[] = [], env: Record<string, string> = {}, preload = true) {
	const log = env.FAKE_FETCH_LOG ?? join(ws, "fetch.log");
	const before = logLines(log).length;
	const res = spawnSync(
		process.execPath,
		[
			"--no-warnings",
			"--import",
			fakeFetch,
			"ts2emdash.mts",
			join(ws, "export"),
			"--out",
			join(ws, "seed.json"),
			"--report",
			join(ws, "report.md"),
			...(preload ? ["--preload-media", "local", "--database", join(ws, "data.db"), "--uploads-dir", join(ws, "uploads")] : []),
			...extraArgs,
		],
		{ cwd: root, encoding: "utf8", env: { ...process.env, FAKE_FETCH: "images", FAKE_FETCH_LOG: log, ...env } },
	);
	return { status: res.status, stdout: res.stdout, stderr: res.stderr, fetched: logLines(log).slice(before) };
}

function applySeed(ws: string) {
	const res = spawnSync(
		process.execPath,
		["--no-warnings", emdashCli, "seed", join(ws, "seed.json"), "--database", join(ws, "data.db"), "--uploads-dir", join(ws, "uploads"), "--on-conflict", "update"],
		{ cwd: root, encoding: "utf8" },
	);
	const out = res.stdout + res.stderr;
	return { status: res.status, out, downloads: (out.match(/Downloading/g) ?? []).length };
}

function rows<T = Record<string, unknown>>(dbFile: string, sql: string, ...params: (string | number)[]): T[] {
	const db = new DatabaseSync(dbFile, { readOnly: true });
	try {
		// node:sqlite returns null-prototype rows; spread them so deep equality compares values only
		return db.prepare(sql).all(...params).map((r) => ({ ...r }) as T);
	} finally {
		db.close();
	}
}

// What fake-fetch.mts serves in images mode
const IMAGE_BYTES = pngHeader(4, 3);
const FILE_BYTES = new Uint8Array(50_000);
const sha1 = (bytes: Uint8Array) => `sha1:${createHash("sha1").update(bytes).digest("hex")}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const show = (v: unknown) => JSON.stringify(v);

type Check = (ok: boolean, message: string) => void;

/** Every media value in the seed, in order: field values, and rich-text image blocks without their _key. */
function seedMediaValues(ws: string): unknown[] {
	const out: unknown[] = [];
	const walk = (v: unknown) => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (!v || typeof v !== "object") return;
		const o = v as Record<string, unknown>;
		if (o.provider === "local" && o.meta) return void out.push(o);
		if (o._type === "image" && (o.asset as Record<string, unknown> | undefined)?._type === "reference") {
			const { _key, ...rest } = o;
			return void out.push(rest);
		}
		Object.values(o).forEach(walk);
	};
	walk(JSON.parse(readFileSync(join(ws, "seed.json"), "utf8")).content);
	return out;
}

const mediaIds = (dbFile: string) => rows<{ id: string }>(dbFile, "SELECT id FROM media ORDER BY id").map((r) => r.id);
const fileList = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

const SOURCES_SQL = `SELECT s.source_key, s.storage_key, s.source_size, m.filename, m.mime_type, m.size, m.width, m.height, m.alt, m.status, m.content_hash
	FROM takeshape_media_sources s JOIN media m ON m.id = s.media_id ORDER BY s.source_key`;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarios: Record<string, (ws: string, check: Check) => void> = {
	"synthetic-export-converts"(ws, check) {
		writeSyntheticExport(join(ws, "export"), FIELDS_ONLY);
		const run = convert(ws, [], {}, false);
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const media = (readFileSync(join(ws, "seed.json"), "utf8").match(/"\$media"/g) ?? []).length;
		check(media === 4, `seed holds ${media} $media references (want 4)`);
		const apply = applySeed(ws);
		check(apply.status === 0, `emdash seed exited ${apply.status}`);
		check(/Content: 2 created/.test(apply.out), `emdash seed did not report "Content: 2 created": ${apply.out.match(/Content:.*/)?.[0] ?? "no Content line"}`);
	},

	// Rich text can link to PDFs on assets.takeshape.io. With the preload, each such file goes into the media library
	// with the rest, and the link points at its copy there.
	"rich-text-links-to-takeshape-files-move-into-the-media-library"(ws, check) {
		const url = "https://assets.takeshape.io/proj/dev/doc1/report%20one.pdf";
		// An image that links to a file, as a report's cover image can
		const brief = "https://assets.takeshape.io/proj/dev/doc3/brief.pdf";
		writeSyntheticExport(join(ws, "export"), {
			assets: [
				...FIELDS_ONLY.assets,
				{ id: "doc1", path: "proj/dev/doc1/report one.pdf", filename: "report one.pdf", mimeType: "application/pdf" },
				{ id: "doc3", path: "proj/dev/doc3/brief.pdf", filename: "brief.pdf", mimeType: "application/pdf" },
			],
			posts: [
				{
					id: "a",
					title: "A",
					slug: "a",
					story: {
						blocks: [
							{ key: "l1", text: "See the report.", type: "unstyled", depth: 0, inlineStyleRanges: [], entityRanges: [{ offset: 8, length: 6, key: 0 }], data: {} },
							{ key: "i1", text: " ", type: "atomic", depth: 0, inlineStyleRanges: [], entityRanges: [{ offset: 0, length: 1, key: 1 }], data: {} },
						],
						entityMap: {
							"0": { type: "LINK", mutability: "MUTABLE", data: { url } },
							"1": { type: "image", mutability: "IMMUTABLE", data: { id: "img1", link: { url: brief } } },
						},
					},
				},
			],
		});
		const run = convert(ws);
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		check(run.fetched.includes(url), `fetched ${show(run.fetched)}`);
		const seed = readFileSync(join(ws, "seed.json"), "utf8");
		check(seed.includes('"href": "/_emdash/api/media/file/ts-doc1.pdf"'), "the link does not point at the media library's copy");
		check(seed.includes('"href": "/_emdash/api/media/file/ts-doc3.pdf"'), "the image's link does not point at the media library's copy");
		check(!seed.includes("assets.takeshape.io/proj/dev/doc1"), "the seed still links to TakeShape's CDN");
		check(existsSync(join(ws, "uploads", "ts-doc1.pdf")), "the file is not in uploads/");
		const report = readFileSync(join(ws, "report.md"), "utf8");
		const linksSection = report.split("## Links to TakeShape-hosted files")[1]?.split("\n## ")[0] ?? "";
		check(!linksSection.includes("doc1"), "the report still lists the link as TakeShape-hosted");
		const apply = applySeed(ws);
		check(apply.status === 0 && apply.downloads === 0, `emdash seed exited ${apply.status} with ${apply.downloads} downloads`);
	},

	// A plain field can hold a TakeShape file URL as its whole value, and images in rich text can link to files there.
	// Those move too; a sized image URL keeps its parameters, which send it to the image endpoint.
	"takeshape-file-urls-in-fields-move-into-the-media-library"(ws, check) {
		const doc = "https://assets.takeshape.io/proj/dev/doc2/annual.pdf";
		const sized = "https://images.takeshape.io/proj/dev/img2/b.png?w=300&fit=crop";
		writeSyntheticExport(join(ws, "export"), {
			assets: [...FIELDS_ONLY.assets, { id: "doc2", path: "proj/dev/doc2/annual.pdf", filename: "annual.pdf", mimeType: "application/pdf" }],
			posts: [{ id: "a", title: "A", slug: "a" }],
		});
		// A plain string field holding the URL
		const schemaFile = join(ws, "export", "schema.json");
		const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
		schema.shapes.Post.schema.properties.url = { type: "string", title: "URL", "@mapping": "takeshape:local:Post.u" };
		schema.shapes.Post.schema.properties.thumb = { type: "string", title: "Thumb", "@mapping": "takeshape:local:Post.th" };
		writeFileSync(schemaFile, JSON.stringify(schema));
		const dataFile = join(ws, "export", "data.jsonl");
		writeFileSync(dataFile, readFileSync(dataFile, "utf8").replace('"_id":"a",', `"_id":"a","u":"${doc}","th":"${sized}",`));
		const run = convert(ws);
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const entry = JSON.parse(readFileSync(join(ws, "seed.json"), "utf8")).content.posts.find((e: { id: string }) => e.id === "ts-a");
		check(entry?.data.url === "/_emdash/api/media/file/ts-doc2.pdf", `url is ${show(entry?.data.url)}`);
		// The media file with imgix's parameters, which the site's middleware sends to its image endpoint. A storage key
		// percent-encoded inside an endpoint URL fails EmDash's site export (TRANSFER_MEDIA_REF_INVALID)
		check(entry?.data.thumb === "/_emdash/api/media/file/ts-img2.png?w=300&fit=crop", `thumb is ${show(entry?.data.thumb)}`);
		check(existsSync(join(ws, "uploads", "ts-doc2.pdf")), "the file is not in uploads/");
		const report = readFileSync(join(ws, "report.md"), "utf8");
		check(!report.includes("doc2"), "the report still lists the moved URL");
	},

	// Without the preload nothing moves, and the report lists field values too, not only rich-text links
	"takeshape-file-urls-in-fields-are-reported-without-the-preload"(ws, check) {
		const doc = "https://assets.takeshape.io/proj/dev/doc2/annual.pdf";
		writeSyntheticExport(join(ws, "export"), { assets: FIELDS_ONLY.assets, posts: [{ id: "a", title: "A", slug: "a" }] });
		const schemaFile = join(ws, "export", "schema.json");
		const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
		schema.shapes.Post.schema.properties.url = { type: "string", title: "URL", "@mapping": "takeshape:local:Post.u" };
		writeFileSync(schemaFile, JSON.stringify(schema));
		const dataFile = join(ws, "export", "data.jsonl");
		writeFileSync(dataFile, readFileSync(dataFile, "utf8").replace('"_id":"a",', `"_id":"a","u":"${doc}",`));
		const run = convert(ws, [], {}, false);
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const report = readFileSync(join(ws, "report.md"), "utf8");
		const linksSection = report.split("## Links to TakeShape-hosted files")[1]?.split("\n## ")[0] ?? "";
		check(linksSection.includes(doc), "the report does not list the field's TakeShape URL");
	},

	"preload-writes-files-and-ledger"(ws, check) {
		writeSyntheticExport(join(ws, "export"), FIELDS_ONLY);
		const run = convert(ws);
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const wantUrls = [
			"https://assets.takeshape.io/proj/dev/img1/photo%20one.jpg",
			"https://assets.takeshape.io/proj/dev/img2/b.png",
			"https://assets.takeshape.io/proj/dev/pdf1/brochure.pdf",
		];
		check(isDeepStrictEqual([...run.fetched].sort(), wantUrls), `fetched ${show(run.fetched)}`);
		const ledger = join(ws, "takeshape-media.db");
		if (!existsSync(ledger)) return check(false, "no ledger at takeshape-media.db");
		const got = rows(ledger, SOURCES_SQL);
		const want = [
			{ source_key: "asset:img1", storage_key: "ts-img1.jpg", source_size: 45, filename: "photo one.jpg", mime_type: "image/jpeg", size: 45, width: 4, height: 3, alt: "Photo one", status: "ready", content_hash: sha1(IMAGE_BYTES) },
			{ source_key: "asset:img2", storage_key: "ts-img2.png", source_size: 45, filename: "b.png", mime_type: "image/png", size: 45, width: 4, height: 3, alt: null, status: "ready", content_hash: sha1(IMAGE_BYTES) },
			{ source_key: "asset:pdf1", storage_key: "ts-pdf1.pdf", source_size: 50000, filename: "brochure.pdf", mime_type: "application/pdf", size: 50000, width: null, height: null, alt: null, status: "ready", content_hash: sha1(FILE_BYTES) },
		];
		check(isDeepStrictEqual(got, want), `ledger rows\n         got  ${show(got)}\n         want ${show(want)}`);
		const files = existsSync(join(ws, "uploads")) ? readdirSync(join(ws, "uploads")).sort() : [];
		check(isDeepStrictEqual(files, ["ts-img1.jpg", "ts-img2.png", "ts-pdf1.pdf"]), `uploads holds ${show(files)}`);
		for (const [file, bytes] of [["ts-img1.jpg", IMAGE_BYTES], ["ts-img2.png", IMAGE_BYTES], ["ts-pdf1.pdf", FILE_BYTES]] as const) {
			const path = join(ws, "uploads", file);
			check(existsSync(path) && Buffer.compare(readFileSync(path), Buffer.from(bytes)) === 0, `${file} does not hold the served bytes`);
		}
	},

	"unsafe-asset-ids"(ws, check) {
		writeSyntheticExport(join(ws, "export"), {
			assets: [
				{ id: "x:1", path: "proj/dev/x1/a.png", filename: "a.png", mimeType: "image/png" },
				{ id: "x_1", path: "proj/dev/x_1/b.png", filename: "b.png", mimeType: "image/png" },
			],
			posts: [{ id: "p", title: "P", slug: "p", gallery: ["x:1", "x_1"] }],
		});
		const run = convert(ws);
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const ledger = join(ws, "takeshape-media.db");
		if (!existsSync(ledger)) return check(false, "no ledger at takeshape-media.db");
		const keys = Object.fromEntries(rows<{ source_key: string; storage_key: string }>(ledger, "SELECT source_key, storage_key FROM takeshape_media_sources").map((r) => [r.source_key, r.storage_key]));
		const want = { "asset:x:1": `ts-x_1-${sha256("x:1").slice(0, 8)}.png`, "asset:x_1": "ts-x_1.png" };
		check(isDeepStrictEqual(keys, want), `storage keys ${show(keys)}, want ${show(want)}`);
		for (const key of Object.values(want)) check(existsSync(join(ws, "uploads", key)), `missing file ${key}`);
		const media = rows<{ n: number }>(ledger, "SELECT count(*) AS n FROM media")[0].n;
		check(media === 2, `ledger holds ${media} media rows (want 2)`);
	},

	"seed-points-at-preloaded-media"(ws, check) {
		writeSyntheticExport(join(ws, "export"), FIELDS_ONLY);
		const run = convert(ws);
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const ledger = join(ws, "takeshape-media.db");
		const db = join(ws, "data.db");
		if (!existsSync(ledger) || !existsSync(db)) return check(false, `missing ${existsSync(ledger) ? "data.db" : "takeshape-media.db"}`);
		const keyed = "SELECT id, storage_key FROM media ORDER BY storage_key";
		const inLedger = rows(ledger, `SELECT m.id, m.storage_key FROM media m JOIN takeshape_media_sources s ON s.media_id = m.id ORDER BY m.storage_key`);
		check(isDeepStrictEqual(rows(db, keyed), inLedger), `data.db media ${show(rows(db, keyed))}, ledger ${show(inLedger)}`);
		check(!readFileSync(join(ws, "seed.json"), "utf8").includes('"$media"'), "seed still holds $media");
		const apply = applySeed(ws);
		check(apply.status === 0 && apply.downloads === 0, `emdash seed exited ${apply.status} with ${apply.downloads} download(s)`);
		const id = Object.fromEntries(inLedger.map((r) => [r.storage_key, r.id]));
		const post = rows<{ gallery: string; brochure: string }>(db, "SELECT gallery, brochure FROM ec_posts WHERE slug = 'post-a'")[0];
		const gallery = [
			{ image: { provider: "local", id: id["ts-img1.jpg"], alt: "Photo one", width: 4, height: 3, mimeType: "image/jpeg", filename: "photo one.jpg", meta: { storageKey: "ts-img1.jpg", title: "Photo one" } } },
			{ image: { provider: "local", id: id["ts-img2.png"], width: 4, height: 3, mimeType: "image/png", filename: "b.png", meta: { storageKey: "ts-img2.png" } } },
		];
		const brochure = { provider: "local", id: id["ts-pdf1.pdf"], mimeType: "application/pdf", filename: "brochure.pdf", meta: { storageKey: "ts-pdf1.pdf" } };
		check(isDeepStrictEqual(JSON.parse(post?.gallery ?? "null"), gallery), `post-a gallery ${post?.gallery}`);
		check(isDeepStrictEqual(JSON.parse(post?.brochure ?? "null"), brochure), `post-a brochure ${post?.brochure}`);
		const report = readFileSync(join(ws, "report.md"), "utf8");
		check(report.includes("## Media preload") && report.includes("3 sources: 3 downloaded this run"), `report lacks the Media preload section or its counts`);
	},

	"existing-media-warning"(ws, check) {
		writeSyntheticExport(join(ws, "export"), FIELDS_ONLY);
		convert(ws);
		const db = join(ws, "data.db");
		if (!existsSync(db)) return check(false, "first run wrote no data.db");
		const sqlite = new DatabaseSync(db);
		sqlite.prepare("INSERT INTO media (id, filename, mime_type, storage_key, status) VALUES ('01FOREIGN', 'old.jpg', 'image/jpeg', 'old.jpg', 'ready')").run();
		sqlite.close();
		convert(ws);
		const want = `\`${db}\` already holds 1 media row(s) that this preload did not create, probably from an earlier import without --preload-media. For a clean result, delete \`${db}\` and run the converter again.`;
		check(readFileSync(join(ws, "report.md"), "utf8").includes(want), `report lacks: ${want}`);
	},

	"rich-text-and-url-sources"(ws, check) {
		writeSyntheticExport(join(ws, "export"), WITH_RICH_TEXT);
		const run = convert(ws);
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const ledger = join(ws, "takeshape-media.db");
		const db = join(ws, "data.db");
		if (!existsSync(ledger) || !existsSync(db)) return check(false, `missing ${existsSync(ledger) ? "data.db" : "takeshape-media.db"}`);
		const orphanUrl = "https://images.takeshape.io/proj/dev/orphan/orphan.jpg";
		const sources = rows<{ source_key: string; storage_key: string; media_id: string; filename: string }>(
			ledger,
			"SELECT s.source_key, s.storage_key, s.media_id, m.filename FROM takeshape_media_sources s JOIN media m ON m.id = s.media_id ORDER BY s.source_key",
		);
		const keys = sources.map((s) => s.source_key);
		check(isDeepStrictEqual(keys, ["asset:img1", "asset:img2", "asset:pdf1", `url:${orphanUrl}`]), `ledger sources ${show(keys)}`);
		check(!run.fetched.some((u) => u.includes("images.takeshape.io/proj/dev/img2")), `img2 fetched from images.takeshape.io: ${show(run.fetched)}`);
		const orphan = sources.find((s) => s.source_key === `url:${orphanUrl}`);
		const orphanKey = `ts-url-${sha256(orphanUrl).slice(0, 16)}.jpg`;
		check(orphan?.storage_key === orphanKey && orphan?.filename === "orphan.jpg", `orphan source ${show(orphan)}, want key ${orphanKey}`);
		const media = rows<{ n: number }>(db, "SELECT count(*) AS n FROM media")[0].n;
		check(media === 4, `data.db holds ${media} media rows (want 4)`);
		const apply = applySeed(ws);
		check(apply.status === 0 && apply.downloads === 0, `emdash seed exited ${apply.status} with ${apply.downloads} download(s)`);
		const id = (key: string) => sources.find((s) => s.source_key === key)?.media_id;
		const galleryOf = (slug: string) => JSON.parse(rows<{ gallery: string }>(db, "SELECT gallery FROM ec_posts WHERE slug = ?", slug)[0]?.gallery ?? "[]");
		check(galleryOf("post-b")[0]?.image?.id === id("asset:img1") && galleryOf("post-a")[0]?.image?.id === id("asset:img1"), "post-a and post-b galleries do not share img1's media row");
		const body = JSON.parse(rows<{ body: string }>(db, "SELECT body FROM ec_posts WHERE slug = 'post-a'")[0]?.body ?? "[]") as Record<string, unknown>[];
		const images = body.filter((b) => b._type === "image").map(({ _key, ...rest }) => rest);
		const want = [
			{ _type: "image", asset: { _type: "reference", _ref: id("asset:img2"), url: "/_emdash/api/media/file/ts-img2.png", provider: "local" }, alt: "Small b", width: 4, height: 3 },
			{ _type: "image", asset: { _type: "reference", _ref: orphan?.media_id, url: `/_emdash/api/media/file/${orphanKey}`, provider: "local" }, alt: "Orphan", width: 4, height: 3 },
		];
		check(isDeepStrictEqual(images, want), `post-a body images\n         got  ${show(images)}\n         want ${show(want)}`);
	},

	"rerun-fetches-nothing"(ws, check) {
		writeSyntheticExport(join(ws, "export"), WITH_RICH_TEXT);
		convert(ws);
		const first = seedMediaValues(ws);
		const again = convert(ws);
		check(again.status === 0, `second run exited ${again.status}: ${again.stderr.trim()}`);
		check(again.fetched.length === 0, `second run fetched ${show(again.fetched)}`);
		check(mediaIds(join(ws, "data.db")).length === 4, `data.db holds ${mediaIds(join(ws, "data.db")).length} media rows (want 4)`);
		check(fileList(join(ws, "uploads")).length === 4, `uploads holds ${show(fileList(join(ws, "uploads")))}`);
		check(first.length > 0 && isDeepStrictEqual(seedMediaValues(ws), first), "media values changed between runs");
	},

	"clean-redo-restores-rows"(ws, check) {
		writeSyntheticExport(join(ws, "export"), WITH_RICH_TEXT);
		const db = join(ws, "data.db");
		convert(ws);
		applySeed(ws);
		const ids = mediaIds(db);
		const galleryBefore = rows<{ gallery: string }>(db, "SELECT gallery FROM ec_posts WHERE slug = 'post-a'")[0]?.gallery;
		for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
		const again = convert(ws);
		check(again.fetched.length === 0, `redo fetched ${show(again.fetched)}`);
		check(isDeepStrictEqual(mediaIds(db), ids), `media ids after redo ${show(mediaIds(db))}, before ${show(ids)}`);
		const apply = applySeed(ws);
		check(apply.status === 0 && apply.downloads === 0, `emdash seed exited ${apply.status} with ${apply.downloads} download(s)`);
		const galleryAfter = rows<{ gallery: string }>(db, "SELECT gallery FROM ec_posts WHERE slug = 'post-a'")[0]?.gallery;
		check(Boolean(galleryBefore) && isDeepStrictEqual(JSON.parse(galleryAfter ?? "null"), JSON.parse(galleryBefore ?? "null")), `gallery after redo ${galleryAfter}`);
	},

	"missing-file-reuploaded"(ws, check) {
		writeSyntheticExport(join(ws, "export"), WITH_RICH_TEXT);
		convert(ws);
		const ids = mediaIds(join(ws, "data.db"));
		rmSync(join(ws, "uploads", "ts-img2.png"), { force: true });
		const again = convert(ws);
		check(isDeepStrictEqual(again.fetched, ["https://assets.takeshape.io/proj/dev/img2/b.png"]), `second run fetched ${show(again.fetched)}`);
		check(existsSync(join(ws, "uploads", "ts-img2.png")), "ts-img2.png was not restored");
		check(isDeepStrictEqual(mediaIds(join(ws, "data.db")), ids), "media ids changed");
	},

	"changed-path-refreshes-file"(ws, check) {
		writeSyntheticExport(join(ws, "export"), WITH_RICH_TEXT);
		convert(ws);
		const ledger = join(ws, "takeshape-media.db");
		const before = rows(ledger, "SELECT media_id, storage_key FROM takeshape_media_sources WHERE source_key = 'asset:img1'")[0];
		writeSyntheticExport(join(ws, "export"), {
			...WITH_RICH_TEXT,
			assets: WITH_RICH_TEXT.assets.map((a) => (a.id === "img1" ? { ...a, path: "proj/dev/img1-v2/photo one.jpg" } : a)),
		});
		const again = convert(ws);
		const newUrl = "https://assets.takeshape.io/proj/dev/img1-v2/photo%20one.jpg";
		check(isDeepStrictEqual(again.fetched, [newUrl]), `second run fetched ${show(again.fetched)}`);
		const after = rows(ledger, "SELECT media_id, storage_key, source_url FROM takeshape_media_sources WHERE source_key = 'asset:img1'")[0];
		check(after?.source_url === newUrl, `source_url is ${after?.source_url}`);
		check(after?.media_id === before?.media_id && after?.storage_key === "ts-img1.jpg", `img1 row ${show(after)}, before ${show(before)}`);
		check(readFileSync(join(ws, "report.md"), "utf8").includes("1 refreshed"), "report does not count 1 refreshed");
	},

	"changed-title-updates-alt"(ws, check) {
		writeSyntheticExport(join(ws, "export"), WITH_RICH_TEXT);
		convert(ws);
		writeSyntheticExport(join(ws, "export"), {
			...WITH_RICH_TEXT,
			assets: WITH_RICH_TEXT.assets.map((a) => (a.id === "img2" ? { ...a, title: "Bee" } : a)),
		});
		const again = convert(ws);
		check(again.fetched.length === 0, `second run fetched ${show(again.fetched)}`);
		const altOf = (dbFile: string) => rows<{ alt: string | null }>(dbFile, "SELECT alt FROM media WHERE storage_key = 'ts-img2.png'")[0]?.alt;
		check(altOf(join(ws, "takeshape-media.db")) === "Bee" && altOf(join(ws, "data.db")) === "Bee", `img2 alt: ledger ${altOf(join(ws, "takeshape-media.db"))}, data.db ${altOf(join(ws, "data.db"))}`);
		const seed = JSON.parse(readFileSync(join(ws, "seed.json"), "utf8"));
		const postA = (seed.content.posts as { data: { slug?: string; gallery?: { image: { alt?: string } }[] }; slug?: string }[]).find((e) => e.slug === "post-a");
		check(postA?.data.gallery?.[1]?.image?.alt === "Bee", `seed img2 gallery value ${show(postA?.data.gallery?.[1])}`);
	},

	"killed-mid-run-resumes"(ws, check) {
		writeSyntheticExport(join(ws, "export"), WITH_RICH_TEXT);
		// One download at a time, so exactly two sources finish before the kill
		const killed = convert(ws, ["--media-concurrency", "1"], { FAKE_FETCH_EXIT_AFTER: "2" });
		check(killed.status !== 0, "first run was not killed");
		const again = convert(ws);
		check(again.status === 0, `second run exited ${again.status}: ${again.stderr.trim()}`);
		check(again.fetched.length === 2, `second run fetched ${show(again.fetched)} (want the 2 unfinished sources)`);
		const ledger = join(ws, "takeshape-media.db");
		const sources = rows<{ n: number }>(ledger, "SELECT count(*) AS n FROM takeshape_media_sources")[0].n;
		check(sources === 4, `ledger holds ${sources} sources (want 4)`);
		check(mediaIds(join(ws, "data.db")).length === 4, `data.db holds ${mediaIds(join(ws, "data.db")).length} media rows (want 4)`);
		const keys = rows<{ storage_key: string }>(ledger, "SELECT storage_key FROM takeshape_media_sources ORDER BY storage_key").map((r) => r.storage_key);
		check(isDeepStrictEqual(fileList(join(ws, "uploads")), keys), `uploads holds ${show(fileList(join(ws, "uploads")))}, ledger keys ${show(keys)}`);
	},

	"permanent-failure-dropped-and-reported"(ws, check) {
		writeSyntheticExport(join(ws, "export"), WITH_RICH_TEXT);
		const orphanUrl = "https://images.takeshape.io/proj/dev/orphan/orphan.jpg";
		const run = convert(ws, [], { FAKE_FETCH_404: "orphan" });
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const sources = rows<{ n: number }>(join(ws, "takeshape-media.db"), "SELECT count(*) AS n FROM takeshape_media_sources")[0].n;
		check(sources === 3, `ledger holds ${sources} sources (want 3)`);
		check(run.fetched.filter((u) => u === orphanUrl).length === 1, `orphan fetched ${run.fetched.filter((u) => u === orphanUrl).length} time(s) (want 1)`);
		const seedText = readFileSync(join(ws, "seed.json"), "utf8");
		check(!seedText.includes('"$media"'), "seed still holds $media");
		const bodyImages = () => {
			const seed = JSON.parse(readFileSync(join(ws, "seed.json"), "utf8"));
			const postA = (seed.content.posts as { slug?: string; data: { body?: { _type: string }[] } }[]).find((e) => e.slug === "post-a");
			return (postA?.data.body ?? []).filter((b) => b._type === "image").length;
		};
		check(bodyImages() === 1, `post-a body has ${bodyImages()} image block(s) (want 1)`);
		const report = readFileSync(join(ws, "report.md"), "utf8");
		check(report.includes(`${orphanUrl} could not be preloaded (HTTP 404)`) && report.includes("posts/post-a"), "report does not name the orphan failure and where it is used");
		const again = convert(ws);
		check(isDeepStrictEqual(again.fetched, [orphanUrl]), `retry run fetched ${show(again.fetched)}`);
		check(bodyImages() === 2, `after the retry run post-a body has ${bodyImages()} image block(s) (want 2)`);
	},

	"all-downloads-die"(ws, check) {
		writeSyntheticExport(join(ws, "export"), FIELDS_ONLY);
		const run = convert(ws, [], { FAKE_FETCH: "broken" });
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const sources = rows<{ n: number }>(join(ws, "takeshape-media.db"), "SELECT count(*) AS n FROM takeshape_media_sources")[0].n;
		check(sources === 0, `ledger holds ${sources} sources (want 0)`);
		check(fileList(join(ws, "uploads")).length === 0, `uploads holds ${show(fileList(join(ws, "uploads")))}`);
		const seed = JSON.parse(readFileSync(join(ws, "seed.json"), "utf8"));
		const postA = (seed.content.posts as { slug?: string; data: Record<string, unknown> }[]).find((e) => e.slug === "post-a");
		check(isDeepStrictEqual(postA?.data.gallery, []) && !("brochure" in (postA?.data ?? {})), `post-a data ${show(postA?.data)}`);
		const failures = (readFileSync(join(ws, "report.md"), "utf8").match(/could not be preloaded/g) ?? []).length;
		check(failures === 3, `report lists ${failures} failed source(s) (want 3)`);
	},

	"transient-errors-retried"(ws, check) {
		writeSyntheticExport(join(ws, "export"), FIELDS_ONLY);
		const run = convert(ws, [], { FAKE_FETCH_FLAKY: "1" });
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const sources = rows<{ n: number }>(join(ws, "takeshape-media.db"), "SELECT count(*) AS n FROM takeshape_media_sources")[0].n;
		check(sources === 3, `ledger holds ${sources} sources (want 3)`);
		const counts = [...new Set(run.fetched)].map((u) => run.fetched.filter((x) => x === u).length);
		check(counts.length === 3 && counts.every((n) => n === 2), `fetch log ${show(run.fetched)}`);
	},

	"downloads-run-in-parallel"(ws, check) {
		const spec = {
			assets: Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, path: `proj/dev/p${i}/img${i}.jpg`, filename: `img${i}.jpg`, mimeType: "image/jpeg" })),
			posts: [{ id: "a", title: "Post A", slug: "post-a", gallery: Array.from({ length: 20 }, (_, i) => `i${i}`) }],
		};
		for (const [dir, args, want] of [["eight", [], 8], ["two", ["--media-concurrency", "2"], 2]] as const) {
			const sub = join(ws, dir);
			writeSyntheticExport(join(sub, "export"), spec);
			const stats = join(sub, "stats.json");
			const run = convert(sub, [...args], { FAKE_FETCH_DELAY_MS: "100", FAKE_FETCH_STATS: stats });
			check(run.status === 0, `${dir}: converter exited ${run.status}: ${run.stderr.trim()}`);
			const maxInFlight = existsSync(stats) ? JSON.parse(readFileSync(stats, "utf8")).maxInFlight : null;
			check(maxInFlight === want, `${dir}: at most ${maxInFlight} downloads at once (want ${want})`);
			check(run.stdout.includes("✔ Preloaded 20 images and files"), `${dir}: stdout lacks the preload summary: ${run.stdout.trim()}`);
		}
	},

	"large-project-hint"(ws, check) {
		for (const count of [1001, 1000]) {
			const sub = join(ws, String(count));
			writeSyntheticExport(join(sub, "export"), {
				assets: Array.from({ length: count }, (_, i) => ({ id: `i${i}`, path: `proj/dev/p${i}/img${i}.jpg`, filename: `img${i}.jpg`, mimeType: "image/jpeg" })),
				posts: [{ id: "a", title: "Post A", slug: "post-a", gallery: Array.from({ length: count }, (_, i) => `i${i}`) }],
			});
			const run = convert(sub, [], {}, false);
			check(run.status === 0, `${count}: converter exited ${run.status}: ${run.stderr.trim()}`);
			const hinted = run.stdout.includes("This project uses 1,001 images and files. For a faster import that is safe to rerun, add --preload-media local.");
			check(count === 1001 ? hinted : !run.stdout.includes("This project uses"), `${count}: stdout ${hinted ? "has" : "lacks"} the hint: ${run.stdout.trim()}`);
		}
	},

	"short-body-retried"(ws, check) {
		writeSyntheticExport(join(ws, "export"), FIELDS_ONLY);
		const run = convert(ws, [], { FAKE_FETCH_SHORT: "1" });
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const got = rows<{ source_key: string; source_size: number; size: number }>(join(ws, "takeshape-media.db"), SOURCES_SQL).map((r) => [r.source_key, r.source_size, r.size]);
		const want = [["asset:img1", 45, 45], ["asset:img2", 45, 45], ["asset:pdf1", 50000, 50000]];
		check(isDeepStrictEqual(got, want), `ledger sizes ${show(got)}, want ${show(want)}`);
		const counts = [...new Set(run.fetched)].map((u) => run.fetched.filter((x) => x === u).length);
		check(counts.length === 3 && counts.every((n) => n === 2), `fetch log ${show(run.fetched)}`);
		for (const [file, bytes] of [["ts-img1.jpg", IMAGE_BYTES], ["ts-pdf1.pdf", FILE_BYTES]] as const) {
			const path = join(ws, "uploads", file);
			check(existsSync(path) && Buffer.compare(readFileSync(path), Buffer.from(bytes)) === 0, `${file} does not hold the whole served file`);
		}
	},

	"short-body-never-stored"(ws, check) {
		writeSyntheticExport(join(ws, "export"), FIELDS_ONLY);
		const run = convert(ws, [], { FAKE_FETCH_SHORT: "9" });
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const sources = rows<{ n: number }>(join(ws, "takeshape-media.db"), "SELECT count(*) AS n FROM takeshape_media_sources")[0].n;
		check(sources === 0, `ledger holds ${sources} sources (want 0)`);
		check(fileList(join(ws, "uploads")).length === 0, `uploads holds ${show(fileList(join(ws, "uploads")))}`);
		const report = readFileSync(join(ws, "report.md"), "utf8");
		check(report.includes("could not be preloaded (got 22 of 45 bytes)"), "report does not say the image came back short");
	},

	"partial-file-redownloaded"(ws, check) {
		writeSyntheticExport(join(ws, "export"), FIELDS_ONLY);
		convert(ws);
		// What a re-upload killed mid-write, or a full disk, leaves behind: the row says ready, the file is short
		const pdf = join(ws, "uploads", "ts-pdf1.pdf");
		truncateSync(pdf, 25_000);
		const again = convert(ws);
		check(isDeepStrictEqual(again.fetched, ["https://assets.takeshape.io/proj/dev/pdf1/brochure.pdf"]), `second run fetched ${show(again.fetched)}`);
		check(existsSync(pdf) && statSync(pdf).size === 50_000, `ts-pdf1.pdf is ${existsSync(pdf) ? statSync(pdf).size : 0} bytes (want 50000)`);
	},

	"copies-only-used-rows"(ws, check) {
		writeSyntheticExport(join(ws, "export"), WITH_RICH_TEXT);
		convert(ws);
		const db = join(ws, "data.db");
		const redo = () => {
			for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
		};
		const keys = () => rows<{ storage_key: string }>(db, "SELECT storage_key FROM media ORDER BY storage_key").map((r) => r.storage_key);
		// The content stops using the orphan image: a clean redo must not bring its row back
		writeSyntheticExport(join(ws, "export"), {
			...WITH_RICH_TEXT,
			posts: WITH_RICH_TEXT.posts.map((p) => (p.id === "a" ? { ...p, body: "Intro\n\n![Small b](https://images.takeshape.io/proj/dev/img2/b.png?w=300)" } : p)),
		});
		redo();
		convert(ws);
		check(isDeepStrictEqual(keys(), ["ts-img1.jpg", "ts-img2.png", "ts-pdf1.pdf"]), `after dropping the orphan, data.db holds ${show(keys())}`);
		// img2's file is gone and its download fails: its row must not reach data.db without a file
		redo();
		rmSync(join(ws, "uploads", "ts-img2.png"), { force: true });
		convert(ws, [], { FAKE_FETCH_404: "img2" });
		check(isDeepStrictEqual(keys(), ["ts-img1.jpg", "ts-pdf1.pdf"]), `with img2 failing, data.db holds ${show(keys())}`);
	},

	"missing-content-type"(ws, check) {
		writeSyntheticExport(join(ws, "export"), FIELDS_ONLY);
		const run = convert(ws, [], { FAKE_FETCH_TYPE: "none" });
		check(run.status === 0, `converter exited ${run.status}: ${run.stderr.trim()}`);
		const ledger = join(ws, "takeshape-media.db");
		if (!existsSync(ledger)) return check(false, "no ledger at takeshape-media.db");
		const img1 = rows(ledger, SOURCES_SQL).find((r) => r.source_key === "asset:img1");
		check(img1?.mime_type === "image/jpeg" && img1?.width === 4, `img1 row ${show(img1)}`);
	},
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const only = process.argv.slice(2);
const unknown = only.filter((n) => !(n in scenarios));
if (unknown.length) {
	console.error(`Unknown scenario(s): ${unknown.join(", ")}`);
	process.exit(1);
}
let failures = 0;
for (const [name, run] of Object.entries(scenarios)) {
	if (only.length && !only.includes(name)) continue;
	const ws = mkdtempSync(join(tmpdir(), `ts2emdash-preload-${name}-`));
	const problems: string[] = [];
	try {
		run(ws, (ok, message) => {
			if (!ok) problems.push(message);
		});
	} catch (e) {
		problems.push(`threw: ${(e as Error).stack ?? e}`);
	}
	console.log(`${problems.length ? "FAIL" : "ok  "} ${name}`);
	for (const p of problems) console.log(`       ${p}`);
	if (problems.length) {
		failures++;
		console.log(`       workspace kept in ${ws}`);
	} else rmSync(ws, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
