/**
 * Which pages a route has and what each page's template sees, by takeshape-ssg's rules. The route modules in
 * src/routes call these; each finds the page for the request path, or none, and the page answers 404.
 *
 * - Item pages (ssg generate/streams.ts): one per item, at the route path with each variable filled in from the
 *   item through slugg. An item whose variable is empty gets no page and is no one's neighbor. When two items get
 *   the same path, the first one's page is kept, but both stay in the neighbor chain.
 * - Listing pages (ssg generate/context.ts): `pageSize` items a page, at `paginate.path` with `:num` filled in,
 *   from 1. `firstPage` replaces page 1's path. No items, no listing pages.
 * - Template context (ssg generate/context.ts): the global context and the route's context spread at the top,
 *   plus `global`, `env`, `environmentVariables`, `locale` and `currentPath`, then the page's own names.
 * - URLs (ssg paths.ts): takeshape-ssg wrote a path without a dot as a folder (`<path>/index.html`), so its host
 *   served it at the path with a trailing slash and at `<path>/index.html`, redirected the path without the
 *   slash there, and answered 404 for any URL it had no file for.
 *
 * Migrated sites get this file as source. It imports only files in this folder.
 */
import { formatPath, joinPath } from "./filters.ts";
import type { Entry, Pick } from "./query.ts";

export type ItemPage<T> = { path: string; item: T; previousItem?: T; previousPath?: string; nextItem?: T; nextPath?: string };
export type ListingPage<T> = { path: string; items: T[]; currentPage: number; totalPages: number };

/** The path of one item's page, or null when a path variable has no value (takeshape-ssg wrote no page). */
export function itemPath(pattern: string, item: unknown, pathPrefix = ""): string | null {
	const { path, warnings } = formatPath(pattern, item);
	return warnings.length ? null : joinPath(pathPrefix, path);
}

/** The URL takeshape-ssg's host served a page path at. */
export function pageUrl(path: string): string {
	// <folder>/index.html is the file the host served at <folder>/
	if (path === "index.html" || path.endsWith("/index.html")) return pageUrl(path.slice(0, -"index.html".length) || "/");
	if (path.includes(".")) return path;
	const joined = joinPath(path);
	return joined.endsWith("/") ? joined : `${joined}/`;
}

/** Every item page of a route, in the items' order, with each page's neighbors. */
export function itemPages<T>(items: T[], pattern: string): Array<ItemPage<T>> {
	const chain: Array<{ item: T; path: string }> = [];
	for (const item of items) {
		const path = itemPath(pattern, item);
		if (path !== null) chain.push({ item, path });
	}
	const pages: Array<ItemPage<T>> = [];
	const seen = new Set<string>();
	chain.forEach(({ item, path }, i) => {
		const url = pageUrl(path);
		if (seen.has(url)) return;
		seen.add(url);
		const page: ItemPage<T> = { path, item };
		const previous = chain[i - 1];
		const next = chain[i + 1];
		if (previous) {
			page.previousItem = previous.item;
			page.previousPath = previous.path;
		}
		if (next) {
			page.nextItem = next.item;
			page.nextPath = next.path;
		}
		pages.push(page);
	});
	return pages;
}

/** Every listing page of a route. `path` is the page's path as its template sees it in `currentPath`. */
export function listingPages<T>(items: T[], pageSize: number, pattern: string, firstPage?: string): Array<ListingPage<T>> {
	const totalPages = Math.ceil(items.length / pageSize);
	const pages: Array<ListingPage<T>> = [];
	let buffer: T[] = [];
	const flush = () => {
		const currentPage = pages.length + 1;
		const path = firstPage && currentPage === 1 ? firstPage : formatPath(pattern, { num: currentPage }).path;
		pages.push({ path, items: buffer, currentPage, totalPages });
		buffer = [];
	};
	for (const item of items) {
		buffer.push(item);
		if (buffer.length === pageSize) flush();
	}
	if (buffer.length) flush();
	return pages;
}

/**
 * What an item page needs from its route's list (query.ts Pick): the entry whose page is at `requestPath` and its
 * neighbors, found as itemPages and findPage find them, from the path values `values` gives for an entry. Those are
 * the item's own, built from `columns`. itemPages over the three items gives the page and the neighbors it has among
 * all of them: the page is the first of the chain at its URL, so the one before it has another.
 */
export function itemPick(pattern: string, requestPath: string, columns: readonly string[], values: (entry: Entry) => unknown): Pick {
	return {
		columns,
		entries(list) {
			const chain = list.flatMap((entry) => {
				const path = itemPath(pattern, values(entry));
				return path === null ? [] : [{ entry, path }];
			});
			const wanted = new Set([requestPath, decodePath(requestPath)]);
			const at = chain.findIndex(({ path }) => wanted.has(pageUrl(path)));
			return at < 0 ? [] : chain.slice(Math.max(0, at - 1), at + 2).map((c) => c.entry);
		},
	};
}

