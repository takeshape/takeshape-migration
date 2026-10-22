// node compare/compare-sites.mts <old URL|dir> <new URL|dir> [--urls file] [--out compare-report.md] [--json compare-report.json]
//                                [--concurrency 4] [--delay-ms 0] [--ignore-text <regex>]... [--media dir] [--image-index file]
//                                [--fetch-log file]
// Exit 0: no differences. Exit 1: differences. Exit 2: usage or network error.
import { appendFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { canonicalLines, normalizeHtml, normalizeXml } from "./normalize.mts";
import type { NormNode } from "./normalize.mts";
import { DEFAULT_MAX_PAGES, DEFAULT_TIMEOUT_MS, crawl, extractLinks, isAsset, pathOf } from "./crawl.mts";
import type { Fetched } from "./crawl.mts";
import { detailOf, diffLines } from "./diff.mts";
import { HASH_VERSION, dHash, hashDistance, imageInfo, imageOf, parseImageIndex, writeImageIndex } from "./images.mts";
import type { IndexedImage } from "./images.mts";
import type { ImageInfo } from "./images.mts";
import { NotMadeLocally, fetchImgix, makeOldImage, picksOwnSpot, settingKey } from "./old-images.mts";
import { IMAGE_HOST, openMedia, takeshapeAssetPath } from "./originals.mts";
import type { LocalMedia } from "./originals.mts";
import { renderReport } from "./report.mts";
import type { CompareResult, TakeshapeSiteLinks } from "./report.mts";
import { serveDir } from "./serve-dir.mts";

export { serveDir, crawl, imageInfo, dHash };
export type { Fetched };
export type Difference = {
	path: string;
	kind: "missing" | "extra" | "status" | "redirect" | "content" | "broken-link" | "image" | "image-rules" | "takeshape-host";
	detail: string;
};
export type CompareOptions = {
	seeds: string[];
	concurrency: number;
	delayMs: number;
	ignoreText: RegExp[];
	timeoutMs?: number;
	maxPages?: number;
	ignoreQuery?: boolean;
	// More origins that count as this site on both sides.
	origins?: string[];
	// How the sites are named in error messages.
	labels?: { oldSite: string; newSite: string };
	// The old site's images by URL (resolved as the page has them), used instead of fetching them.
	imageIndex?: Map<string, IndexedImage>;
	// The new project's originals (compare --media): old images on TakeShape's hosts are made from them.
	media?: LocalMedia;
};

const MAX_HASH_DISTANCE = 6;
const MAX_ROUNDS = 20;
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

type Kind = "html" | "xml" | "json" | "text" | "other";
function kindOf(f: Fetched): Kind {
	const ct = f.contentType.toLowerCase();
	const p = f.path.split("?")[0].toLowerCase();
	if (ct.includes("html")) return "html";
	if (ct.includes("json")) return "json";
	if (ct.includes("xml") || p.endsWith(".xml")) return "xml";
	if (ct.startsWith("text/")) return "text";
	return "other";
}

function assetLike(f: Fetched): boolean {
	return isAsset(f.path) || /^(?:image|video|audio|font)\//i.test(f.contentType);
}

function stripText(node: NormNode, res: RegExp[]): NormNode | null {
	if ("text" in node) {
		let t = node.text;
		for (const r of res) t = t.replace(r, "");
		t = t.replace(/[ \t\n\r\f]+/g, " ");
		return t.trim() === "" && t !== node.text ? null : { text: t };
	}
	return { ...node, children: node.children.map((c) => stripText(c, res)).filter((c): c is NormNode => c !== null) };
}

function sortKeys(v: unknown, origins: string[]): unknown {
	if (typeof v === "string") {
		let s = v;
		for (const o of origins) s = s.split(o).join("");
		return s;
	}
	if (Array.isArray(v)) return v.map((x) => sortKeys(x, origins));
	if (v && typeof v === "object") {
		return Object.fromEntries(
			Object.entries(v)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, x]) => [k, sortKeys(x, origins)]),
		);
	}
	return v;
}

function global(r: RegExp): RegExp {
	return new RegExp(r.source, r.flags.includes("g") ? r.flags : `${r.flags}g`);
}

