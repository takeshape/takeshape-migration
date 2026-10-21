/**
 * The origin that image and file URLs start with. TakeShape's image and asset filters printed absolute URLs on its
 * CDN, and feeds, og:image and JSON-LD need absolute URLs, so the site's own URLs for those files carry its public
 * origin. The origin follows EmDash's order (`api/public-url.ts` in emdash 1.3.0): EMDASH_SITE_URL, then SITE_URL, read
 * at run time, else the request's origin. src/middleware.ts runs each request inside withPublicOrigin(); outside one
 * (tests, the translator) URLs stay as paths.
 *
 * Erasable TypeScript. Imports Node's async_hooks only, which Workers have under nodejs_compat, as EmDash's own
 * request context does.
 */
import { AsyncLocalStorage } from "node:async_hooks";

// One store for the whole site: Vite can copy this module into several chunks (middleware, pages), each with its own
// instance, so the store lives on globalThis, as EmDash keeps its request context
const KEY = Symbol.for("takeshape:public-origin");
const slot = globalThis as unknown as Record<symbol, AsyncLocalStorage<string> | undefined>;
const store = (slot[KEY] ??= new AsyncLocalStorage<string>());

function envOrigin(): string {
	const env = typeof process !== "undefined" ? process.env : undefined;
	const value = env?.EMDASH_SITE_URL || env?.SITE_URL;
	if (!value) return "";
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
	} catch {
		return "";
	}
}

/** The site's public origin for a request to this URL. */
export function publicOrigin(requestUrl: URL): string {
	return envOrigin() || requestUrl.origin;
}

/** Runs one request with its public origin. */
export function withPublicOrigin<T>(origin: string, fn: () => T): T {
	return store.run(origin, fn);
}

/** A site path (`/…`) as an absolute URL on the current request's public origin; anything else as it is. */
export function absoluteUrl(url: string): string {
	const origin = store.getStore();
	return origin && url.startsWith("/") && !url.startsWith("//") ? origin + url : url;
}
