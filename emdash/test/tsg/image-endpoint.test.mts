// The image endpoint (runtime/image-endpoint.ts) with EmDash's own local storage, and its Node transforms
// (runtime/image-sharp.ts) on the books starter's real images. Offline.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Storage } from "emdash";
import { LocalStorage } from "emdash/storage/local";
import sharp from "sharp";
import { serveImage } from "../../tsg2astro/runtime/image-endpoint.ts";
import type { ImageCache, ImageTransformer, LargeImageTransformer } from "../../tsg2astro/runtime/image-endpoint.ts";
import { sharpTransform } from "../../tsg2astro/runtime/image-sharp.ts";
import { imageEndpointUrl } from "../../tsg2astro/runtime/imgix.ts";
import type { ImagePlan } from "../../tsg2astro/runtime/imgix.ts";

const assets = new URL("./sites/shape-books/assets/00000006-0000-4000-8000-000000000006/dev/", import.meta.url);
const uploads = mkdtempSync(join(tmpdir(), "tsg-image-endpoint-"));
after(() => rmSync(uploads, { recursive: true, force: true }));
const files: Record<string, string> = {
	// 412x600, the PNG imgix enlarged to 1000x1456 at w=1000
	"alice.png": "00a0000b-0000-4000-8000-000000a0000b/412px-Alice_par_John_Tenniel_30.png",
	// 800x282
	"map.jpg": "00a00022-0000-4000-8000-000000a00022/800px-Narnian.world.map.jpg",
	// 800x498 with transparent pixels
	"alpha.png": "00a00050-0000-4000-8000-000000a00050/800px-De_Alice's_Abenteuer_im_Wunderland_Carroll_pic_23_edited_1_of_2.png",
	// 202x203, a portrait
	"lewis.png": "00a0001c-0000-4000-8000-000000a0001c/c-s-lewis.png",
};
for (const [key, path] of Object.entries(files)) copyFileSync(new URL(path, assets), join(uploads, key));
writeFileSync(join(uploads, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
const storage = new LocalStorage({ directory: uploads, baseUrl: "/_emdash/api/media/file" }) as unknown as Storage;

const request = (key: string, params: Record<string, unknown>, headers: Record<string, string> = {}) => {
	const url = imageEndpointUrl(`/_emdash/api/media/file/${key}`, params);
	return new Request(new URL(url.startsWith("/_takeshape/") ? url : `/_takeshape/image?href=${encodeURIComponent(url)}`, "http://site.test"), { headers });
};

/** A transformer that records its plans and answers with a marker. */
function recorder(answer: (plan: ImagePlan) => Awaited<ReturnType<ImageTransformer>> = () => ({ body: "made", type: "image/webp" })) {
	const plans: ImagePlan[] = [];
	const transform: ImageTransformer = async (_bytes, plan) => {
		plans.push(plan);
		return answer(plan);
	};
	return { plans, transform };
}

async function size(res: Response): Promise<[number, number, string]> {
	const meta = await sharp(new Uint8Array(await res.arrayBuffer())).metadata();
	return [meta.width, meta.height, meta.format];
}

test("serves EmDash media only, and the stored file where there is nothing to do", async () => {
	const { plans, transform } = recorder();
	const notMedia = new Request("http://site.test/_takeshape/image?href=https%3A%2F%2Fevil.test%2Fa.png&w=10");
	assert.equal((await serveImage(notMedia, storage, transform)).status, 404);
	assert.equal((await serveImage(request("alice.png", { w: 10 }), null, transform)).status, 404);
	assert.equal((await serveImage(request("missing.png", { w: 10 }), storage, transform)).status, 404);

	// SVG is not transformed and goes out as EmDash's media route sends it
	const svg = await serveImage(request("logo.svg", { w: 10 }), storage, transform);
	assert.equal(svg.status, 200);
	assert.equal(svg.headers.get("Content-Type"), "image/svg+xml");
	assert.equal(svg.headers.get("Content-Disposition"), "attachment");
	assert.match(await svg.text(), /<svg/);

	// No size in the request: the stored file, with its own validator
	const unsized = "http://site.test/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Falice.png&fit=crop";
	const plain = await serveImage(new Request(unsized), storage, transform);
	assert.equal(plain.headers.get("Content-Type"), "image/png");
	assert.equal((await plain.arrayBuffer()).byteLength, 181544);
	const again = await serveImage(new Request(unsized, { headers: { "If-None-Match": plain.headers.get("ETag")! } }), storage, transform);
	assert.equal(again.status, 304);
	assert.equal(plans.length, 0);
});

test("transforms with the plan, and keeps EmDash's validators and cache policy", async () => {
	const { plans, transform } = recorder();
	const res = await serveImage(request("alice.png", { w: 200, h: 200, fit: "crop", crop: "faces", auto: "compress,format" }), storage, transform);
	assert.equal(res.status, 200);
	assert.equal(await res.text(), "made");
	assert.equal(res.headers.get("Content-Type"), "image/webp");
	assert.equal(res.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
	assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
	const etag = res.headers.get("ETag")!;
	assert.match(etag, /^W\/"181544-\d+-[0-9a-f]{8}"$/);
	assert.deepEqual(plans, [{ fit: "cover", format: "webp", width: 200, height: 200, gravity: "face", quality: 45 }]);

	// The same request with its ETag: 304, nothing transformed; another size: a new transform
	const same = await serveImage(request("alice.png", { w: 200, h: 200, fit: "crop", crop: "faces", auto: "compress,format" }, { "If-None-Match": etag }), storage, transform);
	assert.equal(same.status, 304);
	assert.equal(same.headers.get("ETag"), etag);
	const other = await serveImage(request("alice.png", { w: 300 }, { "If-None-Match": etag }), storage, transform);
	assert.equal(other.status, 200);
	assert.equal(plans.length, 2);
});

test("a failed transform serves the stored file, as does a build without a transformer", async () => {
	const logged: unknown[] = [];
	const error = console.error;
	console.error = (...args: unknown[]) => logged.push(args);
	try {
		// Cloudflare answers 9422 to an Images Free account past its 5,000 transforms a month
		const failing = recorder(() => {
			throw new Error("IMAGES_TRANSFORM_ERROR 9422: Exceeded the unique transformation limit");
		});
		const res = await serveImage(request("alice.png", { w: 200 }), storage, failing.transform);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("Content-Type"), "image/png");
		assert.equal((await res.arrayBuffer()).byteLength, 181544);
		assert.match(res.headers.get("ETag")!, /^W\/"181544-\d+"$/);
		assert.equal(logged.length, 1);
		// astro dev on workerd has no Images binding: the stored file, quietly
		const none = await serveImage(request("alice.png", { w: 200 }), storage, recorder(() => null).transform);
		assert.equal((await none.arrayBuffer()).byteLength, 181544);
		assert.equal(logged.length, 1);
	} finally {
		console.error = error;
	}
});

test("with a cache, each result is kept under the stored file's size and date", async () => {
	const stored = new Map<string, Response>();
	const cache: ImageCache = {
		match: async (req) => stored.get(req.url)?.clone(),
		put: async (req, res) => {
			stored.set(req.url, new Response(await res.arrayBuffer(), { headers: res.headers }));
		},
	};
	const pending: Array<Promise<unknown>> = [];
	const waitUntil = (p: Promise<unknown>) => pending.push(p);
	const { plans, transform } = recorder();
	const first = await serveImage(request("map.jpg", { w: 100 }), storage, transform, { cache, waitUntil });
	assert.equal(await first.text(), "made");
	await Promise.all(pending);
	const [key, kept] = [...stored][0]!;
	assert.match(key, /^http:\/\/site\.test\/_takeshape\/image\?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fmap\.jpg&plan=[0-9a-f]{8}&v=14831-\d+$/);
	assert.equal(kept.headers.get("Cache-Control"), "public, max-age=2592000");

	const second = await serveImage(request("map.jpg", { w: 100 }), storage, transform, { cache, waitUntil });
	assert.equal(await second.text(), "made");
	assert.equal(second.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
	assert.equal(second.headers.get("ETag"), first.headers.get("ETag"));
	assert.equal(plans.length, 1);

	// A file replaced in EmDash keeps its key but not its date: a new result
	utimesSync(join(uploads, "map.jpg"), new Date(), new Date(Date.now() + 60_000));
	await serveImage(request("map.jpg", { w: 100 }), storage, transform, { cache, waitUntil });
	assert.equal(plans.length, 2);
});

/** EmDash's storage, counting the bytes each download's body gave and whether it was canceled. Reads on demand. */
function counting(inner: Storage) {
	const downloads: Array<{ key: string; read: number; canceled: boolean }> = [];
	const wrapped = {
		download: async (key: string) => {
			const file = await inner.download(key);
			const seen = { key, read: 0, canceled: false };
			downloads.push(seen);
			const reader = file.body.getReader();
			const body = new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						const { done, value } = await reader.read();
						if (done) return controller.close();
						seen.read += value.byteLength;
						controller.enqueue(value);
					},
					cancel(reason) {
						seen.canceled = true;
						return reader.cancel(reason);
					},
				},
				{ highWaterMark: 0 },
			);
			return { ...file, body };
		},
	} as unknown as Storage;
	return { storage: wrapped, downloads };
}

