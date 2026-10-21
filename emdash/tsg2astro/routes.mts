/**
 * Plans the Astro files that answer a takeshape-ssg site's URLs: one per route part, in tsg.yml order. A plain
 * route is one page; a paginated route has item pages (`path` and `template`) and listing pages (`paginate.path`,
 * `paginate.template` and `paginate.pageSize`), with page 1 on its own file when `firstPage` moves it. The rules
 * for which parts a route has follow takeshape-ssg's generate.ts (hasItemPageConfig, hasListPageConfig).
 *
 * File names follow the URL so a developer can find the file behind any page: `/blog/:title/` is
 * `src/pages/blog/[title].astro`, `/blog/` is `src/pages/blog/index.astro`, `/sitemap.xml` is
 * `src/pages/sitemap.xml.ts`. HTML templates become pages, other templates become endpoints.
 *
 * Where URLs overlap, Astro and takeshape-ssg pick differently: Astro by file priority (`blog/about/` before
 * `blog/page-[num]` before `blog/[title]`), takeshape-ssg by the first route that wrote the URL. pageFiles()
 * lists, for each file, every part whose URLs Astro can send it, in takeshape-ssg's order, and the page tries
 * them in turn. A part with the same Astro route as an earlier one shares its file.
 */
import type { TsgConfig, TsgRoute } from "./config.mts";
import type { Report } from "./report.mts";
import { templateKey } from "./scope.mts";

export type RoutePart = "page" | "items" | "listing" | "firstPage";
export type RoutePlan = {
	name: string;
	part: RoutePart;
	/** The path in tsg.yml this part answers: route.path, paginate.path or paginate.firstPage. */
	tsgPath: string;
	file: string;
	params: string[];
	template: string;
	output: "html" | "text";
	/** The Content-Type an endpoint answers with; null for an Astro page. */
	contentType: string | null;
};

export const PAGES_DIR = "src/pages";

const VARIABLE = /:([a-zA-Z][a-zA-Z0-9.]*)|\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;
const HAS_VARIABLE = /:[a-zA-Z]|\{[a-zA-Z][a-zA-Z0-9.]*\}/;

/** What a static host sent for each file type takeshape-ssg wrote. */
const CONTENT_TYPES: Record<string, string> = {
	atom: "application/atom+xml",
	css: "text/css",
	csv: "text/csv",
	htm: "text/html",
	html: "text/html",
	ics: "text/calendar",
	js: "text/javascript",
	json: "application/json",
	md: "text/markdown",
	rss: "application/rss+xml",
	svg: "image/svg+xml",
	txt: "text/plain",
	webmanifest: "application/manifest+json",
	xml: "application/xml",
};

const isHtmlTemplate = (template: string): boolean => /\.html?$/i.test(template);

/** The extension of a path's last segment, lowercased, or null for a folder path. */
function extension(path: string): string | null {
	const last = path.split("/").filter(Boolean).pop() ?? "";
	const m = /\.([A-Za-z0-9]+)$/.exec(last);
	return m && !HAS_VARIABLE.test(last) ? (m[1] as string).toLowerCase() : null;
}

/**
 * The Astro file and its params for a tsg.yml path. `.` and `..` segments resolve as in a URL, so the file stays
 * under src/pages/.
 */
export function astroFile(path: string, output: "html" | "text"): { file: string; params: string[] } {
	// takeshape-ssg wrote <folder>/index.html as the same file as <folder>/, and its host served it at the folder
	// URL, so the page is the folder's (src/middleware.ts sends the index.html URL there)
	const tsgPath = path === "index.html" || path.endsWith("/index.html") ? path.slice(0, -"index.html".length) || "/" : path;
	const params: string[] = [];
	const resolved: string[] = [];
	for (const s of tsgPath.split("/")) {
		if (s === "..") resolved.pop();
		else if (s && s !== ".") resolved.push(s);
	}
	const segments = resolved.map((s) =>
		s.replace(VARIABLE, (_m, colon: string | undefined, curly: string | undefined) => {
			const name = (colon ?? curly ?? "").replace(/\./g, "_");
			params.push(name);
			return `[${name}]`;
		}),
	);
	const ext = output === "html" ? ".astro" : ".ts";
	let base: string;
	if (!segments.length) base = "index";
	else if (extension(tsgPath)) base = segments.join("/");
	else if (tsgPath.endsWith("/") && !segments[segments.length - 1]!.includes("[")) base = `${segments.join("/")}/index`;
	else base = segments.join("/");
	return { file: `${PAGES_DIR}/${base}${ext}`, params };
}

/** Two files Astro routes the same way: the same path with any param names, `x/index` and `x` alike. */
const routeShape = (file: string): string =>
	file
		.replace(/\[[^\]]*\]/g, "[]")
		.replace(/\.(astro|ts)$/, "")
		.replace(/\/index$/, "");

