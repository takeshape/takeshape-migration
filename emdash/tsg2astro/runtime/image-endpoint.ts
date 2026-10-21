/**
 * The image endpoint at /_takeshape/image (IMAGE_ENDPOINT in imgix.ts), which both builds share: the Workers
 * route (src/image-endpoint.ts, Cloudflare's Images binding) and the Node route (src/image-endpoint-node.ts,
 * sharp). The image filter and rich-text images point here when they pass a size.
 *
 * Like EmDash's own /_image endpoint, it serves EmDash media only, reads the bytes straight from storage, and
 * sends the same headers: a weak ETag that includes the transform, 304 answers, `must-revalidate` (a file
 * replaced in EmDash keeps its storage key). Unlike it, it honors imgix's parameters (imgix.ts), serves the
 * stored file when a transform fails (Cloudflare answers error 9422 to an Images Free account past 5,000 unique
 * transforms a month), and, given a cache, keeps each result under the plan and the stored file's size and
 * date, so a replaced file or a changed mapping gets new results. A file over the transformer's limit (the
 * Images binding's 20 MB) goes to a second transformer that works from the file's public URL (image-fetch.ts),
 * and the endpoint reads only enough of the file for its size in pixels.
 */
import type { Storage } from "emdash";
import { isNotModified, matchInternalMediaKey, MUTABLE_MEDIA_CACHE_CONTROL, originalMediaHeaders, validatorHeaders } from "emdash/media/image-endpoint";
import { readImageSize } from "./image-header.ts";
import { canTransform, imagePlan, MEDIA_PREFIX, planKey } from "./imgix.ts";
import type { ImagePlan, Size } from "./imgix.ts";

/** Makes the image for a plan, or returns null when it can't here (no Images binding in `astro dev`). Throws on failure. */
export type ImageTransformer = (bytes: Uint8Array<ArrayBuffer>, plan: ImagePlan) => Promise<{ body: BodyInit | null; type: string } | null>;

/**
 * Makes the image for a plan from the stored file's public URL, for files too large for an ImageTransformer, or
 * returns null. `size` is the image's size in pixels, when its first bytes gave it. Throws on failure.
 */
export type LargeImageTransformer = (
	source: { url: string; bytes: number; type: string; size?: Size },
	plan: ImagePlan,
) => Promise<{ body: BodyInit | null; type: string } | null>;

/**
 * EmDash's storage from a request's locals. EmDash's middleware sets `locals.emdash` on every request, this
 * endpoint's included, though its types only promise it on /_emdash/ routes.
 */
export function mediaStorage(locals: object): Storage | null | undefined {
	return (locals as { emdash?: { storage?: Storage | null } }).emdash?.storage;
}

/** The part of the Workers Cache API the endpoint uses (`caches.default`). */
export type ImageCache = {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
};

/**
 * How long a cache keeps a result: 30 days. Its key changes when the stored file or the plan does. Cloudflare
 * bills a repeated transform once a month, so a longer stay would save time, not money.
 */
const CACHE_FOR = "public, max-age=2592000";

function isNotFound(error: unknown): boolean {
	return error instanceof Error && (error.message.includes("not found") || error.message.includes("NOT_FOUND"));
}

function notModified(contentType: string, validators: Record<string, string>): Response {
	return new Response(null, {
		status: 304,
		headers: { "Content-Type": contentType, "Cache-Control": MUTABLE_MEDIA_CACHE_CONTROL, "X-Content-Type-Options": "nosniff", ...validators },
	});
}

function cancel(body: ReadableStream<Uint8Array>): void {
	body.cancel().catch(() => {});
}

async function download(storage: Storage, key: string): Promise<Awaited<ReturnType<Storage["download"]>> | Response> {
	try {
		return await storage.download(key);
	} catch (error) {
		if (isNotFound(error)) return new Response("Not Found", { status: 404 });
		console.error("[takeshape] image endpoint could not read the file:", error);
		return new Response("Internal Server Error", { status: 500 });
	}
}