/** A large-file transformer that records what it was given and answers with a marker. */
function largeRecorder(answer: () => Awaited<ReturnType<LargeImageTransformer>> = () => ({ body: "made from the URL", type: "image/webp" })) {
	const calls: Array<Parameters<LargeImageTransformer>> = [];
	const transform: LargeImageTransformer = async (...args) => {
		calls.push(args);
		return answer();
	};
	return { calls, transform };
}

test("files over large.over go to the large transformer, with the media route's URL and the image's size, unread", async () => {
	const { storage: counted, downloads } = counting(storage);
	const { plans, transform } = recorder();
	const large = largeRecorder();
	// alice.png is 181,544 bytes: over a 100,000-byte limit
	const res = await serveImage(request("alice.png", { w: 200, auto: "compress,format" }), counted, transform, { large: { over: 100_000, transform: large.transform } });
	assert.equal(res.status, 200);
	assert.equal(await res.text(), "made from the URL");
	assert.equal(res.headers.get("Content-Type"), "image/webp");
	assert.equal(res.headers.get("Cache-Control"), "public, max-age=0, must-revalidate");
	assert.match(res.headers.get("ETag")!, /^W\/"181544-\d+-[0-9a-f]{8}"$/);
	assert.deepEqual(large.calls, [
		[
			{ url: "http://site.test/_emdash/api/media/file/alice.png", bytes: 181544, type: "image/png", size: { width: 412, height: 600 } },
			{ fit: "contain", format: "webp", width: 200, quality: 45 },
		],
	]);
	assert.equal(plans.length, 0);
	// Only the first chunk was read, for the size, and the rest canceled
	assert.equal(downloads.length, 1);
	assert.ok(downloads[0]!.read < 181544, String(downloads[0]!.read));
	assert.equal(downloads[0]!.canceled, true);

	// map.jpg, 14,831 bytes, stays with the transformer
	await serveImage(request("map.jpg", { w: 100 }), storage, transform, { large: { over: 100_000, transform: large.transform } });
	assert.equal(plans.length, 1);
	assert.equal(large.calls.length, 1);

	// The URL is the site's own media route for the key, whatever host href names
	const elsewhere = new Request(`http://site.test/_takeshape/image?href=${encodeURIComponent("https://evil.test/_emdash/api/media/file/alice.png?x=1")}&w=200`);
	await serveImage(elsewhere, storage, transform, { large: { over: 100_000, transform: large.transform } });
	assert.equal(large.calls[1]![0].url, "http://site.test/_emdash/api/media/file/alice.png");

	// A file whose size it can't read goes without one
	writeFileSync(join(uploads, "odd.png"), new Uint8Array(150_000));
	await serveImage(request("odd.png", { w: 200 }), storage, transform, { large: { over: 100_000, transform: large.transform } });
	assert.deepEqual(large.calls[2]![0], { url: "http://site.test/_emdash/api/media/file/odd.png", bytes: 150_000, type: "image/png", size: undefined });
});