function bodyLines(f: Fetched, kind: Kind, origins: string[], ignore: RegExp[]): string[] {
	const text = decode(f.body);
	if (kind === "html") {
		const tree = normalizeHtml(text, { origins }).tree;
		return canonicalLines(ignore.length ? (stripText(tree, ignore) as NormNode) : tree);
	}
	if (kind === "xml") return normalizeXml(text, { origins });
	if (kind === "json") {
		try {
			return JSON.stringify(sortKeys(JSON.parse(text), origins), null, 1).split("\n");
		} catch {
			return text.split("\n");
		}
	}
	let t = text;
	for (const o of origins) t = t.split(o).join("");
	return t.split("\n");
}

function describe(f: Fetched, origins: string[], at: string): string {
	if (f.status === 0) return `no answer (${f.error ?? "request failed"})`;
	if (f.status >= 300 && f.status < 400 && f.location) {
		let loc = f.location;
		try {
			const u = new URL(f.location, new URL(at));
			loc = origins.includes(u.origin) ? u.pathname + u.search : u.href;
		} catch {
			// keep the raw header
		}
		return `${f.status} to ${loc}`;
	}
	return String(f.status);
}

function redirectTarget(f: Fetched, origins: string[], at: string): string | null {
	if (!f.location) return null;
	try {
		const u = new URL(f.location, new URL(at));
		return origins.includes(u.origin) ? u.pathname + u.search : u.href;
	} catch {
		return f.location;
	}
}

