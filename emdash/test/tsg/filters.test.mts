import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { asset, configure, date, image, route } from "../../tsg2astro/runtime/filters.ts";
import { publicOrigin, withPublicOrigin } from "../../tsg2astro/runtime/public-origin.ts";
import type { SiteConfig } from "../../tsg2astro/runtime/filters.ts";

const fixedClock = fileURLToPath(new URL("./fixed-clock.mts", import.meta.url));
const filtersPath = fileURLToPath(new URL("../../tsg2astro/runtime/filters.ts", import.meta.url));

const base: SiteConfig = {
	routes: {
		posts: {
			path: "/posts/:title",
			paginate: { path: "/posts/page-:num" },
		},
	},
	pathPrefix: "",
	imageDefaults: {},
	dates: { format: "LLL", tz: "America/New_York" },
	locale: "en-us",
	mediaPath: "/_emdash/api/media/file",
};

// Ported from takeshape-ssg's own tests of its route filter
test("route", () => {
	configure(base);
	assert.equal(route({ title: "Awesome Article" }, "posts"), "/posts/awesome-article");
});

test("route - paginate", () => {
	configure(base);
	assert.equal(route({ num: 10 }, "posts.paginate"), "/posts/page-10");
});

test("route - a variable that resolves to nothing becomes an empty segment", () => {
	configure(base);
	assert.equal(route({ fake: "Awesome Article" }, "posts"), "/posts/");
});

// A layout can print route(page, page._contentTypeName) on every page, where some queries never ask for
// _contentTypeName. lodash's get takes a missing path, so takeshape-ssg printed "#" there.
test("route - a route name that is missing gives #", () => {
	configure(base);
	assert.equal(route({ title: "A" }, undefined as unknown as string), "#");
	assert.equal(route({ title: "A" }, null as unknown as string), "#");
	assert.equal(route({ title: "A" }, "nope"), "#");
});

test("route - pathPrefix is joined", () => {
	configure({ ...base, pathPrefix: "/docs" });
	assert.equal(route({ title: "A B" }, "posts"), "/docs/posts/a-b");
});

test("route-shape-books", () => {
	configure({
		...base,
		routes: { posts: { path: "/blog/:title/", paginate: { path: "/blog/page-:num/" } }, author: { path: "/authors/:name/" } },
	});
	assert.equal(route({ title: "Jump aboard the new Treasure Island's edition" }, "posts"), "/blog/jump-aboard-the-new-treasure-islands-edition/");
	assert.equal(route(2, "posts.paginate"), "/blog/page-2/");
	assert.equal(route(1, "posts.paginate"), "/blog/page-1/");
	assert.equal(route({}, "author"), "/authors/");
	assert.equal(route({}, "missing"), "#");
});

test("route-shape-books: a route with no path is #", () => {
	configure({ ...base, routes: { author: {} } });
	assert.equal(route({}, "author"), "#");
});

// Ported from takeshape-ssg's own tests of its date filter
test("date - defaults", () => {
	configure(base);
	assert.equal(date("2017-03-16T00:16:50.983Z"), "March 15, 2017 8:16 PM");
});
test("date - custom format", () => {
	configure(base);
	assert.equal(date("2017-03-16T00:16:50.983Z", "dddd MMMM Do YYYY"), "Wednesday March 15th 2017");
});
test("date - custom timezone", () => {
	configure(base);
	assert.equal(date("2017-03-16T00:16:50.983Z", { tz: "America/Los_Angeles" }), "March 15, 2017 5:16 PM");
});
test("date - custom locale", () => {
	configure(base);
	assert.equal(date("2017-03-16T00:16:50.983Z", { locale: "fr" }), "15 mars 2017 20:16");
});
test("date - custom format and tz", () => {
	configure(base);
	assert.equal(date("2017-03-16T00:16:50.983Z", { format: "dddd h:mma", tz: "America/Los_Angeles" }), "Wednesday 5:16pm");
});
test("date - null prints Invalid date", () => {
	configure(base);
	assert.equal(date(null), "Invalid date");
});

test("date-now", () => {
	const script = `import { configure, date } from ${JSON.stringify(filtersPath)};
configure(${JSON.stringify(base)});
console.log(date(undefined, "YYYY"));`;
	const out = execFileSync(process.execPath, ["--import", fixedClock, "--input-type=module", "-e", script], {
		env: { ...process.env, TSG_FIXED_NOW: "2026-10-15T16:00:00.000Z" },
		encoding: "utf8",
	});
	assert.equal(out.trim(), "2026");
});

test("image-null", () => {
	configure(base);
	assert.equal(image(null), "");
	assert.equal(image(undefined), "");
	assert.equal(image(""), "");
	assert.equal(image({ path: null }), "");
	assert.equal(asset(null), "");
	assert.equal(asset({ path: "" }), "");
});

test("image-original", () => {
	configure(base);
	assert.equal(image("01ABC.png"), "/_emdash/api/media/file/01ABC.png");
	assert.equal(image({ path: "01ABC.png" }), "/_emdash/api/media/file/01ABC.png");
	assert.equal(asset("01ABC.png"), "/_emdash/api/media/file/01ABC.png");
	assert.equal(asset({ path: "a b/c.pdf" }), "/_emdash/api/media/file/a%20b/c.pdf");
});

test("image-resized", () => {
	configure(base);
	assert.equal(image({ path: "a b.png" }, { w: 300 }), "/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fa%2520b.png&w=300");
	assert.equal(image("k.png", { w: 300, h: 200, q: 80, fm: "webp" }), "/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fk.png&w=300&h=200&fm=webp&q=80");
	// What takeshape.io's templates pass, in the endpoint's order
	assert.equal(image("k.png", { crop: "faces", fit: "crop", h: 200, w: 200, auto: "compress,format" }), "/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fk.png&w=200&h=200&fit=crop&crop=faces&auto=compress%2Cformat");
});

