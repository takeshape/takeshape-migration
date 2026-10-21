// Fetches a site starting from some paths and follows same-site links. Redirects are recorded, not followed by fetch.
import { parse } from "parse5";
import { componentFileUrls, jsonLdFileUrls } from "./normalize.mts";

// status 0 means the request itself failed (no answer, reset, timeout); error says why.
export type Fetched = { path: string; status: number; location: string | null; contentType: string; body: Uint8Array; error?: string };
export type CrawlOptions = {
	concurrency: number;
	delayMs: number;
	// Also fetch linked CSS, JS, images and files (the new site: they must exist and may mention TakeShape hosts).
	assets?: boolean;
	// Paths already fetched; they are kept and not fetched again.
	known?: Map<string, Fetched>;
	timeoutMs?: number;
	// Stop queueing new paths once this many are known (default 5000); stats.capped says it happened.
	maxPages?: number;
	stats?: { capped: boolean };
	// Drop the query string from crawled same-site paths.
	ignoreQuery?: boolean;
	// More origins that count as this site (www versus bare domain, a production domain).
	origins?: string[];
};

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_PAGES = 5000;

const ASSET_EXT = /\.(?:css|m?js|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|pdf|zip|gz|mp[34]|webm|mov|wav|ogg|docx?|xlsx?|pptx?)$/i;

export function isAsset(path: string): boolean {
	return ASSET_EXT.test(path.split("?")[0]);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A URL or path as the path and query that the site answers to. Another origin's path counts too (a sitemap lists the canonical domain).
export function pathOf(urlOrPath: string, base: string, ignoreQuery = false): string {
	const u = new URL(urlOrPath, base);
	return u.pathname + (ignoreQuery ? "" : u.search);
}

/** Fetches one path. Image, video, audio and font bodies are dropped unless `keepBinary`, to keep the crawl small. */
export async function fetchOne(base: string, path: string, timeoutMs = DEFAULT_TIMEOUT_MS, keepBinary = false): Promise<Fetched> {
	const url = new URL(path, base);
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "compare-sites" }, signal: AbortSignal.timeout(timeoutMs) });
			const contentType = res.headers.get("content-type") ?? "";
			const bytes = new Uint8Array(await res.arrayBuffer());
			const binary = !keepBinary && /^(?:image|video|audio|font)\//i.test(contentType);
			return { path, status: res.status, location: res.headers.get("location"), contentType, body: binary ? new Uint8Array(0) : bytes };
		} catch (e) {
			if (attempt >= 1) {
				const why = e instanceof Error && e.name === "TimeoutError" ? `no answer within ${timeoutMs} ms` : e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
				return { path, status: 0, location: null, contentType: "", body: new Uint8Array(0), error: why };
			}
		}
	}
}

type P5 = { nodeName: string; attrs?: Array<{ name: string; value: string }>; childNodes?: P5[]; content?: P5; value?: string };
const LINK_ATTRS = ["href", "src", "poster", "data-src", "data-href"];

function walk(node: P5, out: string[], origins: string[]) {
	for (const a of node.attrs ?? []) {
		if (LINK_ATTRS.includes(a.name)) out.push(a.value);
		else if (a.name === "srcset" || a.name === "data-srcset") {
			for (const part of a.value.split(",")) {
				const u = part.trim().split(/\s+/)[0];
				if (u) out.push(u);
			}
		} else out.push(...componentFileUrls(a.name, a.value, origins));
	}
	const isJsonLd = node.nodeName === "script" && (node.attrs ?? []).some((a) => a.name === "type" && /ld\+json/i.test(a.value));
	if (isJsonLd) for (const c of node.childNodes ?? []) if (typeof c.value === "string") out.push(...jsonLdFileUrls(c.value, origins));
	for (const c of node.childNodes ?? []) walk(c, out, origins);
	if (node.content) walk(node.content, out, origins);
}

// Same-site links found in a fetched page, as paths (fragment removed).
export function extractLinks(f: Fetched, base: string, opts: { ignoreQuery?: boolean; origins?: string[] } = {}): string[] {
	const text = new TextDecoder().decode(f.body);
	const raw: string[] = [];
	const crossOrigin = new Set<string>();
	if (/html/i.test(f.contentType)) {
		walk(parse(text) as unknown as P5, raw, [new URL(base).origin, ...(opts.origins ?? [])]);
	} else if (/xml/i.test(f.contentType) || f.path.split("?")[0].endsWith(".xml")) {
		for (const m of text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/g)) {
			raw.push(m[1].replace(/&amp;/g, "&"));
			crossOrigin.add(m[1].replace(/&amp;/g, "&"));
		}
	} else if (/css/i.test(f.contentType) || f.path.split("?")[0].endsWith(".css")) {
		for (const m of text.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi)) raw.push(m[2]);
	}
	const sameSite = new Set([new URL(base).origin, ...(opts.origins ?? []).map((o) => new URL(o).origin)]);
	const out: string[] = [];
	for (const r of raw) {
		const v = r.trim();
		if (!v || /^(?:#|mailto:|tel:|javascript:|data:|blob:|sms:)/i.test(v)) continue;
		let u: URL;
		try {
			u = new URL(v, new URL(f.path, base));
		} catch {
			continue;
		}
		if (!/^https?:$/.test(u.protocol)) continue;
		if (!sameSite.has(u.origin) && !crossOrigin.has(v)) continue;
		out.push(u.pathname + (opts.ignoreQuery ? "" : u.search));
	}
	return out;
}

export async function crawl(base: string, seeds: string[], options: CrawlOptions): Promise<Map<string, Fetched>> {
	const result = options.known ?? new Map<string, Fetched>();
	const queued = new Set(result.keys());
	const queue: string[] = [];
	const max = options.maxPages ?? DEFAULT_MAX_PAGES;
	// A seed is fetched even when it looks like an asset: it was asked for by name
	const enqueue = (p: string, seed = false) => {
		if (queued.has(p)) return;
		if (!options.assets && !seed && isAsset(p)) return;
		if (queued.size >= max) {
			if (options.stats) options.stats.capped = true;
			return;
		}
		queued.add(p);
		queue.push(p);
	};
	const seedPaths = new Set(seeds.map((s) => pathOf(s, base, options.ignoreQuery)));
	for (const p of seedPaths) enqueue(p, true);
	const concurrency = Math.max(1, options.concurrency);
	const sameSite = new Set([new URL(base).origin, ...(options.origins ?? []).map((o) => new URL(o).origin)]);
	const linkOpts = { ignoreQuery: options.ignoreQuery, origins: options.origins };
	await new Promise<void>((resolve, reject) => {
		let active = 0;
		let failed = false;
		const pump = () => {
			if (failed) return;
			while (active < concurrency && queue.length > 0) {
				const p = queue.shift() as string;
				active++;
				(async () => {
					if (options.delayMs > 0) await sleep(options.delayMs);
					const f = await fetchOne(base, p, options.timeoutMs, seedPaths.has(p));
					result.set(p, f);
					for (const l of extractLinks(f, base, linkOpts)) enqueue(l);
					if (f.status >= 300 && f.status < 400 && f.location) {
						const t = new URL(f.location, new URL(p, base));
						if (sameSite.has(t.origin)) enqueue(t.pathname + (options.ignoreQuery ? "" : t.search));
					}
				})().then(
					() => {
						active--;
						pump();
					},
					(e) => {
						failed = true;
						reject(e);
					},
				);
			}
			if (active === 0 && queue.length === 0) resolve();
		};
		pump();
	});
	return result;
}
