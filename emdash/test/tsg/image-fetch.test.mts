// The image endpoint's way on Workers for files over the Images binding's 20 MB (runtime/image-fetch.ts): fetch()
// with cf.image. Offline: a fake fetch answers as Cloudflare did for large images on a test account on 2026-10-18.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BINDING_MAX_BYTES, fetchTransform } from "../../tsg2astro/runtime/image-fetch.ts";
import type { LargeSource } from "../../tsg2astro/runtime/image-fetch.ts";
import { fetchImageOptions, imagePlan } from "../../tsg2astro/runtime/imgix.ts";

const plan = (query: string) => imagePlan(new URLSearchParams(query))!;
// A 30 MB photo
const photo: LargeSource = { url: "https://site.test/_emdash/api/media/file/01J8ZZ0000000000000000PHT0.jpg", bytes: 30_000_000, type: "image/jpeg", size: { width: 6000, height: 4004 } };

/** A fetch that records each call and answers with `answer`. */
function fake(answer: () => Response) {
	const calls: Array<{ url: string; image: unknown }> = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), image: (init as { cf?: { image?: unknown } } | undefined)?.cf?.image });
		return answer();
	}) as typeof fetch;
	return { calls, fetchImpl };
}

const resized = (type = "image/webp") => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": type, "cf-resized": "internal=ok/- q=0 n=1436+8 c=323+34" } });

test("the binding takes 20 MB: a 19.1 MB file stays with it, a 21.2 MB one doesn't", () => {
	assert.equal(BINDING_MAX_BYTES, 20_000_000);
	assert.ok(19_100_000 <= BINDING_MAX_BYTES);
	assert.ok(21_200_000 > BINDING_MAX_BYTES);
});

test("fetches the stored file from the media route with the plan as cf.image options", async () => {
	const { calls, fetchImpl } = fake(() => resized());
	const p = plan("w=500&auto=compress,format");
	const result = await fetchTransform(photo, p, fetchImpl);
	assert.equal(result.type, "image/webp");
	assert.deepEqual([...new Uint8Array(await new Response(result.body).arrayBuffer())], [1, 2, 3]);
	assert.deepEqual(calls, [{ url: photo.url, image: fetchImageOptions(p, photo.size) }]);
	assert.deepEqual(calls[0]!.image, { width: 500, height: 334, fit: "squeeze", anim: false, format: "webp", quality: 45 });

	// Without the image's size (a header it couldn't read), Cloudflare's own fit modes
	const unknown = fake(() => resized());
	await fetchTransform({ ...photo, size: undefined }, p, unknown.fetchImpl);
	assert.deepEqual(unknown.calls[0]!.image, { width: 500, fit: "contain", anim: false, format: "webp", quality: 45 });
});

test("throws when Cloudflare didn't make the image, so the endpoint serves the stored file", async () => {
	// The source didn't answer: Cloudflare's error text, with its code in cf-resized
	const missing = fake(() => new Response("ERROR 9404: Could not fetch the image — the server returned HTTP error 404 Not Found\n", { status: 404, headers: { "Content-Type": "text/plain;charset=utf-8", "cf-resized": "err=9404" } }));
	await assert.rejects(fetchTransform(photo, plan("w=500"), missing.fetchImpl), /404.*err=9404.*ERROR 9404/s);

	// An answer in another format than the plan's is the file sent back untouched (an animation Cloudflare
	// passed through, or a local fetch that ignores cf.image); its body is left unread
	let canceled = false;
	const body = new ReadableStream<Uint8Array>({
		pull: (c) => c.enqueue(new Uint8Array(1024)),
		cancel: () => {
			canceled = true;
		},
	});
	const passed = fake(() => new Response(body, { headers: { "Content-Type": "image/gif", "cf-resized": "internal=ok/- q=0" } }));
	await assert.rejects(fetchTransform({ ...photo, type: "image/gif" }, plan("w=500"), passed.fetchImpl), /image\/gif/);
	assert.equal(canceled, true);

	const jpeg = fake(() => resized("image/jpeg"));
	await assert.rejects(fetchTransform(photo, plan("w=500&fm=png"), jpeg.fetchImpl), /image\/jpeg/);
});

test("formats Cloudflare may answer in place of the plan's", async () => {
	// AVIF falls back to WebP or JPEG when Cloudflare finds the image too large to encode in time
	for (const type of ["image/avif", "image/webp", "image/jpeg"]) {
		assert.equal((await fetchTransform(photo, plan("w=500&fm=avif"), fake(() => resized(type)).fetchImpl)).type, type);
	}
	// A GIF plan sends no format, so any image counts
	assert.equal((await fetchTransform(photo, plan("w=500&fm=gif"), fake(() => resized("image/jpeg")).fetchImpl)).type, "image/jpeg");
	// Content-Type parameters don't matter
	assert.equal((await fetchTransform(photo, plan("w=500"), fake(() => resized("image/webp; charset=binary")).fetchImpl)).type, "image/webp");
});

test("beyond Cloudflare's limits for remote images it doesn't try", async () => {
	const never = fake(() => {
		throw new Error("fetched");
	});
	const p = plan("w=500");
	await assert.rejects(fetchTransform({ ...photo, bytes: 100_000_001 }, p, never.fetchImpl), /100 MB/);
	await assert.rejects(fetchTransform({ ...photo, size: { width: 12_001, height: 3000 } }, p, never.fetchImpl), /12,000 pixels/);
	await assert.rejects(fetchTransform({ ...photo, size: { width: 11_000, height: 9_500 } }, p, never.fetchImpl), /100 megapixels/);
	assert.equal(never.calls.length, 0);
	// WebP has no side limit there
	const webp = fake(() => resized());
	await fetchTransform({ ...photo, type: "image/webp", size: { width: 15_000, height: 3000 } }, p, webp.fetchImpl);
	assert.equal(webp.calls.length, 1);
});
