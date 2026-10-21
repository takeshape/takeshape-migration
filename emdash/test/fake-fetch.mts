/**
 * Preload for the converter tests: replaces fetch so downloads run offline.
 * Load it with `node --import`. FAKE_FETCH picks the behavior:
 *   ok      every asset is served whole (50,000 bytes)
 *   broken  every asset sends its headers and 1,000 bytes, then the
 *           connection drops, which undici reports as TypeError: terminated
 *   images  assets.takeshape.io and images.takeshape.io: images get a 4x3
 *           PNG header (45 bytes), other files 50,000 bytes, with a
 *           Content-Type that follows the extension
 *   dir     assets.takeshape.io answers from the folder FAKE_FETCH_DIR, laid
 *           out the way --download-assets writes it (the URL path, each
 *           segment decoded): the file's bytes, its size as Content-Length
 *           and a Content-Type that follows the extension. A file that is not
 *           there is a 404. Any other host, images.takeshape.io included, is
 *           refused: fetch throws and stderr says "fake-fetch: refused <url>".
 *
 * Knobs, in every mode:
 *   FAKE_FETCH_LOG=<file>       append each requested URL and a newline
 *   FAKE_FETCH_404=<substring>  matching URLs return 404
 *   FAKE_FETCH_FLAKY=<n>        the first n requests for each URL return 503
 *   FAKE_FETCH_TYPE=none        omit Content-Type
 *   FAKE_FETCH_EXIT_AFTER=<n>   process.exit(130) when request n+1 starts
 *   FAKE_FETCH_DELAY_MS=<ms>    wait before responding
 *   FAKE_FETCH_SHORT=<n>        the first n answered requests for each URL send half the body and
 *                               close cleanly, Content-Length unchanged (seen over HTTP/2 on Node 26)
 *   FAKE_FETCH_STATS=<file>     on exit, write { maxInFlight, requests, maxRssBytes }
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pngHeader } from "./synthetic-export.mts";

const FULL_SIZE = 50_000;
const mode = process.env.FAKE_FETCH;
if (mode !== "ok" && mode !== "broken" && mode !== "images" && mode !== "dir") throw new Error(`FAKE_FETCH must be ok, broken, images or dir, got ${mode}`);

const env = process.env;
const assetDir = mode === "dir" ? resolve(env.FAKE_FETCH_DIR ?? "") : null;
if (assetDir !== null && !(env.FAKE_FETCH_DIR && statSync(assetDir, { throwIfNoEntry: false })?.isDirectory())) {
	throw new Error(`FAKE_FETCH=dir needs FAKE_FETCH_DIR, a folder of assets as --download-assets writes it, got ${env.FAKE_FETCH_DIR ?? "nothing"}`);
}
const exitAfter = env.FAKE_FETCH_EXIT_AFTER ? Number(env.FAKE_FETCH_EXIT_AFTER) : null;
const flaky = env.FAKE_FETCH_FLAKY ? Number(env.FAKE_FETCH_FLAKY) : 0;
const delayMs = env.FAKE_FETCH_DELAY_MS ? Number(env.FAKE_FETCH_DELAY_MS) : 0;
const shortFor = env.FAKE_FETCH_SHORT ? Number(env.FAKE_FETCH_SHORT) : 0;
const seen = new Map<string, number>();
const answered = new Map<string, number>();
let requests = 0;
let inFlight = 0;
let maxInFlight = 0;

if (env.FAKE_FETCH_STATS) {
	const statsFile = env.FAKE_FETCH_STATS;
	process.on("exit", () => {
		writeFileSync(statsFile, JSON.stringify({ maxInFlight, requests, maxRssBytes: process.resourceUsage().maxRSS * 1024 }));
	});
}

const TYPES: Record<string, string> = {
	jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
	pdf: "application/pdf", mp4: "video/mp4",
};

/** The file in FAKE_FETCH_DIR behind an assets.takeshape.io URL, or null when the path leaves the folder. */
function fileFor(url: string): string | null {
	const segments = new URL(url).pathname.slice(1).split("/").map((s) => {
		try {
			return decodeURIComponent(s);
		} catch {
			return s;
		}
	});
	const file = resolve(join(assetDir!, ...segments));
	return file.startsWith(assetDir! + sep) ? file : null;
}
const IMAGE = /\.(jpe?g|png|gif|webp)$/i;

// The response body counts as in flight until it has been read to the end, failed or been cancelled.
// A broken body sends 1,000 bytes, then fails the way undici does when the connection drops.
function body(bytes: Uint8Array, broken: boolean, short = false): ReadableStream<Uint8Array> {
	let open = true;
	let sent = false;
	const done = () => {
		if (open) {
			open = false;
			inFlight--;
		}
	};
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (broken && sent) {
				done();
				return controller.error(new TypeError("terminated"));
			}
			if (broken) {
				sent = true;
				return controller.enqueue(new Uint8Array(1_000));
			}
			controller.enqueue(short ? bytes.slice(0, Math.floor(bytes.length / 2)) : bytes);
			done();
			controller.close();
		},
		cancel: done,
	});
}

globalThis.fetch = async (input: string | URL | Request) => {
	const url = input instanceof Request ? input.url : String(input);
	if (exitAfter !== null && requests >= exitAfter) process.exit(130);
	requests++;
	if (env.FAKE_FETCH_LOG) appendFileSync(env.FAKE_FETCH_LOG, `${url}\n`);
	const hosts = mode === "images" ? /^https:\/\/(assets|images)\.takeshape\.io\// : /^https:\/\/assets\.takeshape\.io\//;
	if (mode === "dir" && !hosts.test(url)) {
		process.stderr.write(`fake-fetch: refused ${url}\n`);
		throw new Error(`fake-fetch: refused ${url}: dir mode serves only https://assets.takeshape.io/`);
	}
	if (!hosts.test(url)) throw new Error(`fake-fetch: unexpected URL ${url}`);

	inFlight++;
	maxInFlight = Math.max(maxInFlight, inFlight);
	if (delayMs) await sleep(delayMs);

	const tries = (seen.get(url) ?? 0) + 1;
	seen.set(url, tries);
	if (env.FAKE_FETCH_404 && url.includes(env.FAKE_FETCH_404)) {
		inFlight--;
		return new Response(null, { status: 404 });
	}
	if (tries <= flaky) {
		inFlight--;
		return new Response(null, { status: 503 });
	}

	const path = new URL(url).pathname;
	let bytes: Uint8Array;
	if (mode === "dir") {
		const file = fileFor(url);
		if (!file || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
			inFlight--;
			return new Response(null, { status: 404 });
		}
		bytes = new Uint8Array(readFileSync(file));
	} else bytes = mode === "images" && IMAGE.test(path) ? pngHeader(4, 3) : new Uint8Array(FULL_SIZE);
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const headers: Record<string, string> = { "content-length": String(bytes.length) };
	if (env.FAKE_FETCH_TYPE !== "none") headers["content-type"] = mode === "images" || mode === "dir" ? (TYPES[ext] ?? "application/octet-stream") : "application/octet-stream";

	const servedBefore = answered.get(url) ?? 0;
	answered.set(url, servedBefore + 1);
	return new Response(body(bytes, mode === "broken", servedBefore < shortFor), { status: 200, headers });
};
