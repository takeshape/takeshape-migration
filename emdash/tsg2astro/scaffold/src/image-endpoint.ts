// The image endpoint on Workers, /_takeshape/image (astro.config.mjs adds the route). It resizes EmDash media with
// Cloudflare's Images binding, by the imgix parameters src/lib/takeshape/imgix.ts maps, and keeps each result in
// the Cache API (Cloudflare's docs promise working cache operations on custom domains). Files over the binding's
// 20 MB go through fetch() with cf.image instead (src/lib/takeshape/image-fetch.ts).
// src/lib/takeshape/image-endpoint.ts does the rest. `astro dev` has no Images binding, so images go out as stored.
import type { APIRoute } from "astro";
import { env, waitUntil } from "cloudflare:workers";
import { mediaStorage, serveImage } from "./lib/takeshape/image-endpoint.ts";
import type { ImageCache } from "./lib/takeshape/image-endpoint.ts";
import { BINDING_MAX_BYTES, fetchTransform } from "./lib/takeshape/image-fetch.ts";
import { cloudflareSteps } from "./lib/takeshape/imgix.ts";
import type { ImagePlan } from "./lib/takeshape/imgix.ts";

export const prerender = false;

/** The Images binding, under the name the Cloudflare adapter gave it. */
function imagesBinding(): ImagesBinding | undefined {
	const name = (globalThis as { __ASTRO_IMAGES_BINDING_NAME?: unknown }).__ASTRO_IMAGES_BINDING_NAME;
	return (env as unknown as Record<string, ImagesBinding | undefined>)[typeof name === "string" && name ? name : "IMAGES"];
}

const stream = (bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array> => new Blob([bytes]).stream();

async function transform(bytes: Uint8Array<ArrayBuffer>, plan: ImagePlan) {
	const images = imagesBinding();
	if (!images) return null;
	// .info() is free. With the source size, the transforms give exact sizes (see cloudflareSteps).
	const info = await images.info(stream(bytes));
	const steps = cloudflareSteps(plan, "width" in info ? info : undefined);
	let image = images.input(stream(bytes));
	// Without the source size, the steps can use fit aspect-crop, which the binding takes and these types don't list yet
	for (const step of steps.transforms) image = image.transform(step as ImageTransform);
	const response = (await image.output(steps.output as ImageOutputOptions)).response();
	return { body: response.body, type: response.headers.get("Content-Type") ?? steps.output.format };
}

// Workers' default cache, which the DOM types Astro loads don't know
const cache = (caches as unknown as { default: ImageCache }).default;

export const GET: APIRoute = ({ request, locals }) =>
	serveImage(request, mediaStorage(locals), transform, {
		cache,
		waitUntil,
		// Without a binding (astro dev), large files go out as stored like the rest
		...(imagesBinding() ? { large: { over: BINDING_MAX_BYTES, transform: (source, plan) => fetchTransform(source, plan) } } : {}),
	});
