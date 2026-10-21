/**
 * imgix's rendering parameters, as TakeShape sites pass them to the `image` filter and to rich-text images, and
 * what the site's image endpoint makes of them. The endpoint (image-endpoint.ts) resizes EmDash media with
 * Cloudflare's Images binding on Workers and with sharp on Node (image-sharp.ts). Both follow the plan built
 * here, in Cloudflare's terms.
 *
 * imgix: https://docs.imgix.com/en-US/apis/rendering. Cloudflare: https://developers.cloudflare.com/images/optimization/features/.
 *
 * This file imports nothing, so tsg2astro's translator reads the same rules when it reports what a site passes
 * that the endpoint can't honor.
 */

/** Where the image endpoint answers. astro.shared.mjs adds the route at the same path. */
export const IMAGE_ENDPOINT = "/_takeshape/image";

/** EmDash's media route. The endpoint serves only files stored there. */
export const MEDIA_PREFIX = "/_emdash/api/media/file/";

/**
 * The version of the rules here and in the transformers. It goes into every ETag and cache key, so raise it with
 * any change that alters the images a plan makes.
 */
const RULES = 1;

/** The largest width or height the endpoint makes, EmDash's own limit (MAX_TRANSFORM_DIMENSION). */
export const MAX_DIMENSION = 4000;

export type Size = { width: number; height: number };
/** Cloudflare's fit modes, the ones imgix's map onto. */
export type Fit = "scale-down" | "contain" | "cover" | "aspect-crop" | "pad" | "squeeze";
/** Which part a crop keeps: detected faces, the most interesting part, or a point in Cloudflare's sense (see `layout`). */
export type Gravity = "face" | "auto" | "entropy" | { x: number; y: number };
export type OutputFormat = "jpeg" | "png" | "webp" | "avif" | "gif";

/** What the endpoint does to one image. */
export type ImagePlan = {
	width?: number;
	height?: number;
	fit: Fit;
	/** false for imgix's fillmax: pad to the size, never enlarging the image. Needs the source size. */
	enlarge?: false;
	gravity?: Gravity;
	/** imgix's focal point (crop=focalpoint, fp-x, fp-y): the crop centers on it when it can. Needs the source size. */
	focal?: { x: number; y: number };
	/** A CSS color for transparent pixels: imgix's bg. */
	background?: string;
	/** A CSS color for padding, with pad only: fill-color, then bg, else transparent in formats that have it. */
	padColor?: string;
	flip?: "h" | "v" | "hv";
	format: OutputFormat;
	/** 1 to 100, for JPEG, WebP and AVIF only. */
	quality?: number;
};

/** imgix fit to Cloudflare fit. clip is imgix's default. */
const FITS: Record<string, Fit> = {
	clip: "contain",
	max: "scale-down",
	min: "aspect-crop",
	crop: "cover",
	"smart-crop": "cover",
	scale: "squeeze",
	fill: "pad",
	fillmax: "pad",
};
const CROPS = new Set(["top", "bottom", "left", "right", "faces", "focalpoint", "entropy", "edges", "auto"]);
const FORMATS: Record<string, OutputFormat> = { jpg: "jpeg", jpeg: "jpeg", pjpg: "jpeg", png: "png", png8: "png", png32: "png", webp: "webp", avif: "avif", gif: "gif" };
const AUTO = new Set(["format", "compress"]);
/** The source types the endpoint transforms. Anything else (SVG, PDF) goes out as stored. */
const SOURCE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
const ALPHA_FORMATS = new Set<OutputFormat>(["png", "webp", "avif", "gif"]);

const number = (v: string): number | undefined => {
	const n = v.trim() === "" ? Number.NaN : Number(v);
	return Number.isFinite(n) ? n : undefined;
};
const inRange = (v: string, min: number, max: number): string | undefined => {
	const n = number(v);
	return n !== undefined && n >= min && n <= max ? String(n) : undefined;
};
/** The tokens of a comma list that `known` holds, in order, without repeats. */
const tokens = (v: string, known: Set<string>): string | undefined => {
	const kept = [...new Set(v.split(",").map((t) => t.trim().toLowerCase()))].filter((t) => known.has(t));
	return kept.length ? kept.join(",") : undefined;
};

/**
 * imgix's color forms (3, 4, 6 or 8 hex digits, where 4 and 8 put alpha first, or a CSS color name) as a CSS
 * color, or null.
 */
