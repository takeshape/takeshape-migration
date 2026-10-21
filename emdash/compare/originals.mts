/**
 * The originals of an old site's TakeShape images, for compare-sites --media: the compare makes each old image
 * from its original instead of asking TakeShape's CDN for it.
 *
 * The preload (ts2emdash --preload-media local) keeps a ledger, <project>/takeshape/takeshape-media.db, whose
 * takeshape_media_sources rows say where each source URL's file sits in <project>/uploads/. A row on
 * assets.takeshape.io holds the original. A row on images.takeshape.io (an asset missing from the export, which
 * the preload fetched from imgix) holds imgix's copy, so it doesn't count. An original the ledger lacks is
 * downloaded from assets.takeshape.io once, into <project>/takeshape/compare-originals/<asset path>, the layout
 * --download-assets writes, and read from there on later runs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ASSET_HOST = "assets.takeshape.io";
export const IMAGE_HOST = "images.takeshape.io";
const DEFAULT_TIMEOUT_MS = 60_000;

/** An original's bytes, and its content type from the file name's extension. */
export type Original = { bytes: Uint8Array<ArrayBuffer>; type: string };

export type LocalMedia = {
	/** The original of an asset path (as `takeshapeAssetPath` gives it). Rejects when it can't be had. */
	original(path: string): Promise<Original>;
	/** How many originals this run downloaded from assets.takeshape.io. */
	readonly downloaded: number;
	close(): void;
};

/** The project can't give the compare its originals: no ledger. */
export class MediaError extends Error {}

const TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	psd: "image/vnd.adobe.photoshop",
};

function typeOf(path: string): string {
	const dot = path.lastIndexOf(".");
	return (dot >= 0 && TYPES[path.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
}

/**
 * The asset path of a URL on TakeShape's image or asset host, decoded: `<project>/dev/<asset id>/<file>`. Null
 * for any other URL, and for one whose path isn't an asset's (a bare host, fewer than four segments).
 */
export function takeshapeAssetPath(url: URL): string | null {
	if (url.hostname !== ASSET_HOST && url.hostname !== IMAGE_HOST) return null;
	const segments = url.pathname.split("/").slice(1);
	if (segments.length < 4 || segments.some((s) => s === "")) return null;
	let decoded: string[];
	try {
		decoded = segments.map(decodeURIComponent);
	} catch {
		return null;
	}
	// The path names a file under the cache folder, so a segment may not step out of it or hide a separator
	if (decoded.some((s) => s === "." || s === ".." || /[/\\\0]/.test(s))) return null;
	return decoded.join("/");
}

/** Opens a project's originals: the preload's ledger and uploads/. Throws MediaError when there is no ledger. */
export function openMedia(projectDir: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): LocalMedia {
	const ledger = join(projectDir, "takeshape", "takeshape-media.db");
	if (!existsSync(ledger)) throw new MediaError(`No media ledger at ${ledger}. Run the converter with --preload-media local first, then compare with --media.`);
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// Asset path to storage key, for the rows that hold an original
	const stored = new Map<string, string>();
	const db = new DatabaseSync(ledger, { readOnly: true });
	try {
		const rows = db.prepare("SELECT source_url, storage_key FROM takeshape_media_sources").all() as Array<{ source_url: string; storage_key: string }>;
		for (const row of rows) {
			let url: URL;
			try {
				url = new URL(row.source_url);
			} catch {
				continue;
			}
			if (url.hostname !== ASSET_HOST) continue;
			const path = takeshapeAssetPath(url);
			if (path) stored.set(path, row.storage_key);
		}
	} finally {
		db.close();
	}

	const cacheDir = join(projectDir, "takeshape", "compare-originals");
	const tried = new Map<string, Promise<Original>>();
	let downloaded = 0;

	const read = (file: string, path: string): Original => ({ bytes: new Uint8Array(readFileSync(file)), type: typeOf(path) });

	async function download(path: string, file: string): Promise<Original> {
		const url = `https://${ASSET_HOST}/${path.split("/").map(encodeURIComponent).join("/")}`;
		const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) throw new Error(`${url} answered ${res.status}`);
		const bytes = new Uint8Array(await res.arrayBuffer());
		// Over HTTP/2 a stream can end early without an error, so the size has to match before the file counts
		const expected = Number(res.headers.get("content-length"));
		if (expected && !res.headers.get("content-encoding") && bytes.length !== expected) throw new Error(`${url} sent ${bytes.length} of ${expected} bytes`);
		mkdirSync(dirname(file), { recursive: true });
		const part = `${file}.part`;
		try {
			writeFileSync(part, bytes);
			renameSync(part, file);
		} catch (e) {
			rmSync(part, { force: true });
			throw e;
		}
		downloaded++;
		return { bytes, type: typeOf(path) };
	}

	return {
		original(path: string): Promise<Original> {
			const key = stored.get(path);
			if (key !== undefined) {
				const file = join(projectDir, "uploads", key);
				if (existsSync(file)) return Promise.resolve(read(file, path));
			}
			const file = join(cacheDir, ...path.split("/"));
			if (existsSync(file)) return Promise.resolve(read(file, path));
			// A download that worked lands in the cache folder and is read from there; one that failed stays failed
			// for the run, so every other URL of the same asset doesn't ask again
			let p = tried.get(path);
			if (!p) {
				p = download(path, file);
				p.then(() => tried.delete(path), () => {});
				tried.set(path, p);
			}
			return p;
		},
		get downloaded() {
			return downloaded;
		},
		close() {},
	};
}
