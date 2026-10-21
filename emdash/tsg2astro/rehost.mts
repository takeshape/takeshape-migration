#!/usr/bin/env node
/**
 * Moves the TakeShape-hosted files a translated site names onto the site itself, while TakeShape's CDN still
 * answers. Usage: node tsg2astro/rehost.mts <project folder>
 *
 * It scans the project's src/ and public/ text files for URLs on assets.takeshape.io and images.takeshape.io (a
 * logo in a layout's JSON-LD, icons in templates, backgrounds in the bundled CSS and JavaScript), downloads each
 * one, and rewrites it to /_takeshape-files/<hash>/<file>, served from public/, keeping any #fragment. An
 * images.takeshape.io URL whose parameters only recompress fetches the original from assets.takeshape.io; one with any
 * other parameter fetches imgix's variant, so the page keeps the size and look the old site showed. A download counts
 * only when its size matches Content-Length. URLs a template builds at run time (https://assets.takeshape.io/${...}) and calls to
 * api.takeshape.io are listed in takeshape/rehost-report.md, not changed.
 *
 * tsg2astro rewrites src/ and public/ every time it runs, so run this after it each time. Downloads are kept in
 * takeshape/files/, which tsg2astro leaves alone, so a rerun fetches nothing it already has.
 * Exit 0 when every file moved, 1 when a download failed, 2 for a usage error.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

const out = process.argv[2];
if (!out || !existsSync(join(out, "src")) || !existsSync(join(out, "public"))) {
	console.error("Usage: node tsg2astro/rehost.mts <project folder>  (the folder tsg2astro wrote, with src/ and public/)");
	process.exit(2);
}

const PUBLIC_DIR = "_takeshape-files";
const CACHE = join(out, "takeshape", "files");
const TEXT = new Set([".astro", ".ts", ".mts", ".js", ".mjs", ".cjs", ".css", ".html", ".htm", ".json", ".svg", ".xml", ".txt", ".md", ".webmanifest"]);
// A CDN URL, starting where a host name can (a long run of letters in bundled code is scanned once)
// Parentheses can be part of a file name (photo (1).jpg), and so can an apostrophe escaped in a JavaScript string
// (Owner\'s); urlPart() takes off the ) that closes a CSS url()
const CDN_URL = /(?<![A-Za-z0-9.-])(?:https?:)?\/\/(assets|images)\.takeshape\.io\/(?:[^\s"'`<>\\{}$]|\\+')*/g;
const API_URL = /(?<![A-Za-z0-9.-])(?:https?:)?\/\/api\.takeshape\.io\/[^\s"'`<>()\\{}$]*/g;
// imgix parameters that only change how an image is encoded or named; with any other, imgix changed how it looks
const RECOMPRESS = new Set(["auto", "q", "fm", "cs", "lossless", "chromasub", "colorquant", "dpi", "dl", "ch", "ixlib", "s"]);
const TYPES: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"image/avif": ".avif",
	"image/gif": ".gif",
	"image/svg+xml": ".svg",
	"application/pdf": ".pdf",
	"video/mp4": ".mp4",
	"video/webm": ".webm",
};

function files(dir: string, skip: string): string[] {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		if (p === skip) continue;
		const s = statSync(p);
		if (s.isDirectory()) found.push(...files(p, skip));
		else if (TEXT.has(extname(name).toLowerCase())) found.push(p);
	}
	return found;
}

/**
 * The matched text without what follows the URL: it ends at the first ) it didn't open (the one closing a CSS url(),
 * with any declarations after it), and sentence punctuation comes off its end. Balanced ones stay (wave (1).jpg).
 */
function urlPart(raw: string): string {
	let depth = 0;
	let end = raw.length;
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === "(") depth++;
		else if (raw[i] === ")") {
			if (depth === 0) {
				end = i;
				break;
			}
			depth--;
		}
	}
	return raw.slice(0, end).replace(/[.,;]+$/, "");
}

