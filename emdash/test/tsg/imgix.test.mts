import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	cloudflareSteps,
	cssColor,
	fetchImageOptions,
	focalGravity,
	IMAGE_ENDPOINT,
	imageEndpointUrl,
	imageParamProblem,
	imagePlan,
	layout,
	mediaImageTarget,
	planKey,
} from "../../tsg2astro/runtime/imgix.ts";
import type { ImagePlan } from "../../tsg2astro/runtime/imgix.ts";

const plan = (query: string) => imagePlan(new URLSearchParams(query));
const MEDIA = "/_emdash/api/media/file/k.png";

test("the endpoint answers where astro.shared.mjs adds its route", () => {
	const shared = readFileSync(new URL("../../tsg2astro/scaffold/astro.shared.mjs", import.meta.url), "utf8");
	assert.ok(shared.includes(`pattern: "${IMAGE_ENDPOINT}"`), shared);
});

test("endpoint URLs: honored parameters only, in a fixed order, canonical values", () => {
	assert.equal(imageEndpointUrl(MEDIA, { w: 300 }), "/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fk.png&w=300");
	assert.equal(
		imageEndpointUrl(MEDIA, { q: 80, auto: "compress,format", fm: "JPG", crop: "Faces, top", fit: "crop", dpr: 2, h: 200, w: 300 }),
		"/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fk.png&w=300&h=200&dpr=2&fit=crop&crop=faces%2Ctop&fm=jpg&auto=compress%2Cformat&q=80",
	);
	// Values the endpoint ignores are left out, so equal images share a URL
	assert.equal(imageEndpointUrl(MEDIA, { w: 300, fit: "facearea", blur: 20, fm: "jxl", auto: "enhance", q: 101 }), imageEndpointUrl(MEDIA, { w: 300 }));
	assert.equal(imageEndpointUrl(MEDIA, { w: 300, bg: "#FFF", "fill-color": "nope!" }), "/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fk.png&w=300&bg=%23FFF");
	// No size: the stored file. imgix would recompress it; the old site's images kept their size either way.
	assert.equal(imageEndpointUrl(MEDIA, { auto: "compress,format", fit: "crop" }), MEDIA);
	assert.equal(imageEndpointUrl(MEDIA, { w: 0.5 }), MEDIA);
	assert.equal(imageEndpointUrl(MEDIA, {}), MEDIA);
	// Only EmDash media goes through the endpoint
	assert.equal(imageEndpointUrl("https://images.takeshape.io/a.png", { w: 300 }), "https://images.takeshape.io/a.png");
	// h alone is a size
	assert.equal(imageEndpointUrl(MEDIA, { h: 90 }), "/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fk.png&h=90");
});

test("EmDash media with imgix parameters goes to the endpoint, as TakeShape's asset url took them", () => {
	// A partial can print src="{{ image.url }}?w=400&auto=format"
	const at = (path: string) => mediaImageTarget(new URL(path, "http://site.test"));
	assert.equal(at(`${MEDIA}?w=400&auto=format`), "/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fk.png&w=400&auto=format");
	assert.equal(at("/_emdash/api/media/file/ts-1%20a.jpg?h=90"), "/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fts-1%2520a.jpg&h=90");
	// Without a size, or with nothing the endpoint honors, EmDash serves the file itself
	assert.equal(at(MEDIA), null);
	assert.equal(at(`${MEDIA}?auto=format`), null);
	assert.equal(at(`${MEDIA}?download=1`), null);
	assert.equal(at("/blog/?w=400"), null);
});

test("planKey: requests that come to the same plan share it", () => {
	const key = (query: string) => planKey(plan(query)!);
	assert.match(key("w=300"), /^[0-9a-f]{8}$/);
	assert.equal(key("w=300&h=200&fit=crop"), key("fit=crop&h=200&w=300&utm=1"));
	assert.equal(key("w=300"), key("w=300&auto=compress,format&fit=clip&q=45"));
	assert.notEqual(key("w=300"), key("w=301"));
	assert.notEqual(key("w=300&h=200&fit=crop"), key("w=300&h=200&fit=crop&crop=faces"));
});

