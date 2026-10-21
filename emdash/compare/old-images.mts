/**
 * Old images made locally, for compare-sites --media. An old page's TakeShape image is made from its original with
 * the rules the new site's image endpoint follows (imagePlan from tsg2astro/runtime/imgix.ts, then sharpTransform,
 * the Node endpoint's code), so the compare asks neither of TakeShape's hosts for it.
 *
 * That alone would compare the endpoint with itself, so each setting (a URL's parameters, apart from the ones that
 * only change encoding, plus what decides the result about the source) is checked once against imgix's own answer:
 * fetchImgix asks the way a browser does, which imgix likely answers from its cache. Crops where imgix chose the spot
 * from the picture (picksOwnSpot) can't be made locally at all, so the compare fetches them.
 */
import sharp from "sharp";
import { canTransform, imagePlan } from "../tsg2astro/runtime/imgix.ts";
import { sharpTransform } from "../tsg2astro/runtime/image-sharp.ts";
import { HASH_VERSION, imageInfo, imageOf, shownSize } from "./images.mts";
import type { ImageInfo } from "./images.mts";
import { IMAGE_HOST } from "./originals.mts";
import type { Original } from "./originals.mts";

/** Parameters that only change how imgix encoded an image, not what it shows: left out of a setting. */
export const ENCODING_PARAMS: readonly string[] = ["auto", "fm", "q", "cs", "lossless", "ch"];
/** What a browser sends for an image, so imgix picks the format it serves browsers. */
export const IMGIX_ACCEPT = "image/avif,image/webp,image/*,*/*;q=0.8";
/** imgix capped an image without parameters at this many pixels a side. */
const IMGIX_MAX_SIDE = 8192;

/** An original imgix showed as an image (a PDF's first page, a PSD), which can't be made here. */
export class NotMadeLocally extends Error {}

const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", psd: "image/vnd.adobe.photoshop" };

/** The original's type: its extension's, or, for an extension that says nothing, what its header says. */
function typeOf(original: Original): string {
	if (original.type !== "application/octet-stream") return original.type;
	return IMAGE_TYPES[headerType(original.bytes)] ?? original.type;
}

/** The image format a file's first bytes name, as an extension, or "" for none of these. */
function headerType(bytes: Uint8Array): string {
	const head = Buffer.from(bytes.subarray(0, 16));
	if (head[0] === 0xff && head[1] === 0xd8) return "jpg";
	if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
	if (head.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
	if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
	if (head.subarray(4, 12).toString("latin1") === "ftypavif") return "avif";
	if (head.subarray(0, 4).toString("latin1") === "8BPS") return "psd";
	return "";
}

/** Whether imgix picked where to crop from the picture itself: faces, entropy or edges, or fit=facearea. */
export function picksOwnSpot(params: URLSearchParams): boolean {
	const crop = (params.get("crop") ?? "").toLowerCase().split(",");
	return crop.includes("faces") || crop.includes("entropy") || crop.includes("edges") || (params.get("fit") ?? "").toLowerCase() === "facearea";
}

/**
 * The old image for an old page's URL, made from its original. On images.takeshape.io a type the endpoint
 * transforms goes through its plan, or, without size parameters, as stored but capped as imgix capped it; an SVG goes
 * out as stored, as the endpoint sends it. On assets.takeshape.io the old site served the original itself.
 * Rejects with NotMadeLocally for any other type on images.takeshape.io, which imgix showed as a picture.
 */
export async function makeOldImage(url: URL, original: Original): Promise<ImageInfo> {
	if (url.hostname !== IMAGE_HOST) return imageOf(original.bytes);
	const type = typeOf(original);
	if (!canTransform(type)) {
		if (type !== "image/svg+xml") throw new NotMadeLocally(`imgix showed this ${type} file as an image, which can't be made here`);
		return imageOf(original.bytes);
	}
	const plan = imagePlan(url.searchParams);
	if (plan) return imageOf((await sharpTransform(original.bytes, plan)).body);
	const size = shownSize(original.bytes);
	if (size.width <= IMGIX_MAX_SIDE && size.height <= IMGIX_MAX_SIDE) return imageOf(original.bytes);
	const capped = await sharp(original.bytes, { autoOrient: true }).resize(IMGIX_MAX_SIDE, IMGIX_MAX_SIDE, { fit: "inside" }).png().toBuffer();
	return imageOf(new Uint8Array(capped));
}

/**
 * The setting a URL's image falls under, for the rules check: its host, its parameters apart from ENCODING_PARAMS,
 * whether the endpoint transforms the source's type, the source's orientation, and whether a side the parameters
 * ask for (w or h, times dpr) is larger than the source's. An original whose size can't be read gets "unreadable".
 */
export async function settingKey(url: URL, original: Original): Promise<string> {
	const params = [...url.searchParams]
		.filter(([k]) => !ENCODING_PARAMS.includes(k.toLowerCase()))
		.map(([k, v]) => `${k}=${v}`)
		.sort()
		.join("&");
	const transforms = canTransform(typeOf(original)) ? "transformed" : "as-stored";
	let shape = "unreadable";
	let box = "unknown";
	try {
		const { width, height } = shownSize(original.bytes);
		shape = width > height ? "landscape" : width < height ? "portrait" : "square";
		const dpr = Number(url.searchParams.get("dpr")) || 1;
		const w = Number(url.searchParams.get("w")) * dpr;
		const h = Number(url.searchParams.get("h")) * dpr;
		box = !w && !h ? "no-box" : w > width || h > height ? "smaller-than-box" : "fills-box";
	} catch {
		// keeps "unreadable"
	}
	return [url.hostname, params, transforms, shape, box].join("|");
}

/** imgix's own answer for a URL, asked for as a browser asks, fetched once per run. */
export function fetchImgix(url: string, timeoutMs: number): Promise<ImageInfo> {
	return imageInfo(url, timeoutMs, HASH_VERSION, IMGIX_ACCEPT);
}
