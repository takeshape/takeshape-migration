// An image's size from the first bytes of its file (runtime/image-header.ts), which the image endpoint reads for
// files too large for Cloudflare's Images binding. Offline; sharp makes the images.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import sharp from "sharp";
import { imageSize, readImageSize } from "../../tsg2astro/runtime/image-header.ts";

const assets = new URL("./sites/shape-books/assets/00000006-0000-4000-8000-000000000006/dev/", import.meta.url);
const asset = (path: string) => new Uint8Array(readFileSync(new URL(path, assets)));

/** A 300x200 test card: red on the left, blue on the right. */
const card = () => sharp({ create: { width: 300, height: 200, channels: 3, background: "#ff0000" } }).composite([{ input: { create: { width: 150, height: 200, channels: 3, background: "#0000ff" } }, left: 150, top: 0 }]);
const bytes = async (image: ReturnType<typeof sharp>) => new Uint8Array(await image.toBuffer());

/** A JPEG segment: marker, length, data. */
function segment(marker: number, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + data.length);
	out.set([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]);
	out.set(data, 4);
	return out;
}

/** `jpeg` with `segments` right after its start marker, where cameras put EXIF and ICC profiles. */
function withSegments(jpeg: Uint8Array, ...segments: Uint8Array[]): Uint8Array {
	const parts = [jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** An EXIF APP1 segment holding only an orientation, in big-endian (MM) or little-endian (II) byte order. */
function exifOrientation(orientation: number, order: "MM" | "II"): Uint8Array {
	const tiff = new DataView(new ArrayBuffer(26));
	const le = order === "II";
	tiff.setUint8(0, order.charCodeAt(0));
	tiff.setUint8(1, order.charCodeAt(1));
	tiff.setUint16(2, 42, le);
	tiff.setUint32(4, 8, le); // IFD0 right after the header
	tiff.setUint16(8, 1, le); // one entry
	tiff.setUint16(10, 0x0112, le); // Orientation
	tiff.setUint16(12, 3, le); // SHORT
	tiff.setUint32(14, 1, le);
	tiff.setUint16(18, orientation, le);
	tiff.setUint32(22, 0, le); // no next IFD
	const data = new Uint8Array(6 + 26);
	data.set([0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"
	data.set(new Uint8Array(tiff.buffer), 6);
	return segment(0xe1, data);
}

/** A stream of `data` in chunks of `size` bytes that records how much was read and whether it was canceled. */
function chunked(data: Uint8Array, size: number) {
	const seen = { read: 0, canceled: false };
	let at = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (at >= data.length) return controller.close();
			const chunk = data.slice(at, at + size);
			at += chunk.length;
			seen.read += chunk.length;
			controller.enqueue(chunk);
		},
		cancel() {
			seen.canceled = true;
		},
	});
	return { stream, seen };
}

test("JPEG: the size in its frame header, after EXIF's orientation", async () => {
	const jpeg = await bytes(card().jpeg());
	assert.deepEqual(imageSize(jpeg), { width: 300, height: 200 });
	assert.deepEqual(imageSize(await bytes(card().jpeg({ progressive: true }))), { width: 300, height: 200 });
	// 5 to 8 turn the image a quarter, so the sides swap; 2 to 4 mirror it or turn it half way
	assert.deepEqual(imageSize(await bytes(card().jpeg().withMetadata({ orientation: 6 }))), { width: 200, height: 300 });
	assert.deepEqual(imageSize(await bytes(card().jpeg().withMetadata({ orientation: 3 }))), { width: 300, height: 200 });
	assert.deepEqual(imageSize(withSegments(jpeg, exifOrientation(8, "MM"))), { width: 200, height: 300 });
	assert.deepEqual(imageSize(withSegments(jpeg, exifOrientation(5, "II"))), { width: 200, height: 300 });
	assert.deepEqual(imageSize(withSegments(jpeg, exifOrientation(2, "MM"))), { width: 300, height: 200 });
	// sharp reads the same
	const turned = withSegments(jpeg, exifOrientation(6, "MM"));
	assert.deepEqual((await sharp(turned).metadata()).autoOrient, imageSize(turned));
	// An EXIF segment that doesn't hold a TIFF header leaves the orientation alone
	assert.deepEqual(imageSize(withSegments(jpeg, segment(0xe1, new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2])))), { width: 300, height: 200 });
	// The books starter's map
	assert.deepEqual(imageSize(asset("00a00022-0000-4000-8000-000000a00022/800px-Narnian.world.map.jpg")), { width: 800, height: 282 });
});

