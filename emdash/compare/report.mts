import type { Difference } from "./compare-sites.mts";
import type { ImageInfo } from "./images.mts";

export type TakeshapeSiteLinks = Array<{ path: string; links: string[] }>;
export type CompareResult = {
	differences: Difference[];
	// Links to takeshape.io or www.takeshape.io on the new site. They do not fail the compare.
	takeshapeSiteLinks: TakeshapeSiteLinks;
	pagesCompared: number;
	// Why the compare is incomplete (the page cap): the run exits 1.
	notes: string[];
	// What a reader should know about this run (the rules check couldn't run, images fetched from TakeShape). They
	// don't change the exit code.
	info: string[];
	// imgix's answers fetched this run (samples, crops imgix placed), for --image-index.
	sampled: Map<string, ImageInfo>;
};

const KINDS: Array<[Difference["kind"], string]> = [
	["missing", "Pages the new site does not have"],
	["extra", "Pages only the new site has"],
	["status", "Different status codes"],
	["redirect", "Different redirects"],
	["content", "Different page content"],
	["broken-link", "Links on the new site that lead nowhere"],
	["image", "Images that differ"],
	["image-rules", "Settings where the local image doesn't match imgix's"],
	["takeshape-host", "TakeShape services that stop on December 31"],
];

const MAX_LINES = 20;

export function renderReport(result: CompareResult, labels: { oldSite: string; newSite: string }): string {
	const out: string[] = ["# Site comparison", "", `Old site: ${labels.oldSite}`, `New site: ${labels.newSite}`, ""];
	const { differences } = result;
	const pages = `${result.pagesCompared} ${result.pagesCompared === 1 ? "page" : "pages"} compared`;
	if (differences.length === 0) out.push(result.notes.length > 0 ? `${pages}. No differences found in those pages, but the compare is incomplete (see Notes).` : `${pages}. No differences found.`, "");
	else out.push(`${pages}. ${differences.length} ${differences.length === 1 ? "difference" : "differences"} found.`, "");
	if (result.notes.length > 0) out.push("## Notes", "", ...result.notes.map((x) => `- ${x}`), "");
	if (result.info.length > 0) out.push("## Notes for this run", "", ...result.info.map((x) => `- ${x}`), "");
	if (differences.length > 0) {
		out.push("## Summary", "", "| Kind | What it means | Count |", "| --- | --- | --- |");
		for (const [kind, meaning] of KINDS) {
			const n = differences.filter((d) => d.kind === kind).length;
			if (n > 0) out.push(`| ${kind} | ${meaning} | ${n} |`);
		}
		out.push("", "## Differences by page", "");
		const byPath = new Map<string, Difference[]>();
		for (const d of [...differences].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
			const list = byPath.get(d.path) ?? [];
			list.push(d);
			byPath.set(d.path, list);
		}
		for (const [path, list] of byPath) {
			out.push(`### ${path}`, "");
			for (const d of list) {
				const lines = d.detail.split("\n");
				if (d.kind === "content") {
					out.push(`- content differs:`, "", "```diff", ...lines.slice(0, MAX_LINES));
					if (lines.length > MAX_LINES) out.push(`... and ${lines.length - MAX_LINES} more lines`);
					out.push("```");
				} else {
					out.push(`- ${d.kind}: ${lines[0]}`);
					for (const l of lines.slice(1, MAX_LINES)) out.push(`  ${l}`);
				}
			}
			out.push("");
		}
	}
	if (result.takeshapeSiteLinks.length > 0) {
		out.push("## Links to TakeShape's website, which go dead after December 31", "");
		out.push("These links do not fail the comparison. Check whether you want to keep them.", "");
		for (const { path, links } of result.takeshapeSiteLinks) {
			out.push(`### ${path}`, "", ...links.map((l) => `- ${l}`), "");
		}
	}
	return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
