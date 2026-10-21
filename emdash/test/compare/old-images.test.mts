// compare/old-images.mts makes an old page's TakeShape image from its original, with the image endpoint's own
// rules, keys each URL by the setting the rules check samples, and asks imgix for a sample the way a browser does.
import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { HASH_VERSION, parseImageIndex, writeImageIndex } from "../../compare/images.mts";
import type { IndexedImage } from "../../compare/images.mts";
import { IMGIX_ACCEPT, NotMadeLocally, fetchImgix, makeOldImage, picksOwnSpot, settingKey } from "../../compare/old-images.mts";
import type { Original } from "../../compare/originals.mts";

const png = async (width: number, height: number): Promise<Original> => ({
	bytes: new Uint8Array(await sharp({ create: { width, height, channels: 3, background: "#3366cc" } }).png().toBuffer()),
	type: "image/png",
});
const svg = (width: number, height: number): Original => ({
	bytes: new Uint8Array(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#c63"/></svg>`)),
	type: "image/svg+xml",
});
const pdf: Original = { bytes: new Uint8Array(Buffer.from("%PDF-1.4\n% not an image\n")), type: "application/pdf" };
const imgix = (query: string) => new URL(`https://images.takeshape.io/p1/dev/a1/photo.png${query}`);

test("makeOldImage: imgix's parameters through the endpoint's rules", async () => {
	const original = await png(412, 600);
	const size = async (query: string) => {
		const i = await makeOldImage(imgix(query), original);
		return [i.width, i.height];
	};
	assert.deepEqual(await size("?w=200"), [200, 291]);
	assert.deepEqual(await size("?w=200&h=200&fit=crop"), [200, 200]);
	assert.deepEqual(await size(""), [412, 600]);
	assert.deepEqual(await size("?auto=compress,format"), [412, 600]);
});

test("makeOldImage: an image without parameters is capped at 8,192 pixels a side, as imgix capped it", async () => {
	const i = await makeOldImage(imgix(""), await png(9000, 100));
	assert.deepEqual([i.width, i.height], [8192, 91]);
});

test("makeOldImage: assets.takeshape.io served the original, whatever the query", async () => {
	const i = await makeOldImage(new URL("https://assets.takeshape.io/p1/dev/a1/photo.png?w=200"), await png(412, 600));
	assert.deepEqual([i.width, i.height], [412, 600]);
});

test("makeOldImage: a file imgix showed as an image (a PDF) can't be made locally", async () => {
	await assert.rejects(makeOldImage(imgix("?w=200"), pdf), NotMadeLocally);
	await assert.rejects(makeOldImage(imgix(""), pdf), NotMadeLocally);
	// A PSD's header gives its size, so reading it succeeds, but imgix showed a picture the browser can't
	const psd = Buffer.alloc(26);
	psd.write("8BPS", 0, "latin1");
	psd.writeUInt16BE(1, 4);
	psd.writeUInt16BE(3, 12);
	psd.writeUInt32BE(300, 14);
	psd.writeUInt32BE(400, 18);
	psd.writeUInt16BE(8, 22);
	psd.writeUInt16BE(3, 24);
	await assert.rejects(makeOldImage(imgix("?w=200"), { bytes: new Uint8Array(psd), type: "image/vnd.adobe.photoshop" }), NotMadeLocally);
});

test("makeOldImage: a file name without an extension is read by its header", async () => {
	const { bytes } = await png(412, 600);
	const i = await makeOldImage(imgix("?w=200"), { bytes, type: "application/octet-stream" });
	assert.deepEqual([i.width, i.height], [200, 291]);
});

test("makeOldImage: an SVG goes out as stored, as the endpoint sends it, at its own size", async () => {
	const i = await makeOldImage(imgix("?w=200"), svg(80, 40));
	assert.deepEqual([i.width, i.height], [80, 40]);
});

test("settingKey: encoding parameters don't count, other parameters and the source's facts do", async () => {
	const wide = await png(200, 100);
	const tall = await png(100, 200);
	const big = await png(800, 600);
	assert.equal(await settingKey(imgix("?w=300&auto=compress,format&q=45"), big), await settingKey(imgix("?w=300"), big));
	assert.notEqual(await settingKey(imgix("?w=300&blur=40"), big), await settingKey(imgix("?w=300"), big));
	// orientation, and smaller than the box against larger
	assert.notEqual(await settingKey(imgix("?w=300"), wide), await settingKey(imgix("?w=300"), tall));
	assert.notEqual(await settingKey(imgix("?w=300"), wide), await settingKey(imgix("?w=300"), big));
	assert.equal(await settingKey(imgix("?w=300"), big), await settingKey(imgix("?w=300"), await png(1600, 1200)));
	// a type the endpoint sends as stored
	assert.notEqual(await settingKey(imgix("?w=300"), svg(800, 600)), await settingKey(imgix("?w=300"), big));
	// the host: assets.takeshape.io sent the original whatever the parameters
	assert.notEqual(await settingKey(new URL("https://assets.takeshape.io/p1/dev/a1/photo.png?w=300"), big), await settingKey(imgix("?w=300"), big));
	// a file whose size can't be read still gets a key
	assert.equal(typeof (await settingKey(imgix("?w=300"), pdf)), "string");
});

test("picksOwnSpot: crops where imgix chose the spot from the picture", () => {
	const picks = (q: string) => picksOwnSpot(new URLSearchParams(q));
	assert.equal(picks("w=100&h=100&fit=crop&crop=faces"), true);
	assert.equal(picks("fit=crop&crop=entropy,top"), true);
	assert.equal(picks("fit=crop&crop=edges"), true);
	assert.equal(picks("w=100&h=100&fit=facearea"), true);
	assert.equal(picks("fit=crop&crop=top"), false);
	assert.equal(picks("w=100"), false);
});

test("fetchImgix: asks the way a browser does and reads the answer's size", async (t) => {
	const real = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = real;
	});
	const answer = new Uint8Array(await sharp({ create: { width: 30, height: 20, channels: 3, background: "#000" } }).webp().toBuffer());
	const accepts: Array<string | null> = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		accepts.push(new Headers(init?.headers).get("accept"));
		return new Response(answer, { status: 200, headers: { "Content-Type": "image/webp" } });
	}) as typeof fetch;
	const i = await fetchImgix("https://images.takeshape.io/p1/dev/a1/photo.png?w=30&sample=1", 5000);
	assert.deepEqual([i.width, i.height], [30, 20]);
	assert.deepEqual(accepts, [IMGIX_ACCEPT]);
});

test("writeImageIndex: keys sorted, read back the same", () => {
	const entries = new Map<string, IndexedImage>([
		["https://images.takeshape.io/p1/dev/b/z.png?w=10", { width: 10, height: 5, hash: 0xabcn, version: HASH_VERSION }],
		["https://images.takeshape.io/p1/dev/a/y.png", { error: "answered 404" }],
		["https://images.takeshape.io/p1/dev/a/x.png?w=20", { width: 20, height: 10, hash: 0x1234567890abcdefn, version: 1 }],
	]);
	const text = writeImageIndex(entries);
	assert.deepEqual(Object.keys(JSON.parse(text)), [...entries.keys()].sort());
	assert.ok(text.endsWith("}\n") && text.includes('\n\t"'));
	assert.deepEqual(parseImageIndex(text), entries);
});

