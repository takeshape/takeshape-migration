// Reads an image's size and a perceptual hash (dHash: 9x8 grayscale, 64 bits), so two files count as the
// same picture when their sizes match and their hashes are close. Each of the 9x8 cells is the mean of its
// area: a direct 9x8 resample of a large photo depends on where fine detail falls under the filter, and a
// recompressed copy (what images.takeshape.io served) flipped bits that way. Both are read as a browser shows
// them: turned by their EXIF orientation, transparent pixels on white.
import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import sharp from "sharp";

/**
 * What the compare knows about a picture: its size and its dHash. `version` is the hash's (HASH_VERSION when left
 * out): an image index keeps the version it was made with, and the new site's image is hashed the same way.
 */
export type ImageInfo = { width: number; height: number; hash: bigint; version?: number };

/**
 * 2 (2026-10-17): turned by the EXIF orientation, transparent pixels on white, cells within one gray level read as
 * equal, and the size follows the orientation. 1: the stored pixels as they are, grayscale only.
 */
export const HASH_VERSION = 2;

const cache = new Map<string, Promise<ImageInfo>>();

/** A hash as an image index stores it: 16 hex digits. */
export function hashHex(hash: bigint): string {
	return hash.toString(16).padStart(16, "0");
}

/**
 * An image index: a JSON object from image URL to { width, height, hash, version } with the hash in hex, as
 * writeImageIndex writes it. An entry without a version was made before there were versions: 1.
 * Throws on anything else, naming the URL.
 */
/** An old image from a saved index: its size and hash, or why it could not be read when the index was built. */
export type IndexedImage = ImageInfo | { error: string };

export function parseImageIndex(text: string): Map<string, IndexedImage> {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		throw new Error(`not JSON (${e instanceof Error ? e.message : String(e)})`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a JSON object from image URL to { width, height, hash }");
	const index = new Map<string, IndexedImage>();
	for (const [url, v] of Object.entries(raw)) {
		const e = v as { width?: unknown; height?: unknown; hash?: unknown; error?: unknown };
		if (e && typeof e === "object" && "error" in e) {
			if (typeof e.error !== "string" || !e.error) throw new Error(`${url} needs an error message`);
			index.set(url, { error: e.error });
			continue;
		}
		const size = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0;
		if (!e || typeof e !== "object" || !size(e.width) || !size(e.height)) throw new Error(`${url} needs a whole width and height`);
		if (typeof e.hash !== "string" || !/^[0-9a-f]{1,16}$/i.test(e.hash)) throw new Error(`${url} needs a hash of up to 16 hex digits`);
		const version = (v as { version?: unknown }).version ?? 1;
		if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > HASH_VERSION) throw new Error(`${url} has hash version ${String(version)}; this compare knows 1 to ${HASH_VERSION}`);
		index.set(url, { width: e.width as number, height: e.height as number, hash: BigInt(`0x${e.hash}`), version });
	}
	return index;
}

export function hashDistance(a: bigint, b: bigint): number {
	let x = a ^ b;
	let n = 0;
	while (x) {
		n += Number(x & 1n);
		x >>= 1n;
	}
	return n;
}

// Each cell of the 9x8 grid averages a CELL x CELL block of a (9 * CELL) x (8 * CELL) resample
const CELL = 10;
// A cell counts as brighter than its left neighbor only by more than one gray level: a sky's cells sit closer than
// that, and two encoders of one photo (imgix's JPEG, the endpoint's WebP) ordered them differently
const MARGIN = CELL * CELL;

export async function dHash(bytes: Uint8Array, version = HASH_VERSION): Promise<bigint> {
	const width = 9 * CELL;
	const shown = version >= 2 ? sharp(bytes).rotate().flatten({ background: "#ffffff" }) : sharp(bytes);
	const { data } = await shown.grayscale().resize(width, 8 * CELL, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
	const margin = version >= 2 ? MARGIN : 0;
	const cell = (cx: number, cy: number) => {
		let sum = 0;
		for (let y = cy * CELL; y < (cy + 1) * CELL; y++) for (let x = cx * CELL; x < (cx + 1) * CELL; x++) sum += data[y * width + x]!;
		return sum;
	};
	let hash = 0n;
	for (let y = 0; y < 8; y++) {
		for (let x = 0; x < 8; x++) {
			hash = (hash << 1n) | (cell(x, y) + margin < cell(x + 1, y) ? 1n : 0n);
		}
	}
	return hash;
}

async function load(url: string, timeoutMs: number, version: number, accept?: string) {
	const headers = accept === undefined ? undefined : { Accept: accept };
	const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers });
	if (!res.ok) throw new Error(`answered ${res.status}`);
	return imageOf(new Uint8Array(await res.arrayBuffer()), version);
}

/** An image's size as a browser shows it, from its header. Throws "not an image" when the size cannot be read. */
export function shownSize(bytes: Uint8Array, version = HASH_VERSION): { width: number; height: number } {
	try {
		const s = imageSize(bytes);
		if (!s.width || !s.height) throw new Error("no size");
		// EXIF orientations 5 to 8 turn the picture a quarter, so a browser shows it the other way round
		return version >= 2 && (s.orientation ?? 1) >= 5 ? { width: s.height, height: s.width } : { width: s.width, height: s.height };
	} catch {
		throw new Error("not an image");
	}
}

/** An image's size and hash from its bytes. Throws "not an image" when the size cannot be read. */
export async function imageOf(bytes: Uint8Array, version = HASH_VERSION): Promise<ImageInfo> {
	const size = shownSize(bytes, version);
	let hash: bigint;
	try {
		hash = await dHash(bytes, version);
	} catch {
		// A format sharp cannot decode: fall back to a hash of the bytes, so any change still shows.
		hash = createHash("sha256").update(bytes).digest().readBigUInt64BE(0);
	}
	return { ...size, hash, version };
}

/** An image's size and hash, fetched once per URL (and `Accept` header, when one is given). */
export function imageInfo(url: string, timeoutMs = 30_000, version = HASH_VERSION, accept?: string): Promise<ImageInfo> {
	const key = `${version} ${accept ?? ""} ${url}`;
	let p = cache.get(key);
	if (!p) {
		p = load(url, timeoutMs, version, accept);
		cache.set(key, p);
	}
	return p;
}

/**
 * An image index's text, which parseImageIndex reads: keys sorted, one tab per level, a newline at the end. An image
 * is written as { width, height, hash, version } with the hash in hex, an error as { error }, and an entry already in
 * a file's own form (a hash in hex) as it is, so an index written back keeps its old entries byte for byte.
 */
export function writeImageIndex(entries: Map<string, IndexedImage | Record<string, unknown>>): string {
	const out: Record<string, unknown> = {};
	for (const url of [...entries.keys()].sort()) {
		const e = entries.get(url)!;
		if ("hash" in e && typeof e.hash === "bigint") {
			const i = e as ImageInfo;
			out[url] = { width: i.width, height: i.height, hash: hashHex(i.hash), version: i.version ?? HASH_VERSION };
		} else out[url] = e;
	}
	return `${JSON.stringify(out, null, "\t")}\n`;
}
