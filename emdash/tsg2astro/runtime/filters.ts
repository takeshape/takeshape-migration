/**
 * The TakeShape template filters a migrated site calls: `ts.route`, `ts.date`,
 * `ts.image` and `ts.asset`. A port of takeshape-ssg's route, date, image and
 * asset filters, plus the path helpers they use from @takeshape/routing.
 * context.ts shares `formatPath` and `joinPath` for page paths. Resized images
 * point at the image endpoint, whose URLs imgix.ts writes.
 *
 * Migrated sites get this file as source. It is erasable TypeScript and imports
 * only packages the generated project lists: slugg 1.2.1, moment 2.30.1 and
 * moment-timezone 0.5.32. Images and assets resolve to EmDash media URLs instead
 * of TakeShape's CDN, absolute inside a request as TakeShape's were (public-origin.ts).
 */

import moment from "moment-timezone";
import slugg from "slugg";
import { imageEndpointUrl } from "./imgix.ts";
import { absoluteUrl } from "./public-origin.ts";

export type SiteConfig = {
	routes: Record<string, { path?: string; paginate?: { path?: string } }>;
	pathPrefix: string;
	imageDefaults: Record<string, unknown>;
	dates: { tz: string; format: string };
	locale: string;
	/** Where EmDash serves stored media, e.g. "/_emdash/api/media/file". */
	mediaPath: string;
};

let config: SiteConfig | undefined;

/** Called once by the generated site with the values from tsg.yml. */
export function configure(next: SiteConfig): void {
	config = next;
}

function current(): SiteConfig {
	if (!config) throw new Error("ts filters used before configure() was called");
	return config;
}

/** Like lodash `get` for string paths: dot segments, `[0]` indexes, numeric segments into arrays. */
function get(obj: unknown, path: string): unknown {
	// lodash reads any other path (undefined from a field the query never asked for) as one key
	if (typeof path !== "string") return obj === null || obj === undefined ? undefined : (obj as Record<string, unknown>)[String(path)];
	const segments: string[] = [];
	path.replace(/[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g, (match, num, quote, str) => {
		segments.push(quote ? String(str).replace(/\\(\\)?/g, "$1") : num !== undefined ? String(num) : match);
		return "";
	});
	let value: unknown = obj;
	for (const segment of segments) {
		if (value === null || value === undefined) return undefined;
		value = (value as Record<string, unknown>)[segment];
	}
	return value;
}

const VARIABLE = /:([a-zA-Z][a-zA-Z0-9.]*)|\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;

/**
 * @takeshape/routing formatPath: `:name` and `{name}` become the slugged value. `warnings` names each
 * variable that had no value; takeshape-ssg wrote no item page for an item with one (context.ts).
 */
export function formatPath(pathStr: string, data: unknown): { path: string; warnings: string[] } {
	const warnings: string[] = [];
	const path = pathStr.replace(VARIABLE, (_match, colon: string | undefined, curly: string | undefined) => {
		const name = (colon || curly) as string;
		if (typeof data === "object") {
			const value = String(get(data, name) || "");
			if (value === "") warnings.push(name);
			return slugg(value);
		}
		if (name === "num" || name === "value") return slugg(String(data));
		warnings.push(name);
		return "";
	});
	return { path, warnings };
}

/** ssg's joinPath: `path.join("/", ...parts.filter(Boolean))`, with its normalization. */
export function joinPath(...parts: string[]): string {
	const joined = ["/", ...parts.filter(Boolean)].join("/");
	const out: string[] = [];
	for (const segment of joined.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") out.pop();
		else out.push(segment);
	}
	const result = `/${out.join("/")}`;
	return joined.endsWith("/") && result !== "/" ? `${result}/` : result;
}

export function route(obj: unknown, routeName: string): string {
	const { routes, pathPrefix } = current();
	const found = get(routes, routeName) as { path?: string } | undefined;
	if (!found?.path) return "#";
	return joinPath(pathPrefix, formatPath(found.path, obj).path);
}

export function date(value: unknown, options: string | { format?: string; tz?: string; locale?: string } = {}): string {
	const { dates, locale: defaultLocale } = current();
	const opts = typeof options === "string" ? { format: options } : (options ?? {});
	const { format = dates.format, tz = dates.tz, locale = defaultLocale } = opts;
	const m = moment.utc(value as moment.MomentInput).tz(tz);
	m.locale(locale);
	return m.format(format);
}

function keyPath(key: unknown): string {
	if (typeof key === "string") return key;
	if (key !== null && typeof key === "object") {
		// ssg's getPath: `path` when the key has one, otherwise `s3Key`
		const path = "path" in key ? (key as { path: unknown }).path : (key as { s3Key?: unknown }).s3Key;
		return typeof path === "string" ? path : "";
	}
	return "";
}

function mediaUrl(path: string): string {
	return `${current().mediaPath}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function asset(key: unknown): string {
	const path = keyPath(key);
	return path ? absoluteUrl(mediaUrl(path)) : "";
}

/**
 * The image filter. `defaults` false leaves out tsg.yml's imageDefaults: tsg2astro rewrites a hand-built CDN URL
 * (`https://images.takeshape.io/{{ x.path }}?w=300`) as this filter, and that URL carried only its own parameters.
 */
export function image(key: unknown, params: Record<string, unknown> = {}, defaults = true): string {
	const path = keyPath(key);
	if (!path) return "";
	// imgix.ts lists the parameters the endpoint honors; tsg2astro reports each other one it sees
	return absoluteUrl(imageEndpointUrl(mediaUrl(path), defaults ? { ...current().imageDefaults, ...params } : { ...params }));
}