/** The page Astro shows for any URL no other file answers, which the generated pages rewrite to. */
export const NOT_FOUND_PAGE = `${PAGES_DIR}/404.astro`;

/** Whether a page file is Astro's 404 route (`src/pages/404.astro` or `src/pages/404/index.astro`). */
export const isNotFoundRoute = (file: string): boolean => routeShape(file) === `${PAGES_DIR}/404`;

/**
 * The other routes Astro keeps for itself, or null: `/500`, its server-error page, and `/3xx`, the page it uses for
 * redirects when `experimental.redirectPage` is on (astro/dist/core/routing/internal/route-errors.js in 7.4).
 */
export function reservedRoute(file: string): "500" | "3xx" | null {
	const shape = routeShape(file);
	if (shape === `${PAGES_DIR}/500`) return "500";
	if (shape === `${PAGES_DIR}/3xx`) return "3xx";
	return null;
}

/** Whether one page file can serve both parts: both pages, or endpoints with the same Content-Type. */
const sameKind = (a: RoutePlan, b: RoutePlan): boolean => a.output === b.output && a.contentType === b.contentType;
const kind = (p: RoutePlan): string => (p.output === "html" ? "an HTML page" : `a ${p.contentType} file`);

// A URL pattern as tokens: a character, ONE (any character but "/") or MANY (any number of them). A variable is
// ONE then MANY, since takeshape-ssg wrote no page for an empty value.
const ONE = 1;
const MANY = 2;
type Token = string | typeof ONE | typeof MANY;

function urlTokens(tsgPath: string): Token[] {
	let path = `/${tsgPath}`.replace(/\/+/g, "/");
	// <folder>/index.html is served at <folder>/
	if (path.endsWith("/index.html")) path = path.slice(0, -"index.html".length);
	if (!extension(path) && !path.endsWith("/")) path += "/";
	const out: Token[] = [];
	path.split(/(:[a-zA-Z][a-zA-Z0-9.]*|\{[a-zA-Z][a-zA-Z0-9.]*\})/).forEach((piece, i) => {
		if (i % 2) out.push(ONE, MANY);
		else out.push(...piece);
	});
	return out;
}

/** Whether two tsg.yml paths can give the same URL. Variables may hold anything but "/", so this errs on yes. */
export function urlsOverlap(a: string, b: string): boolean {
	const x = urlTokens(a);
	const y = urlTokens(b);
	const seen = new Map<number, boolean>();
	const fits = (s: Token, t: Token): boolean => (typeof s === "string" && typeof t === "string" ? s === t : s !== "/" && t !== "/");
	const go = (i: number, j: number): boolean => {
		if (i === x.length && j === y.length) return true;
		const key = i * (y.length + 1) + j;
		const known = seen.get(key);
		if (known !== undefined) return known;
		seen.set(key, false);
		let ok = false;
		const s = x[i];
		const t = y[j];
		if (s === MANY) ok = go(i + 1, j);
		if (!ok && t === MANY) ok = go(i, j + 1);
		if (!ok && s !== undefined && t !== undefined && !(s === MANY && t === MANY) && fits(s, t)) {
			ok = go(s === MANY ? i : i + 1, t === MANY ? j : j + 1);
		}
		seen.set(key, ok);
		return ok;
	};
	return go(0, 0);
}

export type PageFile = { file: string; owner: RoutePlan; candidates: RoutePlan[] };

/**
 * One entry per page file: the parts it serves (`owner` first) and every part whose URLs Astro can send it,
 * in the order the file tries them. Astro picks a file by its own priority (static before `page-[num]` before
 * `[title]`), where takeshape-ssg gave a URL to the first route that wrote it. So each file tries every route
 * that can give its URLs, in tsg.yml order; within one route, whose parts never wrote the same URL in a fixed
 * order, its own part goes first.
 */
export function pageFiles(plans: RoutePlan[]): PageFile[] {
	const routeIndex = new Map<string, number>();
	for (const p of plans) if (!routeIndex.has(p.name)) routeIndex.set(p.name, routeIndex.size);
	const files: PageFile[] = [];
	for (const owner of plans) {
		if (files.some((f) => f.file === owner.file)) continue;
		const own = plans.filter((p) => p.file === owner.file);
		const rank = (q: RoutePlan): [number, number, number] => [routeIndex.get(q.name) as number, q.file === owner.file ? 0 : 1, plans.indexOf(q)];
		const candidates = plans
			.filter((q) => sameKind(q, owner) && own.some((p) => urlsOverlap(p.tsgPath, q.tsgPath)))
			.sort((a, b) => {
				const [ra, rb] = [rank(a), rank(b)];
				return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
			});
		files.push({ file: owner.file, owner, candidates });
	}
	return files;
}