// A whole quoted value that is one CDN URL, raw spaces allowed (TakeShape kept file names as uploaded): it ends in a
// file name with an extension, or a query, and is no srcset (descriptors like 300w) or list of URLs. Only its own quote
// ends it, so an apostrophe stays in a double-quoted file name, as a minifier writes Owner's into JavaScript
const QUOTED = /"((?:https?:)?\/\/(?:assets|images)\.takeshape\.io\/(?:[^"\\\n<>{}$]|\\.)*?)"|'((?:https?:)?\/\/(?:assets|images)\.takeshape\.io\/(?:[^'\\\n<>{}$]|\\.)*?)'|`((?:https?:)?\/\/(?:assets|images)\.takeshape\.io\/(?:[^`\\\n<>{}$]|\\.)*?)`/g;
const ONE_SPACED_URL = /^(?:https?:)?\/\/[^\s]+(?: [^\s]+)*\.[A-Za-z0-9]{2,5}(?:\?[^\s]*)?$/;

/** Every CDN URL in a text, as the text writes it (start, and the matched text): quoted ones whole, the rest unquoted. */
function findCdnUrls(text: string): Array<{ index: number; raw: string }> {
	const found: Array<{ index: number; raw: string }> = [];
	const taken: Array<[number, number]> = [];
	for (const m of text.matchAll(QUOTED)) {
		const value = (m[1] ?? m[2] ?? m[3])!;
		// CDN_URL below stops at a space or an apostrophe, so a quoted value with either is read whole here
		const spaced = /\s/.test(value) && ONE_SPACED_URL.test(value) && !/\s\d+(?:\.\d+)?[wx](?:\s*,|$)|,\s*(?:https?:)?\/\//.test(value);
		const apostrophe = !/\s/.test(value) && /(?<!\\)'/.test(value) && !/,(?:https?:)?\/\//.test(value);
		if (!spaced && !apostrophe) continue;
		const index = m.index + 1;
		found.push({ index, raw: value });
		taken.push([index, index + value.length]);
	}
	for (const m of text.matchAll(CDN_URL)) {
		if (taken.some(([a, b]) => m.index >= a && m.index < b)) continue;
		found.push({ index: m.index, raw: m[0] });
	}
	return found.sort((a, b) => a.index - b.index);
}

/** The URL as a browser fetched it: entities and string escapes undone, a scheme added, the fragment off. */
function clean(raw: string): string {
	return urlPart(raw).replace(/&amp;/g, "&").replace(/\\+'/g, "'").replace(/^\/\//, "https://").replace(/#.*$/, "");
}

/** The #fragment as written, which never reaches the server and stays on the local URL. */
function fragment(raw: string): string {
	const url = urlPart(raw);
	const at = url.indexOf("#");
	return at < 0 ? "" : url.slice(at);
}

/** Where to download a CDN URL from: the original for an images.takeshape.io URL that only recompresses, else the URL itself. */
function source(url: string): string {
	const u = new URL(url);
	if (u.hostname !== "images.takeshape.io") return url;
	const shaped = [...u.searchParams.keys()].some((k) => !RECOMPRESS.has(k.toLowerCase()));
	return shaped ? url : `https://assets.takeshape.io${u.pathname}`;
}

function fileName(url: string, type: string): string {
	const path = new URL(url).pathname;
	let name = decodeURIComponent(basename(path)).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
	const ext = TYPES[type.split(";")[0]!.trim().toLowerCase()];
	if (ext && extname(name).toLowerCase() !== ext && !(ext === ".jpg" && /^\.jpe?g$/i.test(extname(name)))) name = `${name.replace(/\.[^.]+$/, "")}${ext}`;
	return name;
}

async function download(url: string): Promise<{ bytes: Uint8Array; type: string }> {
	let last: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			const length = res.headers.get("content-length");
			if (length !== null && Number(length) !== bytes.length) throw new Error(`got ${bytes.length} of ${length} bytes`);
			return { bytes, type: res.headers.get("content-type") ?? "" };
		} catch (e) {
			last = e;
		}
	}
	throw last instanceof Error ? last : new Error(String(last));
}

// Every CDN URL in the project, with the files that name it
const scanned = [...files(join(out, "src"), ""), ...files(join(out, "public"), join(out, "public", PUBLIC_DIR))];
const urls = new Map<string, Set<string>>(); // cleaned URL -> files
const apiCalls = new Map<string, Set<string>>();
const dynamic = new Set<string>();
for (const file of scanned) {
	const text = readFileSync(file, "utf8");
	if (!text.includes("takeshape.io")) continue;
	const rel = relative(out, file).split(sep).join("/");
	for (const m of findCdnUrls(text)) {
		const url = clean(m.raw);
		const next = text[m.index + urlPart(m.raw).length];
		if (/\/$/.test(new URL(url).pathname) || next === "{" || next === "$") {
			dynamic.add(rel);
			continue;
		}
		(urls.get(url) ?? urls.set(url, new Set()).get(url)!).add(rel);
	}
	for (const m of text.matchAll(API_URL)) (apiCalls.get(clean(m[0])) ?? apiCalls.set(clean(m[0]), new Set()).get(clean(m[0]))!).add(rel);
}

