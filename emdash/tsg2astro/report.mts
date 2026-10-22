/** Collects everything the translator could not carry over, and writes tsg2astro-report.md. */
export type ReportKind = "not-translated" | "image-param" | "env" | "takeshape-reference" | "query" | "route" | "note";
export type ReportItem = { kind: ReportKind; file?: string; line?: number; construct?: string; message: string };

const SECTIONS: Array<{ kind: ReportKind; title: string; intro: string }> = [
	{ kind: "not-translated", title: "Not translated", intro: "These parts of the site have no Astro version yet. The last column says what happened to each one in the generated files. The resolve-takeshape-site-report skill in .agents/skills/ says how to fix each kind, and the compare confirms the fix." },
	{
		kind: "image-param",
		title: "Image parameters",
		intro: "Images that pass a size go through the site's image endpoint (/_takeshape/image), which honors imgix's w, h, dpr, fit, crop, fp-x, fp-y, bg, fill, fill-color, flip, fm, auto and q. Each line names a place that passes a parameter or value it ignores, so those images can come out at another size, crop or look than on the old site.",
	},
	{ kind: "env", title: "Environment variables", intro: "Values the site takes from the environment. Each line says when the value is read and how to change it." },
	{ kind: "takeshape-reference", title: "Links to TakeShape-hosted files", intro: "These point at TakeShape and will stop working after January 15, 2027." },
	{ kind: "query", title: "Queries", intro: "These GraphQL queries needed changes or could not be mapped to EmDash." },
	{ kind: "note", title: "Notes", intro: "Things worth knowing." },
];

function cell(s: string | number | undefined): string {
	return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function code(s: string | undefined): string {
	if (!s) return "";
	const text = s.replace(/\r?\n/g, " ");
	return `\`${text.replace(/\|/g, "\\|")}\``;
}

export class Report {
	#items: ReportItem[] = [];

	add(item: ReportItem): void {
		this.#items.push(item);
	}

	#line(i: ReportItem): string {
		const where = i.file ? ` (${i.file}${i.line ? `:${i.line}` : ""})` : "";
		return `- ${i.construct ? `${code(i.construct)} ` : ""}${i.message}${where}`;
	}

	items(): ReportItem[] {
		return [...this.#items];
	}

	toMarkdown(routes: Array<{ name: string; urls: string; files: string[] }>): string {
		const L: string[] = [];
		L.push("# tsg2astro report", "");
		const open = this.#items.filter((i) => i.kind === "not-translated").length;
		L.push(open ? `${open} item${open === 1 ? " needs" : "s need"} your attention. See "Not translated".` : "Nothing in the templates was left untranslated.", "");
		L.push("## Routes", "");
		if (routes.length) {
			L.push("| Route | URLs | Files |", "| --- | --- | --- |");
			for (const r of routes) L.push(`| ${cell(r.name)} | ${cell(r.urls)} | ${cell(r.files.join(", "))} |`);
		} else L.push("No routes.");
		const routeItems = this.#items.filter((i) => i.kind === "route");
		if (routeItems.length) {
			L.push("", "How some of these URLs are served, and where that differs from the original site:", "");
			for (const i of routeItems) L.push(this.#line(i));
		}
		for (const s of SECTIONS) {
			const items = this.#items.filter((i) => i.kind === s.kind);
			if (!items.length) continue;
			L.push("", `## ${s.title}`, "", s.intro, "");
			if (s.kind === "not-translated") {
				L.push("| File | Line | Construct | What happened |", "| --- | --- | --- | --- |");
				for (const i of items) L.push(`| ${cell(i.file)} | ${cell(i.line)} | ${code(i.construct)} | ${cell(i.message)} |`);
			} else for (const i of items) L.push(this.#line(i));
		}
		return `${L.join("\n")}\n`;
	}
}