test("fit: imgix's modes on Cloudflare's", () => {
	const fits: Record<string, string> = { clip: "contain", max: "scale-down", min: "aspect-crop", crop: "cover", "smart-crop": "cover", scale: "squeeze", fill: "pad", fillmax: "pad" };
	for (const [imgix, cloudflare] of Object.entries(fits)) assert.equal(plan(`w=10&h=10&fit=${imgix}&fill=solid`)!.fit, cloudflare, imgix);
	// imgix's default, clip, enlarges; Cloudflare's default, scale-down, does not. The plan always says which.
	assert.equal(plan("w=10")!.fit, "contain");
	assert.equal(plan("w=10&fit=facearea")!.fit, "contain");
	assert.equal(plan("w=10&h=10&fit=fillmax&bg=fff")!.enlarge, false);
	assert.equal(plan("w=10&h=10&fit=fill&bg=fff")!.enlarge, undefined);
	assert.equal(plan("fit=crop"), null);
	// imgix pads only when told how (checked on TakeShape's CDN): a fill mode, a fill-color or bg
	assert.equal(plan("w=10&h=10&fit=fill")!.fit, "contain");
	assert.deepEqual([plan("w=10&h=10&fit=fillmax")!.fit, plan("w=10&h=10&fit=fillmax")!.enlarge], ["scale-down", undefined]);
	for (const how of ["fill=solid", "fill=blur", "fill-color=red", "bg=red"]) assert.equal(plan(`w=10&h=10&fit=fill&${how}`)!.fit, "pad", how);
});

test("crop: sides, faces, focal point, saliency", () => {
	const gravity = (crop: string, fit = "crop") => plan(`w=10&h=10&fit=${fit}&crop=${crop}`)!.gravity;
	assert.deepEqual(gravity("top"), { x: 0.5, y: 0 });
	assert.deepEqual(gravity("bottom,right"), { x: 1, y: 1 });
	assert.deepEqual(gravity("left"), { x: 0, y: 0.5 });
	assert.equal(gravity("faces"), "face");
	assert.equal(gravity("faces,top"), "face");
	assert.equal(gravity("top,entropy"), "entropy");
	assert.equal(gravity("edges"), "entropy");
	assert.equal(gravity("auto"), "auto");
	assert.equal(gravity("car"), undefined);
	assert.equal(gravity("faces", "min"), "face");
	// crop only steers fits that crop
	assert.equal(gravity("faces", "clip"), undefined);
	assert.equal(plan("w=10&h=10&fit=smart-crop")!.gravity, "auto");
	const focal = plan("w=10&h=10&fit=crop&crop=focalpoint&fp-x=0.2&fp-y=0.9")!;
	assert.deepEqual([focal.gravity, focal.focal], [undefined, { x: 0.2, y: 0.9 }]);
	assert.deepEqual(plan("w=10&h=10&fit=crop&crop=focalpoint&fp-x=7")!.focal, { x: 0.5, y: 0.5 });
});

test("dpr multiplies the size, up to 4,000 pixels a side", () => {
	assert.deepEqual([plan("w=300&h=200&dpr=2")!.width, plan("w=300&h=200&dpr=2")!.height], [600, 400]);
	assert.deepEqual([plan("w=300&dpr=3")!.width, plan("w=300&dpr=3")!.height], [900, undefined]);
	// imgix's dpr goes past Cloudflare's 2, so the plan multiplies instead of passing dpr on
	assert.equal(plan("w=3000&h=1000&dpr=2")!.width, 4000);
	assert.equal(plan("w=3000&h=1000&dpr=2")!.height, 1333);
	assert.equal(plan("w=5000")!.width, 4000);
	assert.equal(plan("w=300&dpr=0")!.width, 300);
});

test("format and quality follow TakeShape's CDN, which added auto=compress,format to every URL", () => {
	const fq = (query: string) => {
		const p = plan(`w=10&${query}`)!;
		return [p.format, p.quality];
	};
	// WebP (the CDN sent WebP or AVIF to browsers that take them) at quality 45 unless q says otherwise
	assert.deepEqual(fq(""), ["webp", 45]);
	assert.deepEqual(fq("auto=compress,format"), ["webp", 45]);
	assert.deepEqual(fq("q=90"), ["webp", 90]);
	// fm picks the format, except with an explicit auto=format
	assert.deepEqual(fq("fm=jpg"), ["jpeg", 45]);
	assert.deepEqual(fq("fm=pjpg&q=0"), ["jpeg", 1]);
	assert.deepEqual(fq("fm=png8&q=60"), ["png", undefined]);
	assert.deepEqual(fq("fm=gif"), ["gif", undefined]);
	assert.deepEqual(fq("fm=avif"), ["avif", 45]);
	assert.deepEqual(fq("auto=format&fm=png"), ["webp", 45]);
	assert.deepEqual(fq("auto=compress&fm=png"), ["png", undefined]);
});

