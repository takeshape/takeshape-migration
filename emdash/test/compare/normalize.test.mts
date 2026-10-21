import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalLines, componentFileUrls, jsonLdFileUrls, normalizeHtml, normalizeXml } from "../../compare/normalize.mts";

const norm = (html: string, origins: string[] = []) => normalizeHtml(html, { origins });
const lines = (html: string, origins: string[] = []) => canonicalLines(norm(html, origins).tree);
const same = (a: string, b: string, origins: string[] = []) => assert.deepEqual(lines(a, origins), lines(b, origins));
const differ = (a: string, b: string, origins: string[] = []) => assert.notDeepEqual(lines(a, origins), lines(b, origins));

test("whitespace-and-comments", () => {
	same("<p> a  <!-- x -->b </p>", "<p>a b</p>");
});

test("attribute-order", () => {
	same('<a class="x" href="/a">t</a>', '<a href="/a" class="x">t</a>');
});

test("origin-stripped", () => {
	same('<a href="https://old.test/books/x/">t</a>', '<a href="/books/x/">t</a>', ["https://old.test"]);
});

test("image-placeholder", () => {
	const a = "https://images.takeshape.io/p/a.png?auto=compress%2Cformat";
	const b = "/_emdash/api/media/file/01J.png";
	const r = norm(`<img src="${a}"><img src="${b}">`);
	same(`<img src="${a}"><img src="${b}">`, '<img src="[image]"><img src="[image]">');
	assert.deepEqual(r.images, [a, b]);
});

test("image-other-places", () => {
	const html =
		'<meta property="og:image" content="https://old.test/x/cover.jpg"><div style="background:url(/_image?href=%2Fa&w=10)"></div>' +
		'<picture><source srcset="https://images.takeshape.io/a.png 1x, https://images.takeshape.io/b.png 2x"></picture>' +
		'<a href="/files/doc.pdf">d</a><a href="https://assets.takeshape.io/q/photo.jpg">p</a><img data-src="/z/lazy.webp">';
	const r = norm(html, ["https://old.test"]);
	assert.deepEqual(r.images, [
		"https://old.test/x/cover.jpg",
		"/_image?href=%2Fa&w=10",
		"https://images.takeshape.io/a.png",
		"https://images.takeshape.io/b.png",
		"https://assets.takeshape.io/q/photo.jpg",
		"/z/lazy.webp",
	]);
	const out = lines(html, ["https://old.test"]).join("\n");
	assert.match(out, /content="\[image\]"/);
	assert.match(out, /href="\/files\/doc.pdf"/);
	assert.match(out, /href="\[image\]"/);
	assert.match(out, /data-src="\[image\]"/);
});

test("pre-keeps-whitespace", () => {
	differ("<pre>a  b</pre>", "<pre>a b</pre>");
});

test("stray-end-tag", () => {
	same("<main><section>a</article></section></main>", "<main><section>a</section></main>");
});

test("sitemap-xml", () => {
	const a = '<?xml version="1.0"?><urlset><url><loc>https://old.test/a/</loc></url></urlset>';
	const b = '<?xml version="1.0"?>\n<urlset>\n  <url>\n    <loc>https://new.test/a/</loc>\n  </url>\n</urlset>';
	assert.deepEqual(normalizeXml(a, { origins: ["https://old.test"] }), normalizeXml(b, { origins: ["https://new.test"] }));
});

test("different-content-differs", () => {
	differ("<p>a</p>", "<p>b</p>");
});

// Block-aware whitespace
test("inline-space-kept", () => {
	differ("<p>a <b>x</b></p>", "<p>a<b>x</b></p>");
	differ("<p><b>a</b> <b>b</b></p>", "<p><b>a</b><b>b</b></p>");
});

test("block-whitespace-dropped", () => {
	same("<p>a</p>\n<p>b</p>", "<p>a</p><p>b</p>");
	same("<div>\n  <p>a</p>\n</div>", "<div><p>a</p></div>");
	same("<p> a </p>", "<p>a</p>");
});

test("nbsp-is-content", () => {
	differ("<p>&nbsp;</p>", "<p></p>");
	differ("<p>a&nbsp;b</p>", "<p>a b</p>");
	assert.notDeepEqual(normalizeXml("<a>&#160;</a>", { origins: [] }), normalizeXml("<a></a>", { origins: [] }));
});

test("file-links", () => {
	same('<a href="https://assets.takeshape.io/p/doc.pdf">d</a>', '<a href="/_emdash/api/media/file/01J.pdf">d</a>');
	differ('<a href="https://assets.takeshape.io/p/doc.pdf">d</a>', '<a href="/other/doc.pdf">d</a>');
	same('<a href="https://assets.takeshape.io/p/a.png">d</a>', '<a href="/_emdash/api/media/file/01J.png">d</a>');
	assert.match(lines('<a href="/_emdash/api/media/file/01J.pdf">d</a>').join("\n"), /\[file\]/);
});

test("anchor-image-extension-not-hidden", () => {
	differ('<a href="/x/a.jpg">t</a>', '<a href="/y/b.png">t</a>');
	same('<img src="/x/a.jpg">', '<img src="/y/b.png">');
});

