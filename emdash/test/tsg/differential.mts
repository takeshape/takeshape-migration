/**
 * Differential test for the template emitters: renders each case in test/tsg/cases/ with real Nunjucks 3.2.0
 * (autoescape on, the TakeShape filters registered) and with the emitted Astro components, built by Astro 7.4.0
 * in test/.cache/tsg-astro-cases/, then compares the two.
 *
 * HTML pages are compared as canonicalLines(normalizeHtml(...)) plus the image list; text templates must match
 * byte for byte. A case also fails when the emitters report anything as not translated, unless case.json lists
 * the expected constructs in "report".
 *
 * It also builds the route pages emitPage writes for templates whose names could clash with the page's own names
 * (template.html, astro.html) and for a template with no Nunjucks in it, against stub route modules, and checks
 * that each compiles with its imports kept and renders.
 *
 * Needs the network the first time (npm ci of the Astro project) and Node 22.22 or later (Astro's minimum).
 * Usage: node test/tsg/differential.mts [case ...]. After a run, test/.cache/tsg-astro-cases/ holds the emitted
 * components (src/cases/), the Astro build (dist/client/) and the Nunjucks output (dist/<case>.nunjucks.*).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import nunjucks from "nunjucks";
import { canonicalLines, normalizeHtml } from "../../compare/normalize.mts";
import { loadTsgConfig } from "../../tsg2astro/config.mts";
import type { TsgConfig } from "../../tsg2astro/config.mts";
import { Report } from "../../tsg2astro/report.mts";
import { asset, configure, date, image, route } from "../../tsg2astro/runtime/filters.ts";
import type { SiteConfig } from "../../tsg2astro/runtime/filters.ts";
import { loadTemplates } from "../../tsg2astro/templates.mts";
import type { Template } from "../../tsg2astro/templates.mts";
import { emitPage, routeModulePaths } from "../../tsg2astro/emit-routes.mts";
import { pageFiles, planRoutes } from "../../tsg2astro/routes.mts";

const here = dirname(fileURLToPath(import.meta.url));
const emdash = resolve(here, "..", "..");
const casesDir = join(here, "cases");
const project = join(here, "astro-cases");
const work = join(emdash, "test", ".cache", "tsg-astro-cases");
const runtime = join(emdash, "tsg2astro", "runtime");
const books = join(here, "sites", "shape-books", "site");

/**
 * report: the constructs the emitters must report as not translated (default none).
 * contains / absent: text the built page must or must not contain, for what the comparison cannot see (comments,
 * doctypes, exact bytes). "contains" is checked against the Nunjucks output too, so the expectation stays honest.
 */
type CaseSpec = { entry: string; templates?: string; report?: string[]; contains?: string[]; absent?: string[] };
type Case = { name: string; kind: "html" | "text"; expected: string; out: string; spec: CaseSpec };
type EmittedFile = { path: string; source: string };
type Emitters = {
	emitAstroComponent: (t: Template, templates: Map<string, Template>, report: Report) => EmittedFile;
	emitTextModule: (t: Template, templates: Map<string, Template>, report: Report) => EmittedFile;
	emitMacroModule: (t: Template, templates: Map<string, Template>, report: Report) => EmittedFile | null;
};

function write(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

/** Line diff (longest common subsequence) with two lines of context around each change. */
function lineDiff(a: string[], b: string[]): string[] {
	const n = a.length;
	const m = b.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
	const ops: Array<{ op: " " | "-" | "+"; line: string }> = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			ops.push({ op: " ", line: a[i]! });
			i++;
			j++;
		} else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) ops.push({ op: "+", line: b[j++]! });
		else ops.push({ op: "-", line: a[i++]! });
	}
	const keep = ops.map((o, k) => o.op !== " " || ops.slice(Math.max(0, k - 2), k + 3).some((x) => x.op !== " "));
	const out: string[] = [];
	ops.forEach((o, k) => {
		if (keep[k]) out.push(`${o.op} ${o.line}`);
		else if (keep[k - 1]) out.push("  ...");
	});
	return out;
}

function installHash(): string {
	const h = createHash("sha256");
	for (const f of ["package.json", "package-lock.json"]) h.update(readFileSync(join(project, f)));
	return h.digest("hex");
}