test("a large file the large transformer can't make goes out as stored, read again from the start", async () => {
	const logged: unknown[] = [];
	const error = console.error;
	console.error = (...args: unknown[]) => logged.push(args);
	try {
		const failing = largeRecorder(() => {
			throw new Error("cf.image answered 404 text/plain (err=9404): ERROR 9404");
		});
		const { storage: counted, downloads } = counting(storage);
		const res = await serveImage(request("alice.png", { w: 200 }), counted, recorder().transform, { large: { over: 100_000, transform: failing.transform } });
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("Content-Type"), "image/png");
		assert.match(res.headers.get("ETag")!, /^W\/"181544-\d+"$/);
		assert.deepEqual(new Uint8Array(await res.arrayBuffer()), new Uint8Array(readFileSync(join(uploads, "alice.png"))));
		assert.deepEqual(
			downloads.map((d) => [d.read < 181544, d.canceled]),
			[
				[true, true],
				[false, false],
			],
		);
		assert.equal(logged.length, 1);

		// null, as from a build that can't fetch: the stored file, quietly
		const none = await serveImage(request("alice.png", { w: 200 }), storage, recorder().transform, { large: { over: 100_000, transform: largeRecorder(() => null).transform } });
		assert.equal((await none.arrayBuffer()).byteLength, 181544);
		assert.equal(logged.length, 1);
	} finally {
		console.error = error;
	}
});