test("background: bg, fill-color, and imgix's padding color", () => {
	// background is bg, for transparent pixels; padColor is fill-color, then bg, for the padding
	const colors = (query: string) => {
		const p = plan(query)!;
		return [p.background, p.padColor];
	};
	assert.deepEqual(colors("w=10&h=10&fit=fill&fill-color=ff0000"), [undefined, "#ff0000"]);
	assert.deepEqual(colors("w=10&h=10&fit=fill&bg=0f0&fill-color=00f"), ["#00ff00", "#0000ff"]);
	assert.deepEqual(colors("w=10&h=10&fit=fill&bg=0f0"), ["#00ff00", "#00ff00"]);
	// Without padding, fill-color does nothing and bg still fills transparent pixels
	assert.deepEqual(colors("w=10&fill-color=red"), [undefined, undefined]);
	assert.deepEqual(colors("w=10&bg=red"), ["red", undefined]);
	// fill=solid without a color: white, or transparent pixels when the format has them
	assert.deepEqual(colors("w=10&h=10&fit=fill&fill=solid&fm=jpg"), [undefined, undefined]);
	assert.deepEqual(colors("w=10&h=10&fit=fill&fill=solid&fm=png"), [undefined, "rgba(0,0,0,0)"]);
	assert.deepEqual(colors("w=10&h=10&fit=fill&fill=solid"), [undefined, "rgba(0,0,0,0)"]);
	assert.equal(plan("w=10&flip=hv")!.flip, "hv");
});

test("cssColor reads imgix colors", () => {
	assert.equal(cssColor("fff"), "#ffffff");
	assert.equal(cssColor("#A1B2C3"), "#a1b2c3");
	// 4 and 8 digits put alpha first
	assert.equal(cssColor("80ff0000"), "rgba(255,0,0,0.502)");
	assert.equal(cssColor("0f00"), "rgba(255,0,0,0)");
	assert.equal(cssColor("tomato"), "tomato");
	assert.equal(cssColor("12345"), null);
	assert.equal(cssColor("rgb(1,2,3)"), null);
});

test("imageParamProblem says what the endpoint does instead", () => {
	assert.equal(imageParamProblem("w", 300), null);
	assert.equal(imageParamProblem("fit", "crop"), null);
	assert.equal(imageParamProblem("auto", "compress,format"), null);
	assert.equal(imageParamProblem("fit", undefined), null);
	assert.equal(imageParamProblem("blur", undefined), "ignores it");
	assert.equal(imageParamProblem("blur", 20), "ignores it");
	assert.equal(imageParamProblem("fit", "facearea"), 'ignores "facearea" and resizes as fit "clip" does');
	assert.equal(imageParamProblem("fm", "jxl"), 'ignores "jxl" and sends WebP');
	assert.equal(imageParamProblem("crop", "car"), 'ignores "car" and crops from the center');
	assert.equal(imageParamProblem("crop", "faces,car,person"), 'ignores "car" and "person" in it');
	assert.equal(imageParamProblem("auto", "compress,enhance"), 'ignores "enhance" in it');
	assert.equal(imageParamProblem("fill", "solid"), null);
	assert.equal(imageParamProblem("fill", "blur"), 'pads with a solid color in place of "blur"');
	assert.equal(imageParamProblem("fill", "nope"), 'ignores "nope"');
	assert.equal(imageParamProblem("w", 0.5), 'ignores "0.5"');
});

const P = (p: Partial<ImagePlan>): ImagePlan => ({ fit: "contain", format: "jpeg", ...p });