// Download each, or take it from the cache
const local = new Map<string, string>(); // cleaned URL -> /_takeshape-files/<hash>/<name>
const failed = new Map<string, string>();
let fetched = 0;
const queue = [...urls.keys()];
async function worker(): Promise<void> {
	for (let url = queue.shift(); url; url = queue.shift()) {
		const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
		const dir = join(CACHE, hash);
		let name = existsSync(dir) ? readdirSync(dir).find((f) => !f.endsWith(".part")) : undefined;
		if (!name) {
			try {
				const { bytes, type } = await download(source(url));
				name = fileName(url, type);
				mkdirSync(dir, { recursive: true });
				// Renamed into place once written, so an interrupted write leaves only a .part, which a rerun ignores
				writeFileSync(join(dir, `${name}.part`), bytes);
				renameSync(join(dir, `${name}.part`), join(dir, name));
				fetched++;
			} catch (e) {
				failed.set(url, (e as Error).message);
				continue;
			}
		}
		mkdirSync(join(out, "public", PUBLIC_DIR, hash), { recursive: true });
		writeFileSync(join(out, "public", PUBLIC_DIR, hash, name), readFileSync(join(dir, name)));
		local.set(url, `/${PUBLIC_DIR}/${hash}/${name}`);
	}
}
await Promise.all(Array.from({ length: 8 }, worker));

// Rewrite every file that names a moved URL
let rewritten = 0;
for (const file of scanned) {
	const text = readFileSync(file, "utf8");
	if (!text.includes("takeshape.io")) continue;
	// Each moved URL is replaced by its local path and fragment; what follows it (the ) closing a CSS url(), a full stop
	// after a URL in text) stays
	let next = "";
	let at = 0;
	for (const m of findCdnUrls(text)) {
		const to = local.get(clean(m.raw));
		if (!to || m.index < at) continue;
		next += text.slice(at, m.index) + to + fragment(m.raw);
		at = m.index + urlPart(m.raw).length;
	}
	next += text.slice(at);
	if (next !== text) {
		writeFileSync(file, next);
		rewritten++;
	}
}

const lines = [
	"# TakeShape files moved onto the site",
	"",
	`${local.size} files moved (${fetched} downloaded now, ${local.size - fetched} from takeshape/files/), ${rewritten} project files rewritten. Run this again after every tsg2astro run.`,
	"",
];
if (failed.size) {
	lines.push("## Not moved", "", "| URL | Why |", "| --- | --- |", ...[...failed].map(([u, why]) => `| ${u} | ${why} |`), "");
}
if (apiCalls.size) {
	lines.push(
		"## Calls to TakeShape's API",
		"",
		"Browser code that queries TakeShape. It stops working on December 31, 2026; the resolve-takeshape-site-report skill says how to answer it from EmDash.",
		"",
		...[...apiCalls].map(([u, f]) => `- \`${u}\` in ${[...f].sort().join(", ")}`),
		"",
	);
}
if (dynamic.size) {
	lines.push("## URLs built at run time", "", "These files build a TakeShape CDN URL from a value, which this cannot move. Rewrite each by hand.", "", ...[...dynamic].sort().map((f) => `- ${f}`), "");
}
lines.push("## Moved", "", "| URL | Now | Named in |", "| --- | --- | --- |", ...[...local].sort().map(([u, l]) => `| ${u} | ${l} | ${[...(urls.get(u) ?? [])].sort().join(", ")} |`), "");
mkdirSync(join(out, "takeshape"), { recursive: true });
writeFileSync(join(out, "takeshape", "rehost-report.md"), `${lines.join("\n")}`);
console.log(`Moved ${local.size} TakeShape files onto the site (${fetched} downloaded), rewrote ${rewritten} files.${failed.size ? ` ${failed.size} failed: see takeshape/rehost-report.md.` : ""}`);
process.exit(failed.size ? 1 : 0);