export function cssColor(value: string): string | null {
	const v = value.trim().toLowerCase().replace(/^#/, "");
	if (/^[0-9a-f]+$/.test(v)) {
		const hex = v.length === 3 || v.length === 4 ? [...v].map((c) => c + c).join("") : v;
		if (hex.length === 6) return `#${hex}`;
		if (hex.length !== 8) return null;
		const [a, r, g, b] = [0, 2, 4, 6].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number, number];
		return `rgba(${r},${g},${b},${Math.round((a / 255) * 1000) / 1000})`;
	}
	return /^[a-z]+$/.test(v) ? v : null;
}

/**
 * Each parameter the endpoint honors, in the order image URLs carry them, with the value it keeps: canonical,
 * or undefined when it can't use the value. imgix ignores a value it can't use, and so does the endpoint.
 */
const PARAMS: Record<string, (v: string) => string | undefined> = {
	// imgix also reads a w or h below 1 as a share of the source; the endpoint takes pixels only
	w: (v) => inRange(v, 1, Number.MAX_SAFE_INTEGER),
	h: (v) => inRange(v, 1, Number.MAX_SAFE_INTEGER),
	dpr: (v) => {
		const n = number(v);
		return n !== undefined && n > 0 && n <= 10 ? String(n) : undefined;
	},
	fit: (v) => (v.trim().toLowerCase() in FITS ? v.trim().toLowerCase() : undefined),
	crop: (v) => tokens(v, CROPS),
	"fp-x": (v) => inRange(v, 0, 1),
	"fp-y": (v) => inRange(v, 0, 1),
	bg: (v) => (cssColor(v) ? v.trim() : undefined),
	// imgix's blur and gen fills pad too; the endpoint pads with a solid color
	fill: (v) => (["solid", "blur", "gen"].includes(v.trim().toLowerCase()) ? "solid" : undefined),
	"fill-color": (v) => (cssColor(v) ? v.trim() : undefined),
	flip: (v) => (["h", "v", "hv"].includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : undefined),
	fm: (v) => (v.trim().toLowerCase() in FORMATS ? v.trim().toLowerCase() : undefined),
	auto: (v) => tokens(v, AUTO),
	q: (v) => inRange(v, 0, 100),
};

/** The imgix parameters the endpoint honors. */
export const IMGIX_PARAMS: readonly string[] = Object.keys(PARAMS);

/** What the endpoint does instead, when it ignores a value of these parameters. */
const INSTEAD: Record<string, string> = {
	fit: ' and resizes as fit "clip" does',
	crop: " and crops from the center",
	fm: " and sends WebP",
};

/**
 * What the image endpoint does differently from imgix with a parameter, as the end of a sentence that starts
 * "the image endpoint", or null when it honors the parameter. `value` is undefined when the template computes it:
 * then only the name is checked, since any value the endpoint can use reaches it.
 */
export function imageParamProblem(key: string, value?: unknown): string | null {
	const read = PARAMS[key];
	if (!read) return "ignores it";
	if (value === undefined || value === null || value === "") return null;
	const raw = String(value);
	const kept = read(raw);
	if (kept === undefined) return `ignores ${JSON.stringify(raw)}${INSTEAD[key] ?? ""}`;
	if (key === "fill" && raw.trim().toLowerCase() !== kept) return `pads with a solid color in place of ${JSON.stringify(raw)}`;
	if (key === "crop" || key === "auto") {
		const dropped = raw
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t && !kept.split(",").includes(t.toLowerCase()));
		if (dropped.length) return `ignores ${dropped.map((t) => JSON.stringify(t)).join(" and ")} in it`;
	}
	return null;
}

/**
 * The query string of the parameters the endpoint honors, in a fixed order with canonical values, from any
 * source of values. Empty when neither w nor h is set: without a size the old site's images kept their size,
 * and the image goes out as stored.
 */
function canonicalQuery(get: (key: string) => unknown): string {
	const parts: string[] = [];
	for (const [key, read] of Object.entries(PARAMS)) {
		const raw = get(key);
		if (raw === undefined || raw === null || raw === "") continue;
		const kept = read(String(raw));
		if (kept !== undefined) parts.push(`${key}=${encodeURIComponent(kept)}`);
	}
	return parts.some((p) => p.startsWith("w=") || p.startsWith("h=")) ? parts.join("&") : "";
}

