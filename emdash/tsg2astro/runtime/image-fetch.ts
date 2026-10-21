/**
 * The image endpoint's way on Workers for stored files over the Images binding's limit. Cloudflare's docs give
 * the binding's `.input()` 20 MB, and on a test deploy (2026-10-18) larger files failed with
 * `IMAGES_INFO_ERROR 9502: Images binding connection error` or "Network connection lost". Cloudflare's other way
 * in, `fetch()` with `cf.image`, takes the same transforms for remote images up to 100 MB, 100 megapixels and
 * 12,000 pixels a side, on workers.dev too. Cloudflare fetches the file from the site's own media route, so the
 * Worker never holds it. Each result is a unique transformation, billed as the binding's are.
 */
import { fetchImageOptions } from "./imgix.ts";
import type { ImagePlan, OutputFormat, Size } from "./imgix.ts";

/** The most the Images binding takes: 20 MB in Cloudflare's docs. A 19.1 MB file went through and a 21.2 MB one didn't. */
export const BINDING_MAX_BYTES = 20_000_000;

/** Cloudflare's limits for transforming a remote image. The side limit doesn't apply to WebP (or AVIF). */
const MAX_BYTES = 100_000_000;
const MAX_PIXELS = 100_000_000;
const MAX_SIDE = 12_000;

/** A stored file too large for the binding: its public URL, its size in bytes and its type, and its size in pixels if known. */
export type LargeSource = { url: string; bytes: number; type: string; size?: Size };

/**
 * The types an answer may have for a plan's format: AVIF falls back to WebP or JPEG when Cloudflare finds an image
 * too large to encode in time, and a GIF plan sends no format, so any image counts.
 */
const ANSWERS: Record<OutputFormat, string[] | undefined> = {
	jpeg: ["image/jpeg"],
	png: ["image/png"],
	webp: ["image/webp"],
	avif: ["image/avif", "image/webp", "image/jpeg"],
	gif: undefined,
};

/** Makes the image for a plan from the file's URL. Throws when Cloudflare didn't make it, so the endpoint sends the stored file. */
export async function fetchTransform(source: LargeSource, plan: ImagePlan, fetchImpl: typeof fetch = fetch): Promise<{ body: ReadableStream<Uint8Array> | null; type: string }> {
	if (source.bytes > MAX_BYTES) throw new Error(`${source.url} is over Cloudflare's 100 MB for image transforms`);
	if (source.size) {
		const { width, height } = source.size;
		if (width * height > MAX_PIXELS) throw new Error(`${source.url} is over Cloudflare's 100 megapixels for image transforms`);
		if (Math.max(width, height) > MAX_SIDE && source.type !== "image/webp") throw new Error(`${source.url} is over Cloudflare's 12,000 pixels a side for image transforms`);
	}
	// `cf` is Workers' own part of RequestInit
	const response = await fetchImpl(source.url, { cf: { image: fetchImageOptions(plan, source.size) } } as RequestInit);
	const type = (response.headers.get("Content-Type") ?? "").split(";")[0]!.trim();
	const resized = response.headers.get("cf-resized") ?? "";
	const expected = ANSWERS[plan.format];
	if (response.ok && !resized.includes("err=") && type.startsWith("image/") && (!expected || expected.includes(type))) return { body: response.body, type };

	// An image in another format is the file sent back as stored; leave it unread. Anything else is Cloudflare's error text.
	const detail = type.startsWith("image/") ? "" : (await response.text().catch(() => "")).trim().slice(0, 200);
	if (type.startsWith("image/")) await response.body?.cancel().catch(() => {});
	throw new Error(`cf.image answered ${response.status} ${type || "without a type"} (${resized || "no cf-resized"}) for ${source.url}${detail ? `: ${detail}` : ""}`);
}
