/**
 * An image's width and height from the first bytes of its file, for the image endpoint's files that are too large
 * to hand the Images binding (image-fetch.ts). The endpoint needs the size for exact output sizes (`layout` in
 * imgix.ts), and the binding's `.info()` refuses those files as it refuses `.input()`.
 *
 * Reads JPEG, PNG, GIF and WebP, which is what the endpoint transforms apart from AVIF (an Enterprise input on
 * Cloudflare). A JPEG's sides follow its EXIF orientation, as on Cloudflare (which applies the rotation, then
 * resizes) and in sharp (`autoOrient`); orientations 5 to 8 turn the image a quarter.
 */
import type { Size } from "./imgix.ts";

/** How much of a file `readImageSize` reads before it gives up: camera and Photoshop segments rarely pass 1 MB. */
const READ_LIMIT = 4 * 1024 * 1024;

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, text: string) => [...text].every((c, k) => b[i + k] === c.charCodeAt(0));
const size = (width: number, height: number): Size | null => (width > 0 && height > 0 ? { width, height } : null);

/**
 * The image's size, null when the bytes aren't an image it reads, or undefined while it needs more of the file.
 */
export function imageSize(head: Uint8Array): Size | null | undefined {
	if (head.length < 2) return undefined;
	if (head[0] === 0xff && head[1] === 0xd8) return jpegSize(head);
	if (head.length < 12) return undefined;
	if (head[0] === 0x89 && ascii(head, 1, "PNG\r\n\x1a\n")) return head.length < 24 ? undefined : ascii(head, 12, "IHDR") ? size(u32be(head, 16), u32be(head, 20)) : null;
	if (ascii(head, 0, "GIF8")) return size(u16le(head, 6), u16le(head, 8));
	if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) return webpSize(head);
	return null;
}

function u32be(b: Uint8Array, i: number): number {
	return ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
}

function webpSize(b: Uint8Array): Size | null | undefined {
	if (b.length < 30) return undefined;
	if (ascii(b, 12, "VP8 ")) return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? size(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff) : null;
	if (ascii(b, 12, "VP8L")) {
		if (b[20] !== 0x2f) return null;
		const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
		return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
	}
	if (ascii(b, 12, "VP8X")) return size(u24le(b, 24) + 1, u24le(b, 27) + 1);
	return null;
}

/** Start-of-frame markers, which carry the size: every SOFn but DHT (C4), JPG (C8) and DAC (CC). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(b: Uint8Array): Size | null | undefined {
	let orientation = 1;
	let i = 2;
	for (;;) {
		if (i + 4 > b.length) return undefined;
		if (b[i] !== 0xff) return null;
		const marker = b[i + 1]!;
		// Fill bytes, then markers without a length
		if (marker === 0xff) {
			i += 1;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2;
			continue;
		}
		// The scan or the end before any frame header
		if (marker === 0xda || marker === 0xd9) return null;
		const length = u16be(b, i + 2);
		if (length < 2) return null;
		if (SOF.has(marker)) {
			if (i + 9 > b.length) return undefined;
			const height = u16be(b, i + 5);
			const width = u16be(b, i + 7);
			return orientation >= 5 && orientation <= 8 ? size(height, width) : size(width, height);
		}
		if (marker === 0xe1 && orientation === 1) {
			if (i + 2 + length > b.length) return undefined;
			orientation = exifOrientation(b.subarray(i + 4, i + 2 + length)) ?? 1;
		}
		i += 2 + length;
	}
}

/** The Orientation tag of an APP1 segment's EXIF data ("Exif\0\0", then a TIFF header and IFD0), if it has one. */
function exifOrientation(data: Uint8Array): number | undefined {
	if (data.length < 14 || !ascii(data, 0, "Exif\0\0")) return undefined;
	const tiff = data.subarray(6);
	const le = ascii(tiff, 0, "II");
	if (!le && !ascii(tiff, 0, "MM")) return undefined;
	const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
	if (view.getUint16(2, le) !== 42) return undefined;
	const ifd = view.getUint32(4, le);
	if (ifd + 2 > tiff.length) return undefined;
	const entries = view.getUint16(ifd, le);
	for (let k = 0; k < entries; k++) {
		const at = ifd + 2 + k * 12;
		if (at + 12 > tiff.length) return undefined;
		// Orientation, a SHORT held in the entry itself
		if (view.getUint16(at, le) === 0x0112) return view.getUint16(at + 8, le);
	}
	return undefined;
}

/**
 * Reads `body` until `imageSize` can tell, then cancels the rest. Null for a file it can't read, or when `limit`
 * bytes didn't hold the size.
 */
export async function readImageSize(body: ReadableStream<Uint8Array>, limit = READ_LIMIT): Promise<Size | null> {
	const reader = body.getReader();
	let head = new Uint8Array(64 * 1024);
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (value?.length) {
				if (length + value.length > head.length) {
					const grown = new Uint8Array(Math.max(head.length * 2, length + value.length));
					grown.set(head.subarray(0, length));
					head = grown;
				}
				head.set(value, length);
				length += value.length;
			}
			const found = imageSize(head.subarray(0, length));
			if (found !== undefined) return found;
			if (done || length >= limit) return null;
		}
	} finally {
		reader.cancel().catch(() => {});
	}
}