test("large results are cached and revalidated like the others", async () => {
	const stored = new Map<string, Response>();
	const cache: ImageCache = {
		match: async (req) => stored.get(req.url)?.clone(),
		put: async (req, res) => {
			stored.set(req.url, new Response(await res.arrayBuffer(), { headers: res.headers }));
		},
	};
	const pending: Array<Promise<unknown>> = [];
	const waitUntil = (p: Promise<unknown>) => pending.push(p);
	const large = largeRecorder();
	const options = { cache, waitUntil, large: { over: 100_000, transform: large.transform } };
	const first = await serveImage(request("alice.png", { w: 250 }), storage, recorder().transform, options);
	assert.equal(await first.text(), "made from the URL");
	await Promise.all(pending);
	const second = await serveImage(request("alice.png", { w: 250 }), storage, recorder().transform, options);
	assert.equal(await second.text(), "made from the URL");
	assert.equal(large.calls.length, 1);
	const again = await serveImage(request("alice.png", { w: 250 }, { "If-None-Match": first.headers.get("ETag")! }), storage, recorder().transform, options);
	assert.equal(again.status, 304);
	assert.equal(large.calls.length, 1);
});

test("sharp: imgix's default fit enlarges, fit=max doesn't", async () => {
	const serve = (params: Record<string, unknown>, key = "alice.png") => serveImage(request(key, params), storage, sharpTransform);
	assert.deepEqual(await size(await serve({ w: 1000 })), [1000, 1456, "webp"]);
	assert.deepEqual(await size(await serve({ w: 1000, fit: "max" })), [412, 600, "webp"]);
	assert.deepEqual(await size(await serve({ w: 206, dpr: 2 })), [412, 600, "webp"]);
	assert.deepEqual(await size(await serve({ h: 300, fm: "jpg" })), [206, 300, "jpeg"]);
	assert.deepEqual(await size(await serve({ w: 300, h: 300, fit: "scale", fm: "png" })), [300, 300, "png"]);
	assert.deepEqual(await size(await serve({ w: 1000, h: 1000, fit: "min" })), [412, 412, "webp"]);
	assert.deepEqual(await size(await serve({ w: 100, auto: "compress,format" })), [100, 146, "webp"]);
});

test("sharp: crops", async () => {
	const serve = (params: Record<string, unknown>, key: string) => serveImage(request(key, params), storage, sharpTransform);
	assert.deepEqual(await size(await serve({ w: 120, h: 120, fit: "crop", crop: "faces" }, "lewis.png")), [120, 120, "webp"]);
	assert.deepEqual(await size(await serve({ w: 200, h: 200, fit: "crop", crop: "entropy" }, "map.jpg")), [200, 200, "webp"]);

	// crop=left keeps the left edge: the same pixels as a cover crop of the scaled map taken at x=0
	const left = new Uint8Array(await (await serve({ w: 200, h: 200, fit: "crop", crop: "left", fm: "png" }, "map.jpg")).arrayBuffer());
	const scaled = sharp(new URL(files["map.jpg"]!, assets).pathname).resize(567, 200, { fit: "fill" });
	const expected = await scaled.extract({ left: 0, top: 0, width: 200, height: 200 }).raw().toBuffer();
	assert.deepEqual(await sharp(left).raw().toBuffer(), expected);

	// The focal point at 30% across: the crop is centered on it, 170 - 100 = 70 pixels in
	const focal = new Uint8Array(await (await serve({ w: 200, h: 200, fit: "crop", crop: "focalpoint", "fp-x": 0.3, fm: "png" }, "map.jpg")).arrayBuffer());
	const around = await sharp(new URL(files["map.jpg"]!, assets).pathname).resize(567, 200, { fit: "fill" }).extract({ left: 70, top: 0, width: 200, height: 200 }).raw().toBuffer();
	assert.deepEqual(await sharp(focal).raw().toBuffer(), around);
});