test("origins-in-meta-and-json-ld", () => {
	const o = ["https://old.test"];
	same('<meta property="og:url" content="https://old.test/a/">', '<meta property="og:url" content="/a/">', o);
	same('<meta name="twitter:url" content="https://old.test/a/">', '<meta name="twitter:url" content="/a/">', o);
	same('<link rel="canonical" href="https://old.test/a/">', '<link rel="canonical" href="/a/">', o);
	same('<meta http-equiv="refresh" content="0; url=https://old.test/a/">', '<meta http-equiv="refresh" content="0; url=/a/">', o);
	same(
		'<script type="application/ld+json">{"url": "https://old.test/a/", "x": "https://old.test"}</script>',
		'<script type="application/ld+json">{"url": "/a/", "x": "/"}</script>',
		o,
	);
	differ('<meta property="og:url" content="/a/">', '<meta property="og:url" content="/b/">', o);
});

test("script-and-style-text-raw", () => {
	differ("<script>var a  = 1;</script>", "<script>var a = 1;</script>");
	differ("<style>a  b{}</style>", "<style>a b{}</style>");
});

test("images-in-document-order-and-attribute-name-order", () => {
	// Elements in document order; inside one, by attribute name (src before srcset), as the attributes compare
	const r = norm('<img srcset="/_image?w=1 1x" src="/_image?w=2"><img src="/_image?w=3">');
	assert.deepEqual(r.images, ["/_image?w=2", "/_image?w=1", "/_image?w=3"]);
	// The translated site's image endpoint
	assert.deepEqual(norm('<img src="/_takeshape/image?href=%2Fa&w=10">').images, ["/_takeshape/image?href=%2Fa&w=10"]);
});

test("srcset-forms", () => {
	assert.deepEqual(norm('<img srcset="/a.png 1x,/b.png 2x">').images, ["/a.png", "/b.png"]);
	assert.deepEqual(norm('<img srcset="/a.png 1x, /b.png 2x">').images, ["/a.png", "/b.png"]);
	assert.deepEqual(norm('<img srcset="https://images.takeshape.io/a.png?auto=compress,format 480w, /b.png 960w">').images, [
		"https://images.takeshape.io/a.png?auto=compress,format",
		"/b.png",
	]);
	same('<img srcset="/a.png 1x,/b.png 2x">', '<img srcset="/a.png 1x, /b.png 2x">');
});

// XML
test("xml-feed-origins-and-entities", () => {
	const o = { origins: ["https://old.test"] };
	const n = { origins: ["https://new.test"] };
	const a =
		'<rss xmlns:atom="http://www.w3.org/2005/Atom"><channel><link>https://old.test/</link><atom:link href="https://old.test/feed.xml" rel="self"/>' +
		'<item><guid>https://old.test/a/</guid><enclosure url="https://old.test/f.mp3" length="1"/><title><![CDATA[a & b]]></title></item></channel></rss>';
	const b =
		'<rss xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n<link>https://new.test/</link>\n<atom:link rel="self" href="https://new.test/feed.xml"/>\n' +
		'<item><guid>https://new.test/a/</guid><enclosure length="1" url="https://new.test/f.mp3"/><title>a &amp; b</title></item></channel></rss>';
	assert.deepEqual(normalizeXml(a, o), normalizeXml(b, n));
});

test("xml-gt-in-attribute", () => {
	const x = normalizeXml('<a title="x > y"><b/></a>', { origins: [] });
	assert.deepEqual(x, ['<a title="x > y">', "  <b>", "  </b>", "</a>"]);
});

// An image in JSON-LD is collected as written, origin included, so the image check fetches it (and finds it in an
// image index) by that URL; the normalized text still drops the origin
test("JSON-LD images keep their origin for the image check", () => {
	const html = '<script type="application/ld+json">{ "logo": "https://old.example/logo.png", "url": "https://old.example/about/" }</script>';
	const r = normalizeHtml(html, { origins: ["https://old.example"] });
	assert.deepEqual(r.images, ["https://old.example/logo.png"]);
	const text = canonicalLines(r.tree).join("\n");
	assert.ok(text.includes("[image]") && text.includes("/about/") && !text.includes("old.example"), text);
});

// JSON allows \/ for / and & for &: a URL written that way is the same URL, compared and fetched decoded
test("JSON-LD URLs with JSON escapes are read decoded", () => {
	const html = '<script type="application/ld+json">{ "logo": "https:\\/\\/images.takeshape.io\\/p\\/logo.png?w=1\\u0026h=2", "video": "\\/_emdash\\/api\\/media\\/file\\/clip.mp4", "name": "A \\"quoted\\" name" }</script>';
	const r = normalizeHtml(html, { origins: [] });
	assert.deepEqual(r.images, ["https://images.takeshape.io/p/logo.png?w=1&h=2"]);
	const text = canonicalLines(r.tree).join("\n");
	assert.ok(text.includes("[image]") && text.includes("[file]") && text.includes('quoted'), text);
	assert.deepEqual(jsonLdFileUrls('{ "video": "\\/_emdash\\/api\\/media\\/file\\/clip.mp4", "x": "\\/_takeshape-files\\/a\\/b.pdf" }', []), ["/_emdash/api/media/file/clip.mp4", "/_takeshape-files/a/b.pdf"]);
});