const TS_HOST = /(?<![a-z0-9.-])(?:https?:)?(?:\/\/)?((?:[a-z0-9-]+\.)*takeshape\.io)(?![a-z0-9-])[^\s"'<>)\\]*/gi;

function scanTakeshape(path: string, f: Fetched, diffs: Difference[], siteLinks: TakeshapeSiteLinks) {
	if (f.body.length === 0) return;
	const k = kindOf(f);
	const p = path.split("?")[0].toLowerCase();
	if (!(k === "html" || k === "json" || /\.(?:css|m?js|json)$/.test(p) || /css|javascript/i.test(f.contentType))) return;
	const hosts = new Map<string, number>();
	const links = new Set<string>();
	for (const m of decode(f.body).matchAll(TS_HOST)) {
		const host = m[1].toLowerCase();
		if (host === "takeshape.io" || host === "www.takeshape.io") links.add(m[0]);
		else hosts.set(host, (hosts.get(host) ?? 0) + 1);
	}
	for (const [host, n] of hosts) {
		diffs.push({ path, kind: "takeshape-host", detail: `Mentions ${host} ${n === 1 ? "once" : `${n} times`}. TakeShape turns this service off after January 15.` });
	}
	if (links.size > 0) siteLinks.push({ path, links: [...links] });
}

export async function compareDetailed(oldBase: string, newBase: string, options: CompareOptions): Promise<CompareResult> {
	const extraOrigins = (options.origins ?? []).map((o) => new URL(o).origin);
	const stats = { old: { capped: false }, new: { capped: false } };
	const crawlBase = { concurrency: options.concurrency, delayMs: options.delayMs, timeoutMs: options.timeoutMs, maxPages: options.maxPages, ignoreQuery: options.ignoreQuery, origins: extraOrigins };
	const crawlOpts = crawlBase;
	const origins = [new URL(oldBase).origin, new URL(newBase).origin, ...extraOrigins];
	const linkOpts = { ignoreQuery: options.ignoreQuery, origins: extraOrigins };
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
	const ignore = options.ignoreText.map(global);
	const seeds = [...new Set(["/", "/sitemap.xml", ...options.seeds])];

	const oldMap = await crawl(oldBase, seeds, { ...crawlOpts, assets: false, stats: stats.old });
	const newMap = await crawl(newBase, seeds, { ...crawlOpts, assets: true, stats: stats.new });
	for (const [side, map, label] of [
		["old", oldMap, options.labels?.oldSite ?? oldBase],
		["new", newMap, options.labels?.newSite ?? newBase],
	] as const) {
		const root = map.get("/");
		if (!root || root.status === 0 || root.status >= 400) {
			const what = !root || root.status === 0 ? `could not be reached (${root?.error ?? "no answer"})` : `answered ${root.status} for /`;
			throw new Error(`The ${side} site (${label}) ${what}. Check the address; nothing was compared.`);
		}
	}
	const oldFound = new Set(oldMap.keys());

	// A page one site links to and the other does not still gets fetched on both sites.
	for (let round = 0; round < MAX_ROUNDS; round++) {
		const toOld = [...newMap.values()].filter((f) => !assetLike(f) && !oldMap.has(f.path)).map((f) => f.path);
		const toNew = [...oldMap.values()].filter((f) => !assetLike(f) && !newMap.has(f.path)).map((f) => f.path);
		if (toOld.length === 0 && toNew.length === 0) break;
		if (toOld.length) await crawl(oldBase, toOld, { ...crawlOpts, assets: false, known: oldMap, stats: stats.old });
		if (toNew.length) await crawl(newBase, toNew, { ...crawlOpts, assets: true, known: newMap, stats: stats.new });
		if (stats.old.capped || stats.new.capped) break;
	}

	const diffs: Difference[] = [];
	const siteLinks: TakeshapeSiteLinks = [];
	// Assets count only when asked for by name (--urls): a page's own images are compared with the page
	const requested = new Set(seeds.map((s) => pathOf(s, oldBase, options.ignoreQuery)));
	const paths = [...new Set([...oldMap.keys(), ...newMap.keys()])]
		.filter((p) => {
			const o = oldMap.get(p);
			const n = newMap.get(p);
			return requested.has(p) || !((o && assetLike(o)) || (n && assetLike(n)));
		})
		.sort();
	let compared = 0;
	const olds = oldImages(options, timeoutMs);

	for (const p of paths) {
		const o = oldMap.get(p);
		const n = newMap.get(p);
		if (!o || !n) continue;
		compared++;
		if (o.status === 0 || n.status === 0) {
			diffs.push({ path: p, kind: "status", detail: `Old: ${describe(o, origins, oldBase)}. New: ${describe(n, origins, newBase)}.` });
			continue;
		}
		const oOk = o.status < 400;
		const nOk = n.status < 400;
		if (!oOk && !nOk) {
			if (o.status !== n.status) diffs.push({ path: p, kind: "status", detail: `Old answers ${o.status}, new answers ${n.status}.` });
			continue;
		}
		if (oOk && !nOk) {
			diffs.push({ path: p, kind: "missing", detail: `Old answers ${describe(o, origins, oldBase)}, new answers ${n.status}.` });
			continue;
		}
		if (!oOk && nOk) {
			diffs.push({
				path: p,
				kind: oldFound.has(p) ? "status" : "extra",
				detail: `Old answers ${o.status}, new answers ${describe(n, origins, newBase)}.`,
			});
			continue;
		}
		const o3 = o.status >= 300;
		const n3 = n.status >= 300;
		if (o3 || n3) {
			if (!(o3 && n3 && o.status === n.status && redirectTarget(o, origins, oldBase) === redirectTarget(n, origins, newBase))) {
				diffs.push({ path: p, kind: "redirect", detail: `Old answers ${describe(o, origins, oldBase)}, new answers ${describe(n, origins, newBase)}.` });
			}
			continue;
		}
		if (o.status !== n.status) {
			diffs.push({ path: p, kind: "status", detail: `Old answers ${o.status}, new answers ${n.status}.` });
			continue;
		}
		const ko = kindOf(o);
		const kn = kindOf(n);
		if (ko !== kn) {
			diffs.push({ path: p, kind: "content", detail: `Content type differs: old ${o.contentType || "none"}, new ${n.contentType || "none"}.` });
			continue;
		}
		if (ko === "other") {
			const d = await compareFile(o, n);
			if (d) diffs.push({ path: p, ...d });
			continue;
		}
		const d = diffLines(bodyLines(o, ko, origins, ignore), bodyLines(n, kn, origins, ignore));
		if (d.length > 0) diffs.push({ path: p, kind: "content", detail: detailOf(d) });
		if (ko === "html") await compareImages(p, o, n, oldBase, newBase, diffs, origins, timeoutMs, olds, options.imageIndex);
	}
	const info: string[] = [];
	await olds.check(diffs, info);

	// Links on new pages that lead nowhere (unless the old page has the same link and it is just as broken there).
	const sameSite = new Set(origins);
	const follow = (map: Map<string, Fetched>, base: string, start: string) => {
		const via: string[] = [];
		let f = map.get(start);
		for (let i = 0; i < 5 && f && f.status >= 300 && f.status < 400 && f.location; i++) {
			const t = new URL(f.location, new URL(f.path, base));
			if (!sameSite.has(t.origin)) break;
			const next = t.pathname + (options.ignoreQuery ? "" : t.search);
			via.push(next);
			f = map.get(next);
		}
		return { f, via };
	};
	const dead = (f: Fetched | undefined) => f !== undefined && (f.status === 0 || f.status >= 400);
	for (const [p, n] of newMap) {
		if (n.status === 0 || n.status >= 400 || kindOf(n) !== "html") continue;
		const oldPage = oldMap.get(p);
		const oldLinks = new Set(oldPage && oldPage.status > 0 ? extractLinks(oldPage, oldBase, linkOpts) : []);
		for (const l of new Set(extractLinks(n, newBase, linkOpts))) {
			const t = follow(newMap, newBase, l);
			if (!dead(t.f)) continue;
			if (oldLinks.has(l) && dead(follow(oldMap, oldBase, l).f)) continue;
			const chain = t.via.map((v) => `, which redirects to ${v}`).join("");
			const f = t.f as Fetched;
			diffs.push({ path: p, kind: "broken-link", detail: `Links to ${l}${chain}, which ${f.status === 0 ? "did not answer" : `answers ${f.status}`}.` });
		}
	}

	for (const [p, f] of newMap) scanTakeshape(p, f, diffs, siteLinks);

	diffs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	siteLinks.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const notes: string[] = [];
	for (const [side, st] of [["old", stats.old], ["new", stats.new]] as const) {
		if (st.capped) notes.push(`The compare is incomplete: the crawl of the ${side} site stopped at ${maxPages} pages (--max-pages), so some pages were not compared. Raise --max-pages, or use --ignore-query if query strings make one page look like many.`);
	}
	return { differences: diffs, takeshapeSiteLinks: siteLinks, pagesCompared: compared, notes, info, sampled: olds.sampled };
}

/** Two files that are not text: the same bytes, or the same picture (size and hash). */
async function compareFile(o: Fetched, n: Fetched): Promise<Omit<Difference, "path"> | null> {
	if (Buffer.from(o.body).equals(Buffer.from(n.body))) return null;
	const [a, b] = await Promise.allSettled([imageOf(o.body), imageOf(n.body)]);
	if (a.status === "fulfilled" && b.status === "fulfilled") {
		const x = a.value;
		const y = b.value;
		if (x.width !== y.width || x.height !== y.height) return { kind: "image", detail: `Old is ${x.width}x${x.height}, new is ${y.width}x${y.height}.` };
		const dist = hashDistance(x.hash, y.hash);
		return dist > MAX_HASH_DISTANCE ? { kind: "image", detail: `Same size but they look different (hash distance ${dist}, at most ${MAX_HASH_DISTANCE} allowed).` } : null;
	}
	return { kind: "content", detail: `The files differ: old ${o.body.length} bytes, new ${n.body.length} bytes.` };
}

/** Runs at most `n` jobs at once. */
function limiter(n: number) {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async <T,>(job: () => Promise<T>): Promise<T> => {
		while (active >= n) await new Promise<void>((wake) => waiting.push(wake));
		active++;
		try {
			return await job();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Where each old image comes from, and the rules check over the ones made locally. In order: a saved index entry
 * (imgix's own answer); imgix, asked as a browser asks, for a crop where it picked the spot from the picture; with
 * media, an image made from the TakeShape image's original by the endpoint's rules; else the URL itself, as before.
 * Each TakeShape URL made locally (or with an entry) counts under its setting, and check() compares one URL per
 * setting with imgix's answer: an entry, or a fetch that is saved for --image-index.
 */
function oldImages(options: CompareOptions, timeoutMs: number) {
	const { media, imageIndex: index } = options;
	const sampled = new Map<string, ImageInfo>();
	// TakeShape URLs counted under a setting, and the first page that showed each
	const counted = new Map<string, string>();
	const fetchedFromTakeshape = new Set<string>();
	const made = new Map<string, Promise<ImageInfo>>();
	const limit = limiter(availableParallelism());
	const entry = (url: string) => {
		const e = index?.get(url);
		return e && !("error" in e) ? e : undefined;
	};
	const makeLocally = (url: string): Promise<ImageInfo> => {
		let p = made.get(url);
		if (!p) {
			const u = new URL(url);
			p = limit(async () => makeOldImage(u, await media!.original(takeshapeAssetPath(u)!)));
			made.set(url, p);
		}
		return p;
	};

	function get(url: string, page: string): Promise<ImageInfo> {
		let u: URL | null = null;
		try {
			u = new URL(url);
		} catch {
			// not a URL the compare can read: fetched below, which fails as before
		}
		const path = u ? takeshapeAssetPath(u) : null;
		const own = path !== null && u!.hostname === IMAGE_HOST && picksOwnSpot(u!.searchParams);
		const known = index?.get(url);
		// The rules check is about imgix's rules: assets.takeshape.io served originals, and a URL the index recorded
		// as unreadable has no imgix answer to compare with
		if (media && path !== null && u!.hostname === IMAGE_HOST && !own && !(known && "error" in known) && !counted.has(url)) counted.set(url, page);
		// An image the index recorded as unreadable stays so, without asking TakeShape's CDN again
		if (known) return "error" in known ? Promise.reject(new Error(`${known.error}, when the image index was built`)) : Promise.resolve(known);
		if (path !== null && !media) fetchedFromTakeshape.add(url);
		if (own) return fetchImgix(url, timeoutMs).then((info) => (media && sampled.set(url, info), info));
		if (media && path !== null) return makeLocally(url);
		return imageInfo(url, timeoutMs);
	}

	async function check(diffs: Difference[], info: string[]): Promise<void> {
		if (!media) {
			const n = fetchedFromTakeshape.size;
			if (n > 0) info.push(`${plural(n, "old image")} on TakeShape's hosts ${n === 1 ? "was" : "were"} fetched from them. With --media <project folder>, the compare makes them from the preload's originals instead.`);
			return;
		}
		const bySetting = new Map<string, string[]>();
		for (const url of counted.keys()) {
			const u = new URL(url);
			let key: string;
			try {
				key = await limit(async () => settingKey(u, await media.original(takeshapeAssetPath(u)!)));
			} catch {
				continue; // no original: the page already reported it
			}
			const urls = bySetting.get(key);
			if (urls) urls.push(url);
			else bySetting.set(key, [url]);
		}
		const unanswered: string[] = [];
		let notMade = 0;
		for (const key of [...bySetting.keys()].sort()) {
			const urls = bySetting.get(key)!.sort();
			const sample = urls.find((u) => entry(u)) ?? urls[0]!;
			let mine: ImageInfo;
			try {
				mine = await makeLocally(sample);
			} catch (e) {
				if (e instanceof NotMadeLocally) notMade++;
				continue;
			}
			let theirs = entry(sample);
			if (!theirs) {
				try {
					theirs = await fetchImgix(sample, timeoutMs);
					sampled.set(sample, theirs);
				} catch {
					unanswered.push(sample);
					continue;
				}
			}
			const uses = `${plural(urls.length, "image")} on the old pages ${urls.length === 1 ? "uses" : "use"} this setting`;
			if (theirs.width !== mine.width || theirs.height !== mine.height) {
				diffs.push({ path: counted.get(sample)!, kind: "image-rules", detail: `${sample}: imgix made ${theirs.width}x${theirs.height}, the endpoint's rules make ${mine.width}x${mine.height} (${uses}).` });
				continue;
			}
			// An entry hashed another way than this compare hashes can only be checked by its size
			if ((theirs.version ?? 1) !== (mine.version ?? HASH_VERSION)) continue;
			const dist = hashDistance(theirs.hash, mine.hash);
			if (dist > MAX_HASH_DISTANCE) {
				diffs.push({ path: counted.get(sample)!, kind: "image-rules", detail: `${sample}: imgix's image and the endpoint's are the same size but look different (hash distance ${dist}, at most ${MAX_HASH_DISTANCE} allowed; ${uses}).` });
			}
		}
		if (unanswered.length > 0) {
			info.push(`The rules check couldn't run for ${plural(unanswered.length, "setting")}: imgix didn't answer for ${unanswered[0]}${unanswered.length > 1 ? ` and ${plural(unanswered.length - 1, "more URL")}` : ""}. Those old images were still made from the originals; run the compare again while imgix answers to check them.`);
		}
		if (notMade > 0) info.push(`The rules check skipped ${plural(notMade, "setting")} whose files imgix showed as images (a PDF or PSD), which the compare can't make from the original.`);
		if (media.downloaded > 0) info.push(`${plural(media.downloaded, "original")} the preload's ledger lacks ${media.downloaded === 1 ? "was" : "were"} downloaded from assets.takeshape.io into takeshape/compare-originals/.`);
	}

	return { get, check, sampled };
}
type OldImages = ReturnType<typeof oldImages>;

async function compareImages(path: string, o: Fetched, n: Fetched, oldBase: string, newBase: string, diffs: Difference[], origins: string[], timeoutMs: number, olds: OldImages, index?: Map<string, IndexedImage>) {
	const oi = normalizeHtml(decode(o.body), { origins }).images;
	const ni = normalizeHtml(decode(n.body), { origins }).images;
	if (oi.length !== ni.length) {
		const word = (k: number) => (k === 1 ? "image" : "images");
		diffs.push({ path, kind: "image", detail: `${oi.length} ${word(oi.length)} on the old page, ${ni.length} on the new.` });
		return;
	}
	const count = oi.length;
	const resolve = (raw: string, base: string) => {
		try {
			return new URL(raw, new URL(path, base)).href;
		} catch {
			return null;
		}
	};
	for (let i = 0; i < count; i++) {
		const ou = resolve(oi[i], oldBase);
		const nu = resolve(ni[i], newBase);
		if (!ou || !nu || !/^https?:/.test(ou) || !/^https?:/.test(nu) || ou === nu) continue;
		const known = index?.get(ou);
		const saved = known && !("error" in known) ? known : undefined;
		// The new image is hashed the way the index entry was
		const [a, b] = await Promise.allSettled([olds.get(ou, path), imageInfo(nu, timeoutMs, saved?.version)]);
		const label = `Image ${i + 1} on this page`;
		if (a.status === "rejected" && a.reason instanceof NotMadeLocally) {
			const shown = b.status === "fulfilled" ? `is a ${b.value.width}x${b.value.height} image` : "isn't one";
			diffs.push({ path, kind: "image", detail: `${label}: imgix showed the file old ${oi[i]} as an image; new ${ni[i]} ${shown}.` });
			continue;
		}
		if (a.status === "rejected" && b.status === "rejected") continue;
		if (a.status === "rejected" || b.status === "rejected") {
			const side = a.status === "rejected" ? `old ${oi[i]}` : `new ${ni[i]}`;
			const why = (a.status === "rejected" ? a : (b as PromiseRejectedResult)).reason;
			diffs.push({ path, kind: "image", detail: `${label}: cannot read ${side} (${why instanceof Error ? why.message : String(why)}).` });
			continue;
		}
		const x = a.value;
		const y = b.value;
		if (x.width !== y.width || x.height !== y.height) {
			diffs.push({ path, kind: "image", detail: `${label}: old ${oi[i]} is ${x.width}x${x.height}, new ${ni[i]} is ${y.width}x${y.height}.` });
			continue;
		}
		const dist = hashDistance(x.hash, y.hash);
		if (dist > MAX_HASH_DISTANCE) {
			diffs.push({ path, kind: "image", detail: `${label}: old ${oi[i]} and new ${ni[i]} are the same size but look different (hash distance ${dist}, at most ${MAX_HASH_DISTANCE} allowed).` });
		}
	}
}

export async function compareSites(oldBase: string, newBase: string, options: CompareOptions): Promise<Difference[]> {
	return (await compareDetailed(oldBase, newBase, options)).differences;
}

class UsageError extends Error {}

function parseArgs(argv: string[]) {
	const positional: string[] = [];
	const o = { urls: null as string | null, out: "compare-report.md", json: null as string | null, concurrency: 4, delayMs: 0, ignore: [] as string[], timeoutMs: DEFAULT_TIMEOUT_MS, maxPages: DEFAULT_MAX_PAGES, ignoreQuery: false, origins: [] as string[], imageIndex: null as string | null, media: null as string | null, fetchLog: null as string | null };
	const num = (name: string, v: string | undefined) => {
		const n = Number(v);
		if (v === undefined || !Number.isInteger(n) || n < 0) throw new UsageError(`${name} needs a whole number.`);
		return n;
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new UsageError(`${a} needs a value.`);
			return v;
		};
		if (a === "--urls") o.urls = next();
		else if (a === "--out") o.out = next();
		else if (a === "--json") o.json = next();
		else if (a === "--concurrency") o.concurrency = Math.max(1, num(a, next()));
		else if (a === "--delay-ms") o.delayMs = num(a, next());
		else if (a === "--ignore-text") o.ignore.push(next());
		else if (a === "--timeout-ms") o.timeoutMs = Math.max(1, num(a, next()));
		else if (a === "--max-pages") o.maxPages = Math.max(1, num(a, next()));
		else if (a === "--ignore-query") o.ignoreQuery = true;
		else if (a === "--image-index") o.imageIndex = next();
		else if (a === "--media") o.media = next();
		else if (a === "--fetch-log") o.fetchLog = next();
		else if (a === "--origin") {
			const v = next();
			try {
				o.origins.push(new URL(v).origin);
			} catch {
				throw new UsageError(`--origin needs a full URL such as https://example.com, not ${v}.`);
			}
		}
		else if (a.startsWith("--")) throw new UsageError(`Unknown option ${a}.`);
		else positional.push(a);
	}
	if (positional.length !== 2) throw new UsageError("Give the old site and the new site, each a URL or a folder.");
	return { oldSite: positional[0], newSite: positional[1], ...o };
}

async function main(argv: string[]): Promise<number> {
	const closers: Array<() => Promise<void>> = [];
	try {
		const args = parseArgs(argv);
		if (args.fetchLog) {
			// Every request this compare makes, pages and images on both sides, one URL per line
			const log = args.fetchLog;
			await writeFile(log, "");
			const real = globalThis.fetch;
			globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
				appendFileSync(log, `${input instanceof Request ? input.url : String(input)}\n`);
				return real(input, init);
			};
		}
		const media = args.media ? openMedia(args.media) : undefined;
		if (media) closers.push(async () => media.close());
		let imageIndex: Map<string, IndexedImage> | undefined;
		// The file's entries as written, so writing it back keeps them byte for byte
		let rawIndex: Record<string, unknown> | undefined;
		let indexMissing = false;
		if (args.imageIndex) {
			const file = args.imageIndex;
			const missing = !(await stat(file).then(() => true, () => false));
			indexMissing = missing;
			// With --media the compare records imgix's answers there, so it may start the file
			const text = missing && media ? "{}" : await readFile(file, "utf8").catch(() => {
				throw new UsageError(`Cannot read the --image-index file ${file}.`);
			});
			try {
				imageIndex = parseImageIndex(text);
				rawIndex = JSON.parse(text) as Record<string, unknown>;
			} catch (e) {
				throw new UsageError(`The --image-index file ${file} is not an image index: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		const ignoreText = args.ignore.map((s) => {
			try {
				return new RegExp(s, "g");
			} catch {
				throw new UsageError(`--ignore-text is not a valid pattern: ${s}`);
			}
		});
		const seeds: string[] = [];
		if (args.urls) {
			const text = await readFile(args.urls, "utf8").catch(() => {
				throw new UsageError(`Cannot read the --urls file ${args.urls}.`);
			});
			for (const line of text.split(/\r?\n/)) {
				const t = line.trim();
				if (t && !t.startsWith("#")) seeds.push(t);
			}
		}
		const open = async (site: string) => {
			if (/^https?:\/\//i.test(site)) return site;
			if (!(await stat(site).then((s) => s.isDirectory(), () => false))) throw new UsageError(`The folder ${site} does not exist.`);
			const s = await serveDir(site).catch(() => {
				throw new UsageError(`Cannot serve the folder ${site}.`);
			});
			closers.push(s.close);
			return s.url;
		};
		const oldBase = await open(args.oldSite);
		const newBase = await open(args.newSite);
		const result = await compareDetailed(oldBase, newBase, { seeds, concurrency: args.concurrency, delayMs: args.delayMs, ignoreText, timeoutMs: args.timeoutMs, maxPages: args.maxPages, ignoreQuery: args.ignoreQuery, origins: args.origins, labels: { oldSite: args.oldSite, newSite: args.newSite }, imageIndex, media });
		// Written only when it gains entries or didn't exist, so a saved index stays as it was otherwise
		if (args.imageIndex && rawIndex && media && (result.sampled.size > 0 || indexMissing)) {
			const entries = new Map<string, IndexedImage | Record<string, unknown>>(Object.entries(rawIndex) as Array<[string, Record<string, unknown>]>);
			for (const [url, info] of result.sampled) entries.set(url, info);
			await writeFile(args.imageIndex, writeImageIndex(entries));
		}
		await writeFile(args.out, renderReport(result, { oldSite: args.oldSite, newSite: args.newSite }));
		const { sampled: _sampled, ...reported } = result;
		if (args.json) await writeFile(args.json, `${JSON.stringify({ oldSite: args.oldSite, newSite: args.newSite, ...reported }, null, 2)}\n`);
		const n = result.differences.length;
		if (result.notes.length > 0) console.log("The compare is incomplete because the page cap was hit. See the Notes section of the report.");
		if (result.info.length > 0) console.log(`${plural(result.info.length, "note")} for this run in the report.`);
		console.log(n === 0 ? `No differences. Report written to ${args.out}.` : `${n} ${n === 1 ? "difference" : "differences"}. Report written to ${args.out}.`);
		return n === 0 && result.notes.length === 0 ? 0 : 1;
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		if (e instanceof UsageError) {
			console.error(
				[
					"Usage: node compare/compare-sites.mts <old URL|dir> <new URL|dir> [options]",
					"  --urls <file>         extra paths or URLs to start from, one per line; each is compared,",
					"                        files such as CSS, scripts and icons too",
					"  --out <file>          markdown report (default compare-report.md)",
					"  --json <file>         also write a JSON report",
					"  --concurrency <n>     parallel requests (default 4)",
					"  --delay-ms <n>        wait before each request (default 0)",
					"  --timeout-ms <n>      give up on a request after this long (default 30000)",
					"  --max-pages <n>       stop crawling after this many paths per site (default 5000)",
					"  --ignore-query        crawl /a?x=1 and /a?x=2 as one path",
					"  --origin <url>        another origin that counts as this site (repeatable)",
					"  --ignore-text <regex> remove matching text before comparing. HTML text only.",
					"                        Give the JavaScript regex source without flags or slashes (repeatable)",
					"  --media <dir>         the new project's folder: old images on TakeShape's hosts are made from",
					"                        the originals the converter's --preload-media local stored there, and",
					"                        imgix is asked for one image per setting, to check the rules",
					"  --image-index <file>  the old site's images from a saved index (URL to width, height and hex",
					"                        hash) instead of fetching them. With --media, imgix's answers are",
					"                        written back to it (the file may not exist yet). An entry made with",
					"                        an older hash (its \"version\") is compared the way it was made",
					"  --fetch-log <file>    write every URL the compare fetches, one per line",
				].join("\n"),
			);
		}
		return 2;
	} finally {
		for (const c of closers) await c();
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