test("layout follows Cloudflare's fit modes (the examples in its docs)", () => {
	const src = { width: 1080, height: 720 };
	assert.deepEqual(layout(P({ width: 500, height: 500, fit: "scale-down" }), src), { resize: { width: 500, height: 333 } });
	assert.deepEqual(layout(P({ width: 2000, height: 2000, fit: "scale-down" }), src), { resize: src });
	assert.deepEqual(layout(P({ width: 500, height: 500, fit: "cover" }), src), { resize: { width: 750, height: 500 }, crop: { width: 500, height: 500, left: 125, top: 0 } });
	assert.deepEqual(layout(P({ width: 1080, height: 400, fit: "cover", gravity: { x: 0.5, y: 1 } }), src).crop, { width: 1080, height: 400, left: 0, top: 320 });
	assert.deepEqual(layout(P({ width: 1080, height: 1080, fit: "pad" }), src), { resize: { width: 1080, height: 720 }, pad: { top: 180, bottom: 180, left: 0, right: 0 } });
	assert.deepEqual(layout(P({ width: 1080, height: 540, fit: "squeeze" }), src), { resize: { width: 1080, height: 540 } });
	assert.deepEqual(layout(P({ width: 1920, height: 1120, fit: "aspect-crop" }), { width: 612, height: 613 }), { resize: { width: 612, height: 613 }, crop: { width: 612, height: 357, left: 0, top: 128 } });
	// The 412x600 PNG imgix enlarged to 1000x1456 at w=1000 (default fit), and kept at fit=max
	const alice = { width: 412, height: 600 };
	assert.deepEqual(layout(P({ width: 1000 }), alice), { resize: { width: 1000, height: 1456 } });
	assert.deepEqual(layout(P({ width: 1000, fit: "scale-down" }), alice), { resize: alice });
	// fillmax pads around an image that already fits, without enlarging it
	assert.deepEqual(layout(P({ width: 600, height: 600, fit: "pad", enlarge: false }), alice), { resize: alice, pad: { top: 0, bottom: 0, left: 94, right: 94 } });
	// Face and saliency crops leave the spot to the transformer
	assert.deepEqual(layout(P({ width: 200, height: 200, fit: "cover", gravity: "face" }), alice), { resize: { width: 200, height: 291 }, crop: { width: 200, height: 200 } });
});

test("focal point: imgix centers the crop on it, as far as the image allows", () => {
	const src = { width: 1000, height: 500 };
	const p = P({ width: 200, height: 200, fit: "cover", focal: { x: 0.3, y: 0.5 } });
	// Scaled to 400x200: imgix's crop runs from 0.3 * 400 - 100 = 20, which is 20/200 of the slack
	assert.deepEqual(focalGravity(p, src), { x: 0.1, y: 0.5 });
	const at = layout({ ...p, focal: undefined, gravity: focalGravity(p, src) }, src).crop!;
	assert.equal(at.left! + at.width / 2, 0.3 * 400);
	// Near an edge the crop stops at it
	assert.deepEqual(focalGravity({ ...p, focal: { x: 0.05, y: 0.5 } }, src), { x: 0, y: 0.5 });
});

test("cloudflareSteps: exact sizes from the layout, given the source size", () => {
	const alice = { width: 412, height: 600 };
	const map = { width: 800, height: 282 };
	const steps = (query: string, src: { width: number; height: number }) => cloudflareSteps(plan(query)!, src);
	// Crops name both sides, so cover makes exactly that size
	assert.deepEqual(steps("w=200&h=200&fit=crop&crop=faces&auto=compress,format", alice), {
		transforms: [{ width: 200, height: 200, fit: "cover", gravity: "face" }],
		output: { format: "image/webp", quality: 45 },
	});
	assert.deepEqual(steps("w=300&h=300&fit=crop&crop=entropy", map).transforms, [{ width: 300, height: 300, fit: "cover", gravity: "auto" }]);
	assert.deepEqual(steps("w=300&h=100&fit=crop&crop=bottom,left&flip=h", map).transforms, [{ flip: "h", width: 300, height: 100, fit: "cover", gravity: { x: 0, y: 1, mode: "remainder" } }]);
	assert.deepEqual(steps("w=200&h=200&fit=crop&crop=focalpoint&fp-x=0.3", { width: 1000, height: 500 }).transforms, [{ width: 200, height: 200, fit: "cover", gravity: { x: 0.1, y: 0.5, mode: "remainder" } }]);
	// aspect-crop that can't fill the size: the largest part with its aspect ratio, at the source's scale
	assert.deepEqual(steps("w=1000&h=1000&fit=min", alice).transforms, [{ width: 412, height: 412, fit: "cover" }]);
	// A plain resize squeezes to the size imgix makes: 600 * 1000 / 412 is 1456.3, and Cloudflare would round it down
	assert.deepEqual(steps("w=1000", alice), { transforms: [{ width: 1000, height: 1456, fit: "squeeze" }], output: { format: "image/webp", quality: 45 } });
	assert.deepEqual(steps("w=1000&fit=max&fm=png", alice), { transforms: [{ width: 412, height: 600, fit: "squeeze" }], output: { format: "image/png" } });
	assert.deepEqual(steps("w=100&bg=fff", alice).transforms, [{ background: "#ffffff", width: 100, height: 146, fit: "squeeze" }]);
	// Padding names both sides too
	assert.deepEqual(steps("w=200&h=200&fit=fill&bg=000", alice).transforms, [{ background: "#000000", width: 200, height: 200, fit: "pad" }]);
	// fillmax keeps an image that fits at its size and pads around it
	assert.deepEqual(steps("w=600&h=600&fit=fillmax&fill=solid", alice).transforms, [{ background: "rgba(0,0,0,0)", border: { color: "rgba(0,0,0,0)", top: 0, bottom: 0, left: 94, right: 94 } }]);
	assert.deepEqual(steps("w=300&h=300&fit=fillmax&bg=000", alice).transforms, [{ background: "#000000", width: 300, height: 300, fit: "pad" }]);
});