test("image - defaults merge, empty values drop, parameters the endpoint ignores are left out", () => {
	configure({ ...base, imageDefaults: { q: 70, fit: "crop" } });
	assert.equal(image("k.png", { w: 100 }), "/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fk.png&w=100&fit=crop&q=70");
	// No size: the stored file, as before
	assert.equal(image("k.png", { q: "" }), "/_emdash/api/media/file/k.png");
	assert.equal(image("k.png", { q: "", fit: "max" }), "/_emdash/api/media/file/k.png");
	// An undefined param overrides a default, as in ssg's object spread, and is then dropped
	configure({ ...base, imageDefaults: { w: 640 } });
	assert.equal(image("k.png", { w: undefined }), "/_emdash/api/media/file/k.png");
	// `fit: crop` with crop never defined in the template: neither imgix nor the endpoint gets fit
	assert.equal(image("k.png", { w: 640, fit: undefined }), "/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fk.png&w=640");
	configure(base);
	assert.equal(image("k.png", { w: 1, blur: 20, fit: "facearea", fm: "jxl" }), image("k.png", { w: 1 }));
});

// A hand-built CDN URL the translator rewrites as the image filter carried only its own parameters (templates.mts)
test("image - a rewritten CDN URL takes no defaults", () => {
	configure({ ...base, imageDefaults: { h: 200, fit: "crop" } });
	assert.equal(image("k.png", { w: 300 }, false), "/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fk.png&w=300");
	assert.equal(image("k.png", {}, false), "/_emdash/api/media/file/k.png");
	configure(base);
});

test("route - null follows ssg: typeof null is object, so variables are empty", () => {
	configure(base);
	assert.equal(route(null, "posts.paginate"), "/posts/page-");
	assert.equal(route(null, "posts"), "/posts/");
});

test("image and asset accept an s3Key", () => {
	configure(base);
	assert.equal(image({ s3Key: "a b.png" }), "/_emdash/api/media/file/a%20b.png");
	assert.equal(asset({ s3Key: "k.pdf" }), "/_emdash/api/media/file/k.pdf");
	assert.equal(image({ s3Key: "k.png" }, { w: 5 }), "/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fk.png&w=5");
	assert.equal(image({ path: null, s3Key: "k.png" }), "");
});

// TakeShape's filters printed absolute URLs on its CDN, and feeds, og:image and JSON-LD need them absolute, so inside a
// request the site's own URLs for those files start with its public origin (src/middleware.ts sets it)
test("image and asset print absolute URLs inside a request", () => {
	configure(base);
	withPublicOrigin("https://site.test", () => {
		assert.equal(image("k.png"), "https://site.test/_emdash/api/media/file/k.png");
		assert.equal(image("k.png", { w: 300 }), "https://site.test/_takeshape/image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fk.png&w=300");
		assert.equal(asset("k.pdf"), "https://site.test/_emdash/api/media/file/k.pdf");
		assert.equal(image(null), "");
		assert.equal(asset(""), "");
	});
	assert.equal(image("k.png"), "/_emdash/api/media/file/k.png");
});

test("requests that overlap keep their own origins", async () => {
	configure(base);
	const later = (origin: string, ms: number) =>
		withPublicOrigin(origin, async () => {
			await new Promise((resolve) => setTimeout(resolve, ms));
			return image("k.png");
		});
	assert.deepEqual(await Promise.all([later("https://a.test", 20), later("https://b.test", 5)]), ["https://a.test/_emdash/api/media/file/k.png", "https://b.test/_emdash/api/media/file/k.png"]);
});

// EmDash's order (api/public-url.ts in emdash 1.3.0): EMDASH_SITE_URL, then SITE_URL, at run time, else the request's
test("the public origin follows EmDash: EMDASH_SITE_URL, then SITE_URL, else the request's", () => {
	const saved = { EMDASH_SITE_URL: process.env.EMDASH_SITE_URL, SITE_URL: process.env.SITE_URL };
	try {
		const request = new URL("http://internal:8080/blog/?x=1");
		delete process.env.EMDASH_SITE_URL;
		delete process.env.SITE_URL;
		assert.equal(publicOrigin(request), "http://internal:8080");
		process.env.SITE_URL = "https://site.test/";
		assert.equal(publicOrigin(request), "https://site.test");
		process.env.EMDASH_SITE_URL = "https://www.site.test/some/path";
		assert.equal(publicOrigin(request), "https://www.site.test");
		process.env.EMDASH_SITE_URL = "ftp://files.test";
		assert.equal(publicOrigin(request), "http://internal:8080");
		process.env.EMDASH_SITE_URL = "not a url";
		assert.equal(publicOrigin(request), "http://internal:8080");
	} finally {
		for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

test("route-shape-books with the starter's tsg.yml routes", () => {
	configure({
		...base,
		routes: {
			sitemap: { path: "/sitemap.xml" },
			homepage: { path: "/" },
			posts: { path: "/blog/:title/", paginate: { path: "/blog/page-:num/" } },
			books: { path: "/books/:title/", paginate: {} },
			authors: { path: "/authors/:name/", paginate: {} },
		},
	});
	assert.equal(route({ title: "Jump aboard the new Treasure Island's edition" }, "posts"), "/blog/jump-aboard-the-new-treasure-islands-edition/");
	assert.equal(route(2, "posts.paginate"), "/blog/page-2/");
	assert.equal(route(1, "posts.paginate"), "/blog/page-1/");
	assert.equal(route({}, "author"), "#");
	assert.equal(route({ name: "Robert Louis Stevenson" }, "authors"), "/authors/robert-louis-stevenson/");
});