test("sharp: padding and transparent pixels", async () => {
	const serve = (params: Record<string, unknown>, key: string) => serveImage(request(key, params), storage, sharpTransform);
	const pixel = async (res: Response, x: number, y: number) => {
		const { data, info } = await sharp(new Uint8Array(await res.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		const i = (y * info.width + x) * 4;
		return [info.width, info.height, data[i], data[i + 1], data[i + 2], data[i + 3]];
	};
	// fill pads to the size when told how: transparent in PNG, white in JPEG, or the color asked for
	assert.deepEqual(await pixel(await serve({ w: 1000, h: 1000, fit: "fill", fill: "solid", fm: "png" }, "alpha.png"), 0, 0), [1000, 1000, 0, 0, 0, 0]);
	// JPEG at quality 45 is lossy: white comes back within a step or two of 255
	const white = await pixel(await serve({ w: 1000, h: 1000, fit: "fill", fill: "solid", fm: "jpg" }, "alpha.png"), 0, 0);
	assert.deepEqual(white.slice(0, 2), [1000, 1000]);
	assert.ok(white.slice(2).every((c) => c! >= 250), String(white));
	assert.deepEqual(await pixel(await serve({ w: 1000, h: 1000, fit: "fill", "fill-color": "ff0000", fm: "png" }, "alpha.png"), 0, 0), [1000, 1000, 255, 0, 0, 255]);
	// Without, as on TakeShape's CDN, it resizes as clip
	assert.deepEqual((await pixel(await serve({ w: 1000, h: 1000, fit: "fill" }, "alpha.png"), 0, 0)).slice(0, 2), [1000, 623]);
	// fillmax keeps the image at its size, pixel for pixel, inside the padding
	const fillmax = new Uint8Array(await (await serve({ w: 600, h: 600, fit: "fillmax", bg: "000", fm: "png" }, "alice.png")).arrayBuffer());
	assert.deepEqual(await pixel(new Response(fillmax), 93, 300), [600, 600, 0, 0, 0, 255]);
	const inside = await sharp(fillmax).extract({ left: 94, top: 0, width: 412, height: 600 }).raw().toBuffer();
	assert.deepEqual(inside, await sharp(new URL(files["alice.png"]!, assets).pathname).raw().toBuffer());
});

test("sharp: bg fills transparent pixels inside a padded image, and fill-color only the padding", async () => {
	// 100x50, opaque red with a transparent hole at x 30 to 69, y 15 to 34 (alpha.png has no transparent pixels)
	const raw = Buffer.alloc(100 * 50 * 4);
	for (let y = 0; y < 50; y++) {
		for (let x = 0; x < 100; x++) {
			const i = (y * 100 + x) * 4;
			if (x >= 30 && x < 70 && y >= 15 && y < 35) continue;
			raw[i] = 255;
			raw[i + 3] = 255;
		}
	}
	writeFileSync(join(uploads, "hole.png"), await sharp(raw, { raw: { width: 100, height: 50, channels: 4 } }).png().toBuffer());
	const at = async (params: Record<string, unknown>, points: Array<[number, number]>) => {
		const res = await serveImage(request("hole.png", { w: 200, h: 200, fit: "fill", ...params }), storage, sharpTransform);
		const { data, info } = await sharp(new Uint8Array(await res.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		assert.deepEqual([info.width, info.height], [200, 200]);
		return points.map(([x, y]) => [...data.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 4)]);
	};
	// Scaled to 200x100 with 50 pixels of padding above and below: (0, 0) is padding, (100, 100) is in the hole
	const points: Array<[number, number]> = [
		[0, 0],
		[100, 100],
	];
	assert.deepEqual(await at({ bg: "00ff00", fm: "png" }, points), [
		[0, 255, 0, 255],
		[0, 255, 0, 255],
	]);
	assert.deepEqual(await at({ bg: "00ff00", "fill-color": "0000ff", fm: "png" }, points), [
		[0, 0, 255, 255],
		[0, 255, 0, 255],
	]);
	assert.deepEqual(await at({ "fill-color": "0000ff", fm: "png" }, points), [
		[0, 0, 255, 255],
		[0, 0, 0, 0],
	]);
});