/** Copies the Astro project into the cache and runs npm ci only when its package files changed. */
function prepareProject(): void {
	mkdirSync(work, { recursive: true });
	for (const f of ["package.json", "package-lock.json", "astro.config.mjs"]) copyFileSync(join(project, f), join(work, f));
	const stamp = join(work, ".installed");
	const hash = installHash();
	if (!existsSync(join(work, "node_modules")) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== hash) {
		console.log("Installing the Astro test project (npm ci)...");
		execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: work, stdio: "inherit" });
		writeFileSync(stamp, hash);
	}
	rmSync(join(work, "src"), { recursive: true, force: true });
	rmSync(join(work, "dist"), { recursive: true, force: true });
}

async function siteConfig(): Promise<SiteConfig> {
	const c: TsgConfig = await loadTsgConfig(books, {});
	const routes: SiteConfig["routes"] = {};
	for (const [name, r] of Object.entries(c.routes)) routes[name] = { path: r.path, ...(r.paginate ? { paginate: { path: r.paginate.path } } : {}) };
	return { routes, pathPrefix: c.pathPrefix, imageDefaults: c.imageDefaults, dates: c.dates, locale: c.locale, mediaPath: "/_emdash/api/media/file" };
}

function renderNunjucks(root: string, entry: string, context: Record<string, unknown>): string {
	const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(root, { noCache: true }), { autoescape: true });
	env.addFilter("image", image);
	env.addFilter("asset", asset);
	env.addFilter("route", route);
	env.addFilter("date", date);
	return env.render(entry, context);
}

/**
 * Writes route pages from emitPage into the test project, with stub route modules (no EmDash) and the real
 * runtime, and returns them with a check of the built output.
 */
function writeRoutePages(siteConfig: SiteConfig): { pages: Array<{ path: string; source: string }>; check: (dist: string) => string[] } {
	const routes = {
		routeTemplate: { path: "/route-template/", template: "template.html" },
		routeAstro: { path: "/route-astro/", template: "astro.html" },
		routeRobots: { path: "/route-robots.txt", template: "robots.txt" },
	};
	const plans = planRoutes({ routes } as unknown as TsgConfig, new Report());
	const t = (name: string, kind: Template["kind"]): Template => ({ name, kind, source: "", ast: null, extends: null, includes: [], blocks: [], tagInteriors: [] });
	const templates = new Map([t("template.html", "html"), t("astro.html", "html"), t("robots.txt", "raw")].map((x) => [x.name, x]));
	const modules = routeModulePaths(Object.keys(routes));
	const src = join(work, "src");
	for (const f of ["context.ts", "filters.ts", "imgix.ts", "public-origin.ts"]) write(join(src, "lib", "takeshape", f), readFileSync(join(runtime, f), "utf8"));
	write(join(src, "lib", "takeshape", "emdash-api.ts"), "// Stub: the route modules below never call EmDash.\nexport const emdashApi = {};\n");
	write(join(src, "lib", "takeshape", "site.ts"), `import { configure } from "./filters.ts";\nconfigure(${JSON.stringify(siteConfig)});\n`);
	for (const [name, file] of modules) {
		write(join(work, file), `import "../lib/takeshape/site.ts";\nexport async function page(_api: unknown, _path: string) {\n\treturn { title: "Rendered ${name}" };\n}\n`);
	}
	write(join(src, "templates", "template.astro"), '---\nconst { title } = Astro.props;\n---\n<p id="route-template">{title}</p>\n');
	write(join(src, "templates", "astro.astro"), '---\nconst { title } = Astro.props;\n---\n<p id="route-astro">{title}</p>\n');
	write(join(src, "templates", "robots.txt"), "User-agent: *\n");
	const pages = pageFiles(plans).map((f) => emitPage(f, routes, modules, templates));
	for (const page of pages) write(join(work, page.path), page.source);
	const check = (dist: string): string[] => {
		const problems: string[] = [];
		const read = (...names: string[]) => names.map((n) => join(dist, n)).find((f) => existsSync(f));
		for (const [id, name] of [["route-template", "routeTemplate"], ["route-astro", "routeAstro"]]) {
			const file = read(`${id}.html`, `${id}/index.html`);
			const html = file ? readFileSync(file, "utf8") : "";
			if (!html.includes(`<p id="${id}">Rendered ${name}</p>`)) problems.push(`${id} did not render its template: ${html.slice(0, 200) || "(no file)"}`);
		}
		const robots = read("route-robots.txt");
		if (!robots || readFileSync(robots, "utf8") !== "User-agent: *\n") problems.push(`route-robots.txt is ${robots ? JSON.stringify(readFileSync(robots, "utf8")) : "missing"}`);
		return problems;
	};
	return { pages, check };
}