/** The image endpoint's URL for `href` with imgix parameters, or `href` itself when it isn't EmDash media or has no size. */
export function imageEndpointUrl(href: string, params: Record<string, unknown>): string {
	const query = canonicalQuery((key) => params[key]);
	if (!query || !href.startsWith(MEDIA_PREFIX)) return href;
	return `${IMAGE_ENDPOINT}?href=${encodeURIComponent(href)}&${query}`;
}

/**
 * Where a request for EmDash media that carries imgix parameters goes: the endpoint. TakeShape's asset `url` was an
 * imgix URL, so templates and browser code add parameters to it by hand (as in `{{ image.url }}?w=400`), and
 * src/middleware.ts sends those here. Null for anything else, so EmDash serves its own media as before.
 */
export function mediaImageTarget(url: URL): string | null {
	if (!url.pathname.startsWith(MEDIA_PREFIX)) return null;
	const target = imageEndpointUrl(url.pathname, Object.fromEntries(url.searchParams));
	return target === url.pathname ? null : target;
}

/**
 * A short hash of a plan and the rules version (FNV-1a), the suffix of a result's ETag and cache key. Requests that
 * come to the same plan share it, and a change to the mapping changes it, so neither a browser nor the cache keeps
 * an image made by older rules.
 */
export function planKey(plan: ImagePlan): string {
	let hash = 0x811c9dc5;
	for (const ch of JSON.stringify([RULES, plan])) {
		hash ^= ch.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/** Whether the endpoint transforms a file of this type. */
export function canTransform(contentType: string): boolean {
	return SOURCE_TYPES.has(contentType);
}

/** Splits a list parameter the endpoint honors into its kept tokens. */
const list = (params: URLSearchParams, key: string): string[] => {
	const raw = params.get(key);
	return (raw === null ? undefined : PARAMS[key]!(raw))?.split(",") ?? [];
};

/**
 * The plan for an endpoint request: imgix's parameters, mapped. Null when the request sets no size, which the
 * image filter never writes, and the endpoint serves the file as stored.
 */
export function imagePlan(params: URLSearchParams): ImagePlan | null {
	const read = (key: string): string | undefined => {
		const raw = params.get(key);
		return raw === null ? undefined : PARAMS[key]!(raw);
	};
	const num = (key: string): number | undefined => {
		const v = read(key);
		return v === undefined ? undefined : Number(v);
	};
	const w = num("w");
	const h = num("h");
	if (w === undefined && h === undefined) return null;

	// dpr multiplies the size, as on imgix, up to the endpoint's largest size
	const dpr = num("dpr") ?? 1;
	const scale = Math.min(dpr, ...[w, h].filter((d): d is number => d !== undefined).map((d) => MAX_DIMENSION / d));
	const plan: ImagePlan = { fit: "contain", format: "jpeg" };
	if (w !== undefined) plan.width = Math.max(1, Math.round(w * scale));
	if (h !== undefined) plan.height = Math.max(1, Math.round(h * scale));

	let fit = read("fit") ?? "clip";
	// imgix pads only when told how: a fill mode or a color. Without one, fill resizes as clip and fillmax as max.
	const color = read("fill-color") ?? read("bg");
	if ((fit === "fill" || fit === "fillmax") && !read("fill") && !color) fit = fit === "fill" ? "clip" : "max";
	plan.fit = FITS[fit]!;
	if (fit === "fillmax") plan.enlarge = false;
	if (plan.fit === "cover" || plan.fit === "aspect-crop") {
		const crop = fit === "smart-crop" ? ["auto"] : list(params, "crop");
		const x = crop.includes("left") ? 0 : crop.includes("right") ? 1 : 0.5;
		const y = crop.includes("top") ? 0 : crop.includes("bottom") ? 1 : 0.5;
		if (x !== 0.5 || y !== 0.5) plan.gravity = { x, y };
		// The first of these wins; imgix tries them in order and falls back to the next
		const first = crop.find((c) => c === "faces" || c === "focalpoint" || c === "entropy" || c === "edges" || c === "auto");
		if (first === "faces") plan.gravity = "face";
		else if (first === "auto") plan.gravity = "auto";
		else if (first === "entropy" || first === "edges") plan.gravity = "entropy";
		else if (first === "focalpoint") {
			delete plan.gravity;
			plan.focal = { x: num("fp-x") ?? 0.5, y: num("fp-y") ?? 0.5 };
		}
	}

	// TakeShape's CDN treated every URL as auto=compress,format: quality 45 unless q is set, and WebP or AVIF for
	// browsers that take them. WebP, which every current browser takes, keeps one result per URL. fm picks
	// another format, as imgix documents, except with an explicit auto=format.
	const fm = read("fm");
	plan.format = fm && !list(params, "auto").includes("format") ? FORMATS[fm]! : "webp";
	// PNG and GIF stay lossless
	if (plan.format === "jpeg" || plan.format === "webp" || plan.format === "avif") plan.quality = Math.max(1, num("q") ?? 45);

	// bg fills transparent pixels, padded or not; the padding takes fill-color, then bg
	const background = cssColor(read("bg") ?? "");
	if (background) plan.background = background;
	if (plan.fit === "pad") {
		const padColor = cssColor(color ?? "");
		// imgix pads with white, or with transparent pixels when the format has them
		if (padColor) plan.padColor = padColor;
		else if (ALPHA_FORMATS.has(plan.format)) plan.padColor = "rgba(0,0,0,0)";
	}

	const flip = read("flip");
	if (flip === "h" || flip === "v" || flip === "hv") plan.flip = flip;
	return plan;
}

/** Where an image goes after scaling, before a crop or padding: the whole scaled image and the parts of it. */
export type Layout = {
	/** The size the whole image scales to. */
	resize: Size;
	/** The part of the scaled image a crop keeps. left and top are absent for face and saliency crops. */
	crop?: Size & { left?: number; top?: number };
	/** Padding around the scaled image, for pad. */
	pad?: { top: number; bottom: number; left: number; right: number };
};

const scaled = (src: Size, s: number): Size => ({ width: Math.max(1, Math.round(src.width * s)), height: Math.max(1, Math.round(src.height * s)) });
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * The geometry of a plan for a source size, following Cloudflare's fit modes. Both transformers make exactly
 * this: sharp on Node, and the Images binding, which is given the sizes outright. A side that follows from the
 * aspect ratio rounds to the nearest pixel, as on imgix; Cloudflare's own fit modes round it down. A point
 * gravity {x, y} works as Cloudflare's does: the crop sits so that the point is at the same relative place in
 * the crop as in the scaled image.
 */
export function layout(plan: ImagePlan, src: Size): Layout {
	const tw = plan.width;
	const th = plan.height;
	const enlarges = plan.fit === "contain" || plan.fit === "cover" || plan.fit === "pad" || plan.fit === "squeeze";
	if (tw === undefined || th === undefined) {
		// One side given: every fit scales to it and keeps the aspect ratio
		let s = tw !== undefined ? tw / src.width : th !== undefined ? th / src.height : 1;
		if (!enlarges || plan.enlarge === false) s = Math.min(1, s);
		return { resize: scaled(src, s) };
	}
	const fill = Math.max(tw / src.width, th / src.height);
	const fitIn = Math.min(tw / src.width, th / src.height);
	switch (plan.fit) {
		case "squeeze":
			return { resize: { width: tw, height: th } };
		case "scale-down":
			return { resize: scaled(src, Math.min(1, fitIn)) };
		case "contain":
			return { resize: scaled(src, fitIn) };
		case "pad": {
			const resize = scaled(src, plan.enlarge === false ? Math.min(1, fitIn) : fitIn);
			const dx = Math.max(0, tw - resize.width);
			const dy = Math.max(0, th - resize.height);
			const left = Math.floor(dx / 2);
			const top = Math.floor(dy / 2);
			return { resize, pad: { top, bottom: dy - top, left, right: dx - left } };
		}
		default: {
			// cover fills the size; aspect-crop does too, but never enlarges
			const resize = scaled(src, plan.fit === "cover" ? fill : Math.min(1, fill));
			let width = Math.min(tw, resize.width);
			let height = Math.min(th, resize.height);
			if (plan.fit === "aspect-crop") {
				// The largest part of the image with the requested aspect ratio, no bigger than the size
				width = Math.min(resize.width, Math.round((resize.height * tw) / th), tw);
				height = Math.min(resize.height, Math.round((resize.width * th) / tw), th);
			}
			const g = plan.gravity;
			if (g === "face" || g === "auto" || g === "entropy") return { resize, crop: { width, height } };
			const { x, y } = g ?? { x: 0.5, y: 0.5 };
			return { resize, crop: { width, height, left: Math.round(x * (resize.width - width)), top: Math.round(y * (resize.height - height)) } };
		}
	}
}

/**
 * imgix's focal point as a Cloudflare gravity point: imgix centers the crop on the point (as far as the image
 * allows), while Cloudflare puts the point at the same relative place in the crop as in the image.
 */
export function focalGravity(plan: ImagePlan, src: Size): Gravity | undefined {
	if (!plan.focal) return plan.gravity;
	const { resize, crop } = layout({ ...plan, focal: undefined, gravity: undefined }, src);
	if (!crop) return undefined;
	const along = (focal: number, whole: number, part: number) => (whole > part ? clamp01((focal * whole - part / 2) / (whole - part)) : 0.5);
	return { x: along(plan.focal.x, resize.width, crop.width), y: along(plan.focal.y, resize.height, crop.height) };
}

/**
 * The Images binding's calls for a plan: each object goes to one `.transform()`, in order, then `output` to
 * `.output()`. With the source size (from the binding's free `.info()`), every output size comes from `layout`,
 * so it matches imgix's and sharp's to the pixel: a plain resize squeezes to the exact size, and crops and
 * padding name both sides. Without the size, the plan maps straight onto Cloudflare's fit modes, which can make
 * a side one pixel shorter.
 */
export function cloudflareSteps(plan: ImagePlan, src?: Size): { transforms: Array<Record<string, unknown>>; output: { format: string; quality?: number } } {
	const output: { format: string; quality?: number } = { format: `image/${plan.format}` };
	if (plan.quality !== undefined) output.quality = plan.quality;
	const t: Record<string, unknown> = {};
	if (plan.flip) t.flip = plan.flip;
	// The binding takes one background color, for transparent pixels and padding alike: with padding, it is the
	// padding's, so a padded image's transparent pixels get the padding color rather than bg (sharp keeps them apart)
	const background = plan.fit === "pad" ? plan.padColor : plan.background;
	if (background) t.background = background;
	const gravity = (g: Gravity) => (g === "entropy" ? "auto" : typeof g === "string" ? g : { x: g.x, y: g.y, mode: "remainder" });

	if (!src) {
		if (plan.width !== undefined) t.width = plan.width;
		if (plan.height !== undefined) t.height = plan.height;
		// fillmax never enlarges; without the size, it can't pad around a smaller image
		t.fit = plan.enlarge === false ? "scale-down" : plan.fit;
		if (plan.gravity) t.gravity = gravity(plan.gravity);
		return { transforms: [{ ...t }], output };
	}

	const g = focalGravity(plan, src);
	const box = layout({ ...plan, gravity: g, focal: undefined }, src);
	if (box.crop) {
		// Both sides given, so cover makes exactly this size
		const step: Record<string, unknown> = { ...t, width: box.crop.width, height: box.crop.height, fit: "cover" };
		if (g) step.gravity = gravity(g);
		return { transforms: [step], output };
	}
	if (box.pad && plan.width !== undefined && plan.height !== undefined) {
		const fits = box.resize.width === src.width && box.resize.height === src.height;
		// fillmax on an image that fits keeps it at its size; pad would enlarge it, so the padding is a border
		if (plan.enlarge === false && fits) return { transforms: [{ ...t, border: { color: plan.padColor ?? "#ffffff", ...box.pad } }], output };
		return { transforms: [{ ...t, width: plan.width, height: plan.height, fit: "pad" }], output };
	}
	return { transforms: [{ ...t, width: box.resize.width, height: box.resize.height, fit: "squeeze" }], output };
}

/**
 * cf.image's names for the plan's formats. Its "png" answered a JPEG for a photo (2026-10-18), "png-force" a PNG.
 * It has no GIF: a GIF plan sends no format, and the image keeps its own.
 */
const FETCH_FORMATS: Record<OutputFormat, string | undefined> = { jpeg: "jpeg", png: "png-force", webp: "webp", avif: "avif", gif: undefined };

/**
 * The options for Cloudflare's other way in, `fetch()` with `cf.image`, which image-fetch.ts takes for files too
 * large for the Images binding: the binding's step and output as one object, under the same names. An animation
 * keeps its first frame, as sharp's does; without `anim: false` Cloudflare sends one over 50 megapixels back as
 * stored (an animated GIF did in a probe on a test account).
 */
export function fetchImageOptions(plan: ImagePlan, src?: Size): Record<string, unknown> {
	const { transforms, output } = cloudflareSteps(plan, src);
	if (transforms.length !== 1) throw new Error(`cf.image takes one transform, and the plan made ${transforms.length}`);
	const options: Record<string, unknown> = { ...transforms[0], anim: false };
	const format = FETCH_FORMATS[plan.format];
	if (format) options.format = format;
	if (output.quality !== undefined) options.quality = output.quality;
	return options;
}