/**
 * A read a page starts before it knows it has anything to show (its global context, while it finds its item), so
 * the two go to the database together. When there is no page, nothing awaits it: its failure is not reported.
 */
export function loading<T>(read: Promise<T>): Promise<T> {
	read.catch(() => undefined);
	return read;
}

/** What a listing page needs from its route's list: the entries of the page at `requestPath`, and its numbers. */
export type ListingPick = Pick & { page<T>(items: T[]): ListingPage<T> | null };

/** The pick for a listing page (listingPages, findPage); `page` gives the page with the items built from its entries. */
export function listingPick(pageSize: number, pattern: string, requestPath: string, firstPage?: string): ListingPick {
	let found: ListingPage<Entry> | null = null;
	return {
		columns: [],
		entries(list) {
			found = findPage(listingPages(list, pageSize, pattern, firstPage), requestPath);
			return found ? found.items : [];
		},
		page(items) {
			return found ? { path: found.path, items, currentPage: found.currentPage, totalPages: found.totalPages } : null;
		},
	};
}

function decodePath(path: string): string {
	try {
		return decodeURI(path);
	} catch {
		return path;
	}
}

/** The page served at a request path, or null when takeshape-ssg wrote nothing there. */
export function findPage<P extends { path: string }>(pages: P[], requestPath: string): P | null {
	const wanted = new Set([requestPath, decodePath(requestPath)]);
	return pages.find((page) => wanted.has(pageUrl(page.path))) ?? null;
}

/** Whether a request path is the URL takeshape-ssg's host served one page path at. */
export function isPageUrl(pagePath: string, requestPath: string): boolean {
	return findPage([{ path: pagePath }], requestPath) !== null;
}

/** One way a page file can answer a URL: a route function, and the template that renders what it finds. */
export type Candidate<T> = { find: (path: string) => Promise<Record<string, unknown> | null>; template: T };
export type Answer<T> = { template: T; context: Record<string, unknown> } | { redirect: string } | null;

/**
 * How takeshape-ssg's static host answered a request, for the page file Astro routed it to. The candidates are
 * every route part whose URLs that file can receive, in takeshape-ssg's order, so the first page found is the one
 * the old site served. A folder URL without its trailing slash redirects when a page is there, as the host did;
 * anything else with no page is a 404 (null).
 */
export async function answer<T>(url: { pathname: string; search: string }, candidates: Array<Candidate<T>>): Promise<Answer<T>> {
	for (const { find, template } of candidates) {
		const context = await find(url.pathname);
		if (context) return { template, context };
	}
	const last = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
	if (!last || last.includes(".")) return null;
	const slashed = `${url.pathname}/`;
	for (const { find } of candidates) if (await find(slashed)) return { redirect: `${slashed}${url.search}` };
	return null;
}

/**
 * The folder URL for a request to `<folder>/index.html`, or null. takeshape-ssg wrote every page as an
 * index.html file, and its host served that file at both URLs; old links and sitemaps sometimes use the second.
 */
export function indexFileTarget(url: { pathname: string; search: string }): string | null {
	if (!url.pathname.endsWith("/index.html")) return null;
	return `${url.pathname.slice(0, -"index.html".length)}${url.search}`;
}

/** What an item page adds to the context: `item`, the route's `itemName` alias, and the neighbors. */
export function itemContext<T>(page: ItemPage<T>, itemName?: string): Record<string, unknown> {
	const out: Record<string, unknown> = { item: page.item };
	if (itemName) out[itemName] = page.item;
	if ("previousPath" in page) {
		out.previousItem = page.previousItem;
		out.previousPath = page.previousPath;
	}
	if ("nextPath" in page) {
		out.nextItem = page.nextItem;
		out.nextPath = page.nextPath;
	}
	return out;
}

/** What a listing page adds to the context: its `items` and `pagination`. */
export function listingContext<T>(page: ListingPage<T>): Record<string, unknown> {
	return { items: page.items, pagination: { currentPage: page.currentPage, totalPages: page.totalPages } };
}

/** The context a page's template renders with. */
export function pageContext(
	global: Record<string, unknown>,
	route: Record<string, unknown>,
	extra: Record<string, unknown>,
	env: Record<string, string | undefined>,
	locale: string,
	currentPath: string,
): Record<string, unknown> {
	const globalContext = { ...global, locale };
	return { ...globalContext, ...route, global: globalContext, env, environmentVariables: env, currentPath, ...extra };
}