async function main(): Promise<number> {
	const only = new Set(process.argv.slice(2));
	let emitters: Emitters;
	try {
		emitters = {
			...(await import("../../tsg2astro/emit-astro.mts")),
			...(await import("../../tsg2astro/emit-text.mts")),
		} as Emitters;
	} catch (e) {
		console.error(`The emitters could not be loaded: ${(e as Error).message}`);
		return 1;
	}
	const config = await siteConfig();
	configure(config);
	prepareProject();

	const cases: Case[] = [];
	const failures: string[] = [];
	const components: Array<{ name: string; file: string; source: string }> = [];
	for (const name of readdirSync(casesDir).sort()) {
		if (only.size && !only.has(name)) continue;
		const dir = join(casesDir, name);
		const spec = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as CaseSpec;
		const root = spec.templates ? resolve(dir, spec.templates) : dir;
		const kind = /\.html?$/i.test(spec.entry) ? "html" : "text";
		const context = JSON.parse(readFileSync(join(dir, "context.json"), "utf8")) as Record<string, unknown>;
		const report = new Report();
		const templates = await loadTemplates(root, { templatePath: "." } as TsgConfig, [{ name: spec.entry, kind }], report);
		const base = join(work, "src", "cases", name);
		for (const t of [...templates.values()].sort((x, y) => (x.name < y.name ? -1 : 1))) {
			const file = t.kind === "text" ? emitters.emitTextModule(t, templates, report) : emitters.emitAstroComponent(t, templates, report);
			write(join(base, file.path.replace(/^src\//, "")), file.source);
			const macros = emitters.emitMacroModule(t, templates, report);
			if (macros) write(join(base, macros.path.replace(/^src\//, "")), macros.source);
			if (file.path.endsWith(".astro")) components.push({ name, file: file.path, source: file.source });
		}
		for (const f of ["nunjucks.ts", "filters.ts", "imgix.ts", "public-origin.ts"]) write(join(base, "lib", "takeshape", f), readFileSync(join(runtime, f), "utf8"));
		write(join(base, "context.json"), JSON.stringify(context, null, 2));
		const entryOut = spec.entry.replace(/\.[^./]+$/, "");
		const setup = `import { configure } from "../cases/${name}/lib/takeshape/filters.ts";\nimport context from "../cases/${name}/context.json";\nconfigure(${JSON.stringify(config)});\n`;
		let out: string;
		if (kind === "html") {
			out = `${name}.html`;
			write(join(work, "src", "pages", `${name}.astro`), `---\n${setup}import Entry from "../cases/${name}/templates/${entryOut}.astro";\n---\n<Entry {...context} />\n`);
		} else {
			const ext = extname(spec.entry);
			out = `${name}${ext}`;
			write(
				join(work, "src", "pages", `${name}${ext}.ts`),
				`${setup}import { render } from "../cases/${name}/templates/${spec.entry}.ts";\n\nexport function GET() {\n\treturn new Response(render(context));\n}\n`,
			);
		}
		const items = report.items().filter((i) => i.kind === "not-translated");
		const got = items.map((i) => i.construct ?? "").sort();
		const want = [...(spec.report ?? [])].sort();
		if (JSON.stringify(got) !== JSON.stringify(want)) {
			failures.push(name);
			console.log(`FAIL ${name}: report items differ from case.json "report"`);
			for (const i of items) console.log(`  ${i.file}:${i.line ?? ""} ${i.construct ?? ""}: ${i.message}`);
		}
		let expected: string;
		try {
			expected = renderNunjucks(root, spec.entry, context);
		} catch (e) {
			console.log(`FAIL ${name}: Nunjucks could not render it: ${(e as Error).message}`);
			failures.push(name);
			continue;
		}
		cases.push({ name, kind, expected, out, spec });
	}
	if (!cases.length) {
		console.log("No cases to build.");
		return failures.length ? 1 : 0;
	}

	// Route pages: emitPage's output for templates named like the page's own variables, and for plain text
	const routePages = writeRoutePages(config);
	for (const page of routePages.pages) if (page.path.endsWith(".astro")) components.push({ name: "route-pages", file: page.path, source: page.source });

	// Every emitted component must compile on its own; this names the file when one does not.
	const astroRequire = createRequire(join(work, "node_modules", "astro", "package.json"));
	const compiler = (await import(pathToFileURL(astroRequire.resolve("@astrojs/compiler-rs")).href)) as {
		transform: (src: string, opts: { filename: string }) => { diagnostics?: Array<{ severity: string; text: string; labels?: Array<{ line: number; column: number }> }> };
	};
	let compileFailed = false;
	for (const c of components) {
		const result = compiler.transform(c.source, { filename: `/${c.name}/${c.file}` }) as { code?: string; diagnostics?: Array<{ severity: string; text: string; labels?: Array<{ line: number; column: number }> }> };
		const errors = (result.diagnostics ?? []).filter((d) => d.severity === "error");
		// The compiler drops an import whose name the frontmatter declares again, without a diagnostic
		if (c.name === "route-pages") {
			for (const m of c.source.matchAll(/^import (\w+) from "([^"]+)";$/gm)) {
				if (!new RegExp(`\\b${m[1]}\\b[^\\n]*${m[2]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(result.code ?? "")) {
					errors.push({ severity: "error", text: `the import of ${m[1]} from ${m[2]} is gone after compiling` });
				}
			}
		}
		if (!errors.length) continue;
		compileFailed = true;
		if (!failures.includes(c.name)) failures.push(c.name);
		for (const d of errors) console.log(`FAIL ${c.name}: ${c.file}:${d.labels?.[0]?.line ?? ""}:${d.labels?.[0]?.column ?? ""} does not compile: ${d.text}`);
	}
	if (compileFailed) {
		console.log("FAIL: emitted components do not compile");
		return 1;
	}

	try {
		execFileSync(process.execPath, [join(work, "node_modules", "astro", "bin", "astro.mjs"), "build"], {
			cwd: work,
			stdio: "pipe",
			env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
		});
	} catch (e) {
		const err = e as { stdout?: Buffer; stderr?: Buffer };
		console.log(String(err.stdout ?? ""));
		console.log(String(err.stderr ?? ""));
		console.log("FAIL: astro build failed");
		return 1;
	}

	for (const c of cases) {
		const file = join(work, "dist", "client", c.out);
		if (!existsSync(file)) {
			console.log(`FAIL ${c.name}: ${c.out} was not built`);
			failures.push(c.name);
			continue;
		}
		const actual = readFileSync(file, "utf8");
		writeFileSync(join(work, "dist", `${c.name}.nunjucks${extname(c.out)}`), c.expected);
		let diff: string[] = [];
		if (c.kind === "html") {
			const a = normalizeHtml(c.expected, { origins: [] });
			const b = normalizeHtml(actual, { origins: [] });
			diff = lineDiff([...canonicalLines(a.tree), ...a.images.map((u) => `image ${u}`)], [...canonicalLines(b.tree), ...b.images.map((u) => `image ${u}`)]);
		} else if (c.expected !== actual) {
			diff = lineDiff(c.expected.split("\n").map((l) => JSON.stringify(l)), actual.split("\n").map((l) => JSON.stringify(l)));
		}
		for (const want of c.spec.contains ?? []) {
			if (!c.expected.includes(want)) diff.push(`Nunjucks output lacks ${JSON.stringify(want)} (fix the case)`);
			if (!actual.includes(want)) diff.push(`Astro output lacks ${JSON.stringify(want)}`);
		}
		for (const bad of c.spec.absent ?? []) if (actual.includes(bad)) diff.push(`Astro output contains ${JSON.stringify(bad)}`);
		if (diff.length) {
			if (!failures.includes(c.name)) failures.push(c.name);
			console.log(`FAIL ${c.name} (- Nunjucks, + Astro)`);
			for (const l of diff) console.log(`  ${l}`);
		} else if (!failures.includes(c.name)) console.log(`ok   ${c.name}`);
	}
	const routeProblems = routePages.check(join(work, "dist", "client"));
	if (routeProblems.length) {
		failures.push("route-pages");
		console.log("FAIL route-pages");
		for (const l of routeProblems) console.log(`  ${l}`);
	} else console.log("ok   route-pages");
	cases.push({ name: "route-pages", kind: "html", expected: "", out: "", spec: { entry: "" } });

	const total = new Set([...cases.map((c) => c.name), ...failures]).size;
	console.log(`\n${total - failures.length} of ${total} cases match.`);
	return failures.length ? 1 : 0;
}

process.exitCode = await main();