test("JPEG: segments before the frame header are skipped whatever their size", async () => {
	const jpeg = await bytes(card().jpeg());
	// Five ICC profile chunks of 64 KB each, as a camera or Photoshop writes them
	const icc = Array.from({ length: 5 }, () => segment(0xe2, new Uint8Array(65_533)));
	const big = withSegments(jpeg, exifOrientation(6, "II"), ...icc);
	assert.deepEqual(imageSize(big), { width: 200, height: 300 });
	// Until the frame header arrives, more is needed
	assert.equal(imageSize(big.subarray(0, 200_000)), undefined);
	assert.equal(imageSize(jpeg.subarray(0, 3)), undefined);
});

test("PNG, GIF and the three kinds of WebP", async () => {
	assert.deepEqual(imageSize(asset("00a0000b-0000-4000-8000-000000a0000b/412px-Alice_par_John_Tenniel_30.png")), { width: 412, height: 600 });
	assert.deepEqual(imageSize(await bytes(card().png())), { width: 300, height: 200 });
	assert.deepEqual(imageSize(await bytes(card().gif())), { width: 300, height: 200 });
	// Lossy (VP8), lossless (VP8L), and lossy with transparency, which takes the extended header (VP8X)
	assert.deepEqual(imageSize(await bytes(card().webp())), { width: 300, height: 200 });
	assert.deepEqual(imageSize(await bytes(card().webp({ lossless: true }))), { width: 300, height: 200 });
	const alpha = await bytes(sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).webp());
	assert.equal(new TextDecoder().decode(alpha.subarray(12, 16)), "VP8X");
	assert.deepEqual(imageSize(alpha), { width: 300, height: 200 });
	assert.equal(imageSize(alpha.subarray(0, 20)), undefined);
});

test("files it can't read: null", () => {
	assert.equal(imageSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')), null);
	assert.equal(imageSize(new Uint8Array(64)), null);
	// A JPEG whose scan starts before any frame header
	assert.equal(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);
	// Not enough bytes yet to tell
	assert.equal(imageSize(new Uint8Array(0)), undefined);
});

test("readImageSize reads only as far as the size and cancels the rest", async () => {
	const jpeg = await bytes(card().jpeg());
	// Noise, so the scan after the frame header runs to hundreds of KB, as a photo's does
	const photo = await bytes(sharp({ create: { width: 1000, height: 800, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).jpeg({ quality: 95 }));
	const big = withSegments(photo, ...Array.from({ length: 5 }, () => segment(0xe2, new Uint8Array(65_533))));
	const { stream, seen } = chunked(big, 16_384);
	assert.deepEqual(await readImageSize(stream), { width: 1000, height: 800 });
	assert.ok(seen.read < big.length, `read ${seen.read} of ${big.length}`);
	assert.ok(seen.read >= 5 * 65_537, String(seen.read));
	assert.equal(seen.canceled, true);

	// One byte at a time works too
	const slow = chunked(jpeg, 1);
	assert.deepEqual(await readImageSize(slow.stream), { width: 300, height: 200 });
	assert.equal(slow.seen.canceled, true);

	// Past the limit, or at the end of a file it can't read: null
	const limited = chunked(big, 16_384);
	assert.equal(await readImageSize(limited.stream, 100_000), null);
	assert.ok(limited.seen.read < 200_000, String(limited.seen.read));
	assert.equal(await readImageSize(chunked(jpeg.subarray(0, 100), 16).stream), null);
});