export function planRoutes(config: TsgConfig, report: Report): RoutePlan[] {
	const plans: RoutePlan[] = [];
	const notTranslated = (name: string, message: string) => report.add({ kind: "not-translated", file: "tsg.yml", construct: name, message });
	const note = (name: string, message: string) => report.add({ kind: "route", file: "tsg.yml", construct: name, message });

	const part = (name: string, kind: RoutePart, tsgPath: string, template: string): RoutePlan | null => {
		const output = isHtmlTemplate(template) ? "html" : "text";
		const ext = extension(tsgPath);
		if (output === "html" && ext && ext !== "html" && ext !== "htm") {
			notTranslated(name, `The HTML template ${template} writes ${tsgPath}, which an Astro page cannot serve as a .${ext} file.`);
			return null;
		}
		const { file, params } = astroFile(tsgPath, output);
		const contentType = output === "html" ? null : (CONTENT_TYPES[ext ?? "html"] ?? "application/octet-stream");
		return { name, part: kind, tsgPath, file, params, template: templateKey(template), output, contentType };
	};

	const locales = Object.keys(config.locales ?? {});
	if (locales.length) {
		report.add({
			kind: "not-translated",
			file: "tsg.yml",
			construct: "locales",
			message: `takeshape-ssg built the site once per locale (${locales.join(", ")}), each under its pathPrefix. tsg2astro translates one build, without a prefix, in the default locale ${config.locale}.`,
		});
	}
	for (const [name, route] of Object.entries(config.routes ?? {}) as Array<[string, TsgRoute]>) {
		const parts: RoutePlan[] = [];
		let refused = false;
		const add = (p: RoutePlan | null) => {
			if (p) parts.push(p);
			else refused = true;
		};
		const paginate = route.paginate;
		if (paginate) {
			if (paginate.property) {
				notTranslated(name, `The route pages through the "${paginate.property}" property of its context (paginate.property), which tsg2astro does not translate yet, so it has no pages.`);
				continue;
			}
			if (!paginate.data) {
				note(name, "The route has paginate but neither data nor property, so takeshape-ssg wrote no pages for it, and it has none here.");
				continue;
			}
			if (route.path && route.template) add(part(name, "items", route.path, route.template));
			if (paginate.pageSize && paginate.template && paginate.path) {
				add(part(name, "listing", paginate.path, paginate.template));
				if (paginate.firstPage) add(part(name, "firstPage", paginate.firstPage, paginate.template));
			}
			if (!parts.length && !refused) {
				note(name, "The route sets neither path and template (item pages) nor paginate.path, paginate.template and paginate.pageSize (listing pages), so takeshape-ssg wrote no pages for it.");
			}
		} else {
			if (!route.path || !route.template) {
				notTranslated(name, "The route needs both path and template. takeshape-ssg could not build it, so it has no page here.");
				continue;
			}
			if (HAS_VARIABLE.test(route.path)) {
				notTranslated(name, `The path ${route.path} has variables but the route does not paginate, so takeshape-ssg wrote it literally. tsg2astro does not serve literal variable paths.`);
				continue;
			}
			add(part(name, "page", route.path, route.template));
		}
		for (const p of parts) {
			// Astro allows one file per route: a part with the same route as an earlier one shares its file
			const same = plans.find((q) => routeShape(q.file) === routeShape(p.file));
			if (same && !sameKind(same, p)) {
				notTranslated(
					name,
					`${p.tsgPath} answers the same URLs as ${same.tsgPath} (route "${same.name}"), but one is ${kind(same)} and the other ${kind(p)}. One Astro file cannot serve both, so only route "${same.name}" is served there.`,
				);
				continue;
			}
			if (same) {
				p.file = same.file;
				p.params = same.params;
			}
			plans.push(p);
		}
	}
	// URLs that a later route could also give: the files for them try the routes in tsg.yml order (pageFiles)
	plans.forEach((p, i) => {
		const earlier = plans.slice(0, i).filter((q) => q.name !== p.name && urlsOverlap(q.tsgPath, p.tsgPath));
		for (const q of earlier.filter((q) => !sameKind(q, p))) {
			notTranslated(
				p.name,
				`${p.tsgPath} can give the same URLs as ${q.tsgPath} (route "${q.name}"), but one is ${kind(q)} and the other ${kind(p)}, so a URL both could answer goes to whichever file Astro picks for it.`,
			);
		}
		const tried = earlier.filter((q) => sameKind(q, p));
		if (tried.length) {
			const list = tried.map((q) => `${q.tsgPath} (route "${q.name}")`);
			note(
				p.name,
				`${p.tsgPath} can give the same URLs as ${list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0]}. The page files for those URLs, ${p.file} among them, try each route in tsg.yml order, so the first route that wrote a URL answers it, as on the old site.`,
			);
		}
	});
	return plans;
}