test("cloudflareSteps without the source size: Cloudflare's fit modes", () => {
	const steps = (query: string) => cloudflareSteps(plan(query)!).transforms;
	assert.deepEqual(steps("w=1000"), [{ width: 1000, fit: "contain" }]);
	assert.deepEqual(steps("w=1000&fit=max"), [{ width: 1000, fit: "scale-down" }]);
	assert.deepEqual(steps("w=300&h=100&fit=crop&crop=bottom,left"), [{ width: 300, height: 100, fit: "cover", gravity: { x: 0, y: 1, mode: "remainder" } }]);
	assert.deepEqual(steps("w=300&h=300&fit=min"), [{ width: 300, height: 300, fit: "aspect-crop" }]);
	assert.deepEqual(steps("w=200&h=200&fit=fill&bg=000"), [{ background: "#000000", width: 200, height: 200, fit: "pad" }]);
	// fillmax can't pad around a smaller image without its size, so it never enlarges
	assert.deepEqual(steps("w=600&h=600&fit=fillmax&bg=000"), [{ background: "#000000", width: 600, height: 600, fit: "scale-down" }]);
});

test("fetchImageOptions: the binding's step and output as one cf.image object", () => {
	const photo = { width: 6000, height: 4004 };
	const options = (query: string, src?: { width: number; height: number }) => fetchImageOptions(plan(query)!, src);
	// w=500 on a 30 MB JPEG: the size imgix makes, 500x334, as WebP at quality 45
	assert.deepEqual(options("w=500&auto=compress,format", photo), { width: 500, height: 334, fit: "squeeze", anim: false, format: "webp", quality: 45 });
	// imgix's default fit, clip, keeps the whole image inside 1200x630
	assert.deepEqual(options("w=1200&h=630&auto=compress,format", photo), { width: 944, height: 630, fit: "squeeze", anim: false, format: "webp", quality: 45 });
	assert.deepEqual(options("w=600&h=600&fit=crop&crop=faces", photo), { width: 600, height: 600, fit: "cover", gravity: "face", anim: false, format: "webp", quality: 45 });
	assert.deepEqual(options("w=300&h=100&fit=crop&crop=bottom,left&flip=h", photo), {
		flip: "h",
		width: 300,
		height: 100,
		fit: "cover",
		gravity: { x: 0, y: 1, mode: "remainder" },
		anim: false,
		format: "webp",
		quality: 45,
	});
	assert.deepEqual(options("w=600&h=600&fit=fillmax&fill=solid&fm=jpg&q=80", { width: 412, height: 600 }), {
		border: { color: "#ffffff", top: 0, bottom: 0, left: 94, right: 94 },
		anim: false,
		format: "jpeg",
		quality: 80,
	});
	// cf.image's "png" can answer JPEG for a photo; "png-force" keeps PNG. PNG has no quality, which would make it PNG8.
	assert.deepEqual(options("w=100&fm=png", photo), { width: 100, height: 67, fit: "squeeze", anim: false, format: "png-force" });
	assert.equal(options("w=100&fm=avif", photo).format, "avif");
	// cf.image can't make a GIF from another format, so a GIF plan leaves the format alone
	assert.deepEqual(options("w=100&fm=gif", photo), { width: 100, height: 67, fit: "squeeze", anim: false });
	// Without the source size: Cloudflare's fit modes, as cloudflareSteps maps them
	assert.deepEqual(options("w=500"), { width: 500, fit: "contain", anim: false, format: "webp", quality: 45 });
});