/**
 * Answers a request to the image endpoint. `cache` and `waitUntil` go together: the result is stored in the
 * background after it is sent. `large` takes the files over `over` bytes.
 */
export async function serveImage(
	request: Request,
	storage: Storage | null | undefined,
	transform: ImageTransformer,
	options: { cache?: ImageCache; waitUntil?: (promise: Promise<unknown>) => void; large?: { over: number; transform: LargeImageTransformer } } = {},
): Promise<Response> {
	const url = new URL(request.url);
	const href = url.searchParams.get("href");
	const key = matchInternalMediaKey(href);
	if (!key || !storage) return new Response("Not Found", { status: 404 });

	const source = await download(storage, key);
	if (source instanceof Response) return source;
	const { contentType, size, lastModified } = source;
	const plan = canTransform(contentType) ? imagePlan(url.searchParams) : null;
	if (!plan) {
		if (isNotModified(request, size, lastModified)) {
			cancel(source.body);
			return notModified(contentType, validatorHeaders(size, lastModified));
		}
		return new Response(source.body, { headers: originalMediaHeaders(contentType, size, lastModified) });
	}

	const fingerprint = planKey(plan);
	const validators = validatorHeaders(size, lastModified, fingerprint);
	const headers = (type: string, cacheControl = MUTABLE_MEDIA_CACHE_CONTROL) => ({ "Content-Type": type, "Cache-Control": cacheControl, "X-Content-Type-Options": "nosniff", ...validators });
	if (isNotModified(request, size, lastModified, fingerprint)) {
		cancel(source.body);
		return notModified(`image/${plan.format}`, validators);
	}

	const { cache, waitUntil } = options;
	const cacheKey = cache && waitUntil ? new Request(`${url.origin}${url.pathname}?href=${encodeURIComponent(href!)}&plan=${fingerprint}&v=${size}-${lastModified?.getTime() ?? 0}`) : undefined;
	if (cache && cacheKey) {
		const hit = await cache.match(cacheKey).catch(() => undefined);
		if (hit?.ok && hit.body) {
			cancel(source.body);
			return new Response(hit.body, { headers: headers(hit.headers.get("Content-Type") ?? `image/${plan.format}`) });
		}
	}

	let result: Awaited<ReturnType<ImageTransformer>>;
	const { large } = options;
	if (large && size > large.over) {
		// Only the first bytes, for the size in pixels; the large transformer fetches the file from EmDash's media
		// route on this site, named by the key alone, since href may name any host
		const pixels = await readImageSize(source.body);
		try {
			result = await large.transform({ url: `${url.origin}${MEDIA_PREFIX}${key}`, bytes: size, type: contentType, size: pixels ?? undefined }, plan);
		} catch (error) {
			console.error("[takeshape] image transform failed, serving the stored file:", error);
			result = null;
		}
		if (!result?.body) {
			const stored = await download(storage, key);
			if (stored instanceof Response) return stored;
			return new Response(stored.body, { headers: originalMediaHeaders(stored.contentType, stored.size, stored.lastModified) });
		}
	} else {
		const bytes = new Uint8Array(await new Response(source.body).arrayBuffer());
		try {
			result = await transform(bytes, plan);
		} catch (error) {
			console.error("[takeshape] image transform failed, serving the stored file:", error);
			result = null;
		}
		if (!result?.body) return new Response(bytes, { headers: originalMediaHeaders(contentType, size, lastModified) });
	}

	const response = new Response(result.body, { headers: headers(result.type) });
	if (cache && cacheKey && waitUntil) {
		const copy = response.clone();
		waitUntil(
			cache.put(cacheKey, new Response(copy.body, { headers: headers(result.type, CACHE_FOR) })).catch((error: unknown) => {
				console.error("[takeshape] image endpoint could not cache a result:", error);
			}),
		);
	}
	return response;
}