// TakeShape printed the bare CDN host where an image was missing, and the new site prints nothing: in a component's
// own attribute too, both are the same empty value, and neither is an image to check
test("a bare CDN host inside a component attribute compares as empty", () => {
	const old = normalizeHtml(`<x-gallery :images="['https://images.takeshape.io/', 'https://images.takeshape.io/p/a.png']"></x-gallery>`, { origins: [] });
	const neu = normalizeHtml(`<x-gallery :images="['', '/_emdash/api/media/file/a.png']"></x-gallery>`, { origins: [] });
	assert.deepEqual(canonicalLines(old.tree), canonicalLines(neu.tree));
	assert.deepEqual(old.images, ["https://images.takeshape.io/p/a.png"]);
});

// A quoted URL ends at its own quote: an apostrophe inside a double-quoted URL ("Owner's photo") is part
// of it, in the content compare and in the file links the crawl follows
test("a URL in a component attribute may hold the other quote", () => {
	const r = normalizeHtml(`<x-gallery :images='["https://images.takeshape.io/p/Owner&#39;s.jpg"]'></x-gallery>`, { origins: [] });
	assert.deepEqual(r.images, ["https://images.takeshape.io/p/Owner's.jpg"]);
	assert.ok(canonicalLines(r.tree).join("\n").includes('[\\"[image]\\"]'), canonicalLines(r.tree).join("\n"));
	assert.deepEqual(componentFileUrls(":sources", `["/_emdash/api/media/file/Owner's.mp4"]`, []), ["/_emdash/api/media/file/Owner's.mp4"]);
});

// Each quote's own branch scans its URL: the double-quote branch scanned the rest of a single-quoted list for every URL,
// and 8,000 sources took 23 s to normalize
test("a long single-quoted URL list reads in linear time", () => {
	const list = Array.from({ length: 8000 }, (_, i) => `'/_emdash/api/media/file/ts-${i}.mp4'`).join(", ");
	const start = performance.now();
	normalizeHtml(`<x-video :sources="[${list}]"></x-video>`, { origins: [] });
	assert.equal(componentFileUrls(":sources", `[${list}]`, []).length, 8000);
	assert.ok(performance.now() - start < 1000, `took ${Math.round(performance.now() - start)} ms`);
});

// A component binding is a JavaScript expression, where Owner\'s keeps the quote inside the string: the URL runs on to
// the string's own end, read unescaped
test("a URL in a component binding may hold an escaped quote", () => {
	const r = normalizeHtml(`<x-gallery :images="['https://images.takeshape.io/p/Owner\\'s.jpg']" :sources="['/_emdash/api/media/file/Owner\\'s.mp4']"></x-gallery>`, { origins: [] });
	assert.deepEqual(r.images, ["https://images.takeshape.io/p/Owner's.jpg"]);
	const text = canonicalLines(r.tree).join("\n");
	assert.ok(text.includes(":images=\"['[image]']\"") && text.includes(":sources=\"['[file]']\""), text);
	assert.deepEqual(componentFileUrls(":sources", "['/_emdash/api/media/file/Owner\\'s.mp4']", []), ["/_emdash/api/media/file/Owner's.mp4"]);
});

// The image check pairs old and new images by position, so an element gives its images in the order its normalized
// attributes compare in: by name. In source order a swap between two attributes paired A with A and B with B, and a
// harmless reorder paired A with B.
test("an element's images come in attribute-name order", () => {
	const a = "https://images.takeshape.io/p/a.png";
	const b = "https://images.takeshape.io/p/b.png";
	assert.deepEqual(normalizeHtml(`<img src="${a}" data-src="${b}">`, { origins: [] }).images, [b, a]);
	assert.deepEqual(normalizeHtml(`<img data-src="${b}" src="${a}">`, { origins: [] }).images, [b, a]);
	// Swapped between the attributes, the pairs come out crossed, so the image check sees two different pictures
	assert.deepEqual(normalizeHtml(`<img data-src="${a}" src="${b}">`, { origins: [] }).images, [a, b]);
});

// A binding's string escapes decode as JavaScript reads them:   is a space and \x26 an ampersand, not "u0020"
test("a URL in a component binding decodes JavaScript escapes", () => {
	assert.deepEqual(componentFileUrls(":sources", "['/_emdash/api/media/file/report\\u0020one.pdf', '/_emdash/api/media/file/a\\u{20}b.pdf']", []), [
		"/_emdash/api/media/file/report one.pdf",
		"/_emdash/api/media/file/a b.pdf",
	]);
	const r = normalizeHtml(`<x-gallery :images="['https://images.takeshape.io/p/a.png?w=1\\x26h=2', 'https://images.takeshape.io/p/b\\\\c.png']"></x-gallery>`, { origins: [] });
	assert.deepEqual(r.images, ["https://images.takeshape.io/p/a.png?w=1&h=2", "https://images.takeshape.io/p/b\\c.png"]);
});
