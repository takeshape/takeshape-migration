#!/usr/bin/env node
/**
 * tsg2astro: translate a site built with TakeShape's static site generator (takeshape-ssg) into an Astro project
 * on EmDash, for Cloudflare Workers, with a Node config for local runs.
 *
 *   node tsg2astro/tsg2astro.mts <site dir> --export <zip|dir> --field-map <file> [--out ./emdash-site] [--site-url URL]
 *
 * <site dir> is the folder that holds tsg.yml (or tsg.yml itself). --export is the TakeShape export the content
 * came from, and --field-map the takeshape-field-map.json that `ts2emdash.mts --site` wrote next to the seed.
 * --site-url writes EMDASH_SITE_URL to the project's .env, so EmDash resizes images.
 *
 * It writes pages for every tsg.yml route, components from the templates, loaders from the queries, the helpers
 * they import, public/ from static/, and tsg2astro-report.md, which lists the files behind every URL and
 * anything not translated. The output is the same on every run. A rerun rewrites only what tsg2astro wrote
 * (listed in .tsg2astro.json) and never touches data.db, uploads/, .wrangler/, takeshape/, node_modules/ or dist*.
 *
 * Requires Node 22.18+ and this repo's emdash/ packages (npm install in emdash/). The generated project needs
 * Node 22.22 or later.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FieldMap } from "../ts2emdash.mts";
import { loadTsgConfig, tsgConfigPath } from "./config.mts";
import type { TsgConfig, TsgRoute } from "./config.mts";
import { emitAstroComponent } from "./emit-astro.mts";
import { emitLoader, loaderPath } from "./emit-loader.mts";
import { load } from "./load.mts";
import { DataFiles, emitGlobalModule, emitPage, emitRouteModule, emitSiteModule, momentLocaleFile, queryUses, routeModulePaths } from "./emit-routes.mts";
import { emitMacroModule, emitTextModule } from "./emit-text.mts";
import { readExport } from "./export.mts";
import { planQuery } from "./queries.mts";
import type { QueryPlan } from "./queries.mts";
import { Report } from "./report.mts";
import { isNotFoundRoute, NOT_FOUND_PAGE, pageFiles, planRoutes, reservedRoute } from "./routes.mts";
import type { RoutePlan } from "./routes.mts";
import { imageParamProblem } from "./runtime/imgix.ts";
import { loadTakeShapeSchema } from "./schema.mts";
import { checkOutputs, earlierOwns, OWNED_DIRS, REPORT_FILE, scaffoldFiles, siteName, writeProject } from "./scaffold.mts";
import type { OutFile } from "./scaffold.mts";
import { outPath, RUNTIME_DIR, siteFileName, templateKey } from "./scope.mts";
import type { NjNode, RouteUse, Template } from "./templates.mts";
import { loadTemplates, sharedNames } from "./templates.mts";

const here = dirname(fileURLToPath(import.meta.url));
const USAGE = "Usage: node tsg2astro/tsg2astro.mts <site dir> --export <zip|dir> --field-map <file> [--out ./emdash-site] [--site-url URL]";

function fail(message: string): never {
	console.error(`tsg2astro: ${message}`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const opts: { site: string | null; export: string | null; fieldMap: string | null; out: string; siteUrl: string | null } = {
	site: null,
	export: null,
	fieldMap: null,
	out: "emdash-site",
	siteUrl: null,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const a = argv[i] as string;
	const value = (flag: string): string => {
		const v = argv[++i];
		if (!v || v.startsWith("--")) fail(`${flag} needs a value. ${USAGE}`);
		return v;
	};
	if (a === "--export") opts.export = value(a);
	else if (a === "--field-map") opts.fieldMap = value(a);
	else if (a === "--out") opts.out = value(a);
	else if (a === "--site-url") opts.siteUrl = value(a);
	else if (a === "-h" || a === "--help") {
		console.log(USAGE);
		process.exit(0);
	} else if (!a.startsWith("--") && !opts.site) opts.site = a;
	else fail(`Unknown option: ${a}. ${USAGE}`);
}
if (!opts.site) fail(`Pass the folder of your takeshape-ssg site. ${USAGE}`);
if (!opts.export) fail("Pass --export with the TakeShape export (ZIP or folder) the content came from.");
if (!opts.fieldMap) fail("Pass --field-map with the takeshape-field-map.json that ts2emdash.mts --site wrote next to the seed.");
if (opts.siteUrl !== null) {
	let url: URL | null = null;
	try {
		url = new URL(opts.siteUrl);
	} catch {
		// reported below
	}
	if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) fail(`--site-url takes an http or https URL, got ${opts.siteUrl}`);
}

const posixPath = (p: string): string => p.split(sep).join("/");
const inside = (parent: string, child: string): boolean => {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
};

// ---------------------------------------------------------------------------
// Reading the site
// ---------------------------------------------------------------------------

const configFile = await tsgConfigPath(resolve(opts.site)).catch((e: Error) => fail(e.message));
const siteDir = dirname(configFile);
const config: TsgConfig = await loadTsgConfig(configFile, process.env).catch((e: Error) => fail(e.message));
const templateDir = join(siteDir, config.templatePath);
const staticDir = join(siteDir, config.staticPath);
const out = resolve(opts.out);
if (inside(siteDir, out)) fail(`--out ${out} is inside the site folder (${siteDir}). Pass a folder outside it, such as ${join(dirname(siteDir), `${basename(siteDir)}-emdash`)}.`);
for (const [what, dir] of [
	["templates", templateDir],
	["static files", staticDir],
] as const) {
	if (inside(dir, out)) fail(`--out ${out} is inside the site's ${what} (${dir}). Pass a folder outside them.`);
}
let owned: string[];
try {
	owned = earlierOwns(out);
} catch (e) {
	fail((e as Error).message);
}

const exp = await readExport(resolve(opts.export)).catch((e: Error) => fail(e.message));
const schema = loadTakeShapeSchema(exp.schema);
let fieldMap: FieldMap;
try {
	fieldMap = JSON.parse(readFileSync(resolve(opts.fieldMap), "utf8")) as FieldMap;
} catch (e) {
	fail(`Could not read the field map ${opts.fieldMap}: ${(e as Error).message}`);
}
if (fieldMap?.version !== 1 || typeof fieldMap.shapes !== "object") fail(`${opts.fieldMap} is not a field map from ts2emdash.mts (version 1).`);

const report = new Report();

// tsg.yml values filled in from the environment are fixed in the generated files
const configText = readFileSync(configFile, "utf8");
for (const name of [...new Set([...configText.matchAll(/\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1] as string))].sort()) {
	report.add({
		kind: "env",
		file: "tsg.yml",
		construct: `env.${name}`,
		message: `tsg.yml reads this when it loads. tsg2astro filled in the value it had (${process.env[name] === undefined ? "not set" : "set"}), and the generated files hold that value. To change it, edit the value where it appears under src/; setting the variable later changes nothing. If it is a secret, such as an API key, take it out of src/ before you commit: store it as a Worker secret (npx wrangler secret put ${name}) and read it at runtime with getSecret from astro:env/server.`,
	});
}

// tsg.yml's imageDefaults apply to every image
for (const [key, value] of Object.entries(config.imageDefaults ?? {})) {
	const problem = imageParamProblem(key, value);
	if (problem) report.add({ kind: "image-param", file: "tsg.yml", construct: `imageDefaults.${key}`, message: `tsg.yml sets "${key}" for every image: the image endpoint ${problem}.` });
}

// ---------------------------------------------------------------------------
// Routes, queries and templates
// ---------------------------------------------------------------------------

let routes: RoutePlan[] = planRoutes(config, report);

// Query files by templateKey, read from the templates folder as takeshape-ssg read them
const loaders = new Map<string, QueryPlan>();
const firstUse = new Map<string, { variables: Record<string, unknown>; where: string }>();
// Two query files that would get one loader file (data/a.graphql and data/a.gql, or a query in the templates
// folder's _site/ and the site file it mirrors) get none, and each use says why
const loaderFiles = new Map<string, string[]>();
for (const key of new Set(queryUses(config).map((u) => templateKey(u.file)))) {
	const outName = siteFileName(key, config.templatePath);
	if (outName === null || !existsSync(join(templateDir, key))) continue;
	const path = loaderPath(outName);
	loaderFiles.set(path, [...(loaderFiles.get(path) ?? []), key]);
}
const sharedLoader = new Map<string, string>();
for (const [path, keys] of loaderFiles) {
	if (keys.length < 2) continue;
	const { all, none } = sharedNames(keys);
	for (const key of keys) sharedLoader.set(key, `The query files ${all} become ${path}, so ${none} has a loader. Write a loader for each by hand, under a name of its own, and use it in src/routes/ where tsg.yml used this query.`);
}
for (const use of queryUses(config)) {
	const key = templateKey(use.file);
	const shared = sharedLoader.get(key);
	if (shared) {
		report.add({ kind: "not-translated", file: "tsg.yml", construct: use.where, message: shared });
		continue;
	}
	const earlier = firstUse.get(key);
	if (earlier) {
		if (JSON.stringify(earlier.variables) !== JSON.stringify(use.variables)) {
			report.add({
				kind: "query",
				file: use.file,
				construct: use.where,
				message: `This query is used with other variables in ${earlier.where}. Its one loader follows the variables there.`,
			});
		}
		continue;
	}
	firstUse.set(key, use);
	const outName = siteFileName(key, config.templatePath);
	if (outName === null) {
		report.add({ kind: "not-translated", file: "tsg.yml", construct: use.where, message: `The query file ${use.file} is outside the site folder, so tsg2astro does not read it, and it has no loader. Move it into ${config.templatePath}.` });
		continue;
	}
	let source: string;
	try {
		source = readFileSync(join(templateDir, key), "utf8");
	} catch {
		report.add({ kind: "not-translated", file: "tsg.yml", construct: use.where, message: `The query file ${use.file} was not found under ${config.templatePath}, so it has no loader.` });
		continue;
	}
	const plan = planQuery(key, source, schema, fieldMap, report, use.variables);
	loaders.set(key, outName === key ? plan : { ...plan, outName });
}

// A paginated route needs its query and exactly one list in it to page through, as takeshape-ssg did
const unpaged = new Set<string>();
routes = routes.filter((p) => {
	if (p.part === "page") return true;
	const data = config.routes[p.name]?.paginate?.data;
	const file = typeof data === "string" ? data : data?.query;
	const plan = file ? loaders.get(templateKey(file)) : undefined;
	if (!plan) return false; // its query file was reported as missing
	if (plan.paginatedAlias) return true;
	if (!unpaged.has(p.name)) {
		unpaged.add(p.name);
		report.add({
			kind: "not-translated",
			file,
			construct: `routes.${p.name}.paginate.data`,
			message: "takeshape-ssg pages through a query only when it lists exactly one paginated list, and this one does not, so the route has no item or listing pages.",
		});
	}
	return false;
});

// Each template with the route parts that render it, so a template that gets no file names the routes that lose it
const entries: Array<{ name: string; kind: "html" | "text"; routes: RouteUse[] }> = [];
for (const p of routes) {
	const use = { construct: p.part === "listing" || p.part === "firstPage" ? `routes.${p.name}.paginate.template` : `routes.${p.name}.template`, name: p.name, path: p.tsgPath };
	const entry = entries.find((e) => e.name === p.template);
	if (entry) entry.routes.push(use);
	else entries.push({ name: p.template, kind: p.output, routes: [use] });
}
const templates = await loadTemplates(siteDir, config, entries, report);
routes = routes.filter((p) => templates.has(p.template));

// Templates read `env` from the context, which pages pass empty
const envReads = new Set<string>();
for (const t of [...templates.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
	const visit = (n: unknown) => {
		if (!n || typeof n !== "object") return;
		if (Array.isArray(n)) return n.forEach(visit);
		const node = n as NjNode;
		if (node.typename === "Symbol" && (node.value === "env" || node.value === "environmentVariables")) {
			const at = `${t.name}:${node.lineno + 1}`;
			if (!envReads.has(at)) {
				envReads.add(at);
				report.add({
					kind: "not-translated",
					file: t.name,
					line: node.lineno + 1,
					construct: String(node.value),
					message: "takeshape-ssg passed the build's environment variables here. Pages pass an empty object, so this reads nothing. Read the value with getSecret from astro:env/server instead.",
				});
			}
		}
		for (const v of Object.values(node)) if (v && typeof v === "object") visit(v);
	};
	visit(t.ast);
}

// ---------------------------------------------------------------------------
// Generated files
// ---------------------------------------------------------------------------

const files: OutFile[] = [];
/** `from` says what the file is written for, which the final check names when two files share a path. */
const add = (path: string, data: string | Buffer, from: string) => files.push({ path, data, from });

for (const t of [...templates.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
	const f = t.kind === "text" ? emitTextModule(t, templates, report) : emitAstroComponent(t, templates, report);
	add(f.path, f.source, `template ${t.name}`);
	const macros = emitMacroModule(t, templates, report);
	if (macros) add(macros.path, macros.source, `the macros in ${t.name}`);
}
for (const plan of loaders.values()) {
	const f = emitLoader(plan);
	add(f.path, f.source, `query ${plan.file}`);
}

const routeNames = [...new Set(routes.map((p) => p.name))];
const modules = routeModulePaths(routeNames);
// Data files the contexts name (JSON and YAML), read as takeshape-ssg read them
const yaml = ((await load<{ default?: { safeLoad: (s: string) => unknown } }>("js-yaml")).default ?? { safeLoad: () => null }) as { safeLoad: (s: string) => unknown };
const dataFiles = new DataFiles(siteDir, templateDir, (text) => yaml.safeLoad(text));
const global = emitGlobalModule(config, loaders, report, dataFiles);
add(global.path, global.source, "the global context in tsg.yml");
for (const name of routeNames) {
	const route = config.routes[name] as TsgRoute;
	const parts = routes.filter((p) => p.name === name);
	const file = modules.get(name) as string;
	const m = emitRouteModule(name, route, parts, file, loaders, report, dataFiles);
	add(m.path, m.source, `route "${name}"`);
}
for (const f of dataFiles.files.values()) add(f.path, f.source, "a data file in tsg.yml");
const pageList = pageFiles(routes);
for (const pageFile of pageList) {
	const page = emitPage(pageFile, config.routes, modules, templates);
	add(page.path, page.source, `route "${pageFile.owner.name}"`);
}

const require = createRequire(import.meta.url);
const momentLocale = momentLocaleFile(config.locale ?? "en", (name) => {
	try {
		require.resolve(`moment/locale/${name}.js`);
		return true;
	} catch {
		return false;
	}
});
const site = emitSiteModule(config, momentLocale);
add(site.path, site.source, "the tsg.yml settings");

// The runtime the generated code imports, and type declarations for its packages that ship none
for (const name of readdirSync(join(here, "runtime")).sort()) if (name.endsWith(".ts")) add(`${RUNTIME_DIR}/${name}`, readFileSync(join(here, "runtime", name)), "the runtime");
for (const name of readdirSync(join(here, "..", "types")).sort()) if (name.endsWith(".d.ts")) add(`${RUNTIME_DIR}/types/${name}`, readFileSync(join(here, "..", "types", name)), "the type declarations");

// static/ becomes public/. A file a route also writes stays out: TakeShape's production publish uploaded pages last.
const routeFiles = routes.map((p) => {
	const pieces = p.tsgPath.split(/(:[a-zA-Z][a-zA-Z0-9.]*|\{[a-zA-Z][a-zA-Z0-9.]*\})/);
	const pattern = pieces.map((s, i) => (i % 2 ? "[^/]*" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
	const file = /\.[A-Za-z0-9]+$/.test(p.tsgPath) ? pattern : `${pattern.replace(/\/$/, "")}/index\\.html`;
	return { plan: p, dynamic: pieces.length > 1, re: new RegExp(`^${file.replace(/\/+/g, "/")}$`) };
});
const staticFiles: string[] = [];
const walkStatic = (dir: string) => {
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		if (lstatSync(p).isDirectory()) walkStatic(p);
		else if (name !== ".DS_Store") staticFiles.push(posixPath(relative(staticDir, p)));
	}
};
if (existsSync(staticDir)) walkStatic(staticDir);
else report.add({ kind: "note", file: "tsg.yml", construct: "staticPath", message: `The site has no ${config.staticPath} folder, so public/ is empty.` });
// A takeshape.io host, with its scheme and path when they are there. A match starts only where a host name can
// (as in compare-sites), so a long run of letters is scanned once, not again from each of its letters.
const TAKESHAPE_HOST = /(?<![a-z0-9.-])(?:https?:)?(?:\/\/)?(?:[a-z0-9-]+\.)*takeshape\.io\b[^\s"'`<>()\\]*/gi;
for (const rel of staticFiles) {
	const data = readFileSync(join(staticDir, rel));
	const hit = routeFiles.find((r) => r.re.test(`/${rel}`));
	if (hit && !hit.dynamic) {
		report.add({
			kind: "route",
			file: `${config.staticPath}/${rel}`,
			construct: hit.plan.name,
			message: `Route "${hit.plan.name}" also writes this file. Its page is served, as TakeShape's production publish did, and the static file is left out of public/.`,
		});
		continue;
	}
	if (hit) {
		report.add({
			kind: "route",
			file: `${config.staticPath}/${rel}`,
			construct: hit.plan.name,
			message: `Route "${hit.plan.name}" may write a page at this path too. On TakeShape the page won; here the static file in public/ wins.`,
		});
	}
	add(`public/${rel}`, data, `${config.staticPath}/${rel}`);
	if (data.subarray(0, 8000).includes(0)) continue;
	const lines = data.toString("utf8").split("\n");
	const seen = new Set<string>();
	lines.forEach((line, i) => {
		for (const m of line.matchAll(TAKESHAPE_HOST)) {
			const url = m[0].length > 120 ? `${m[0].slice(0, 117)}...` : m[0];
			if (seen.has(url)) continue;
			seen.add(url);
			report.add({ kind: "takeshape-reference", file: `${config.staticPath}/${rel}`, line: i + 1, construct: url, message: "Points at TakeShape." });
		}
	});
}

// The old site's own build scripts
const sitePackage = join(siteDir, "package.json");
if (existsSync(sitePackage)) {
	let scripts: Record<string, unknown> = {};
	try {
		scripts = (JSON.parse(readFileSync(sitePackage, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
	} catch {
		report.add({ kind: "note", file: "package.json", message: "The site's package.json is not valid JSON, so its build scripts were not checked." });
	}
	for (const [name, command] of Object.entries(scripts)) {
		for (const m of String(command).matchAll(TAKESHAPE_HOST)) {
			report.add({ kind: "takeshape-reference", file: "package.json", construct: `scripts.${name}`, message: `Runs against ${m[0]}, which goes away with TakeShape.` });
		}
	}
	if (Object.keys(scripts).length) {
		report.add({
			kind: "note",
			file: "package.json",
			message: `The old site has its own scripts (${Object.keys(scripts).join(", ")}). A tsg2astro rerun replaces public/ with a fresh copy of ${config.staticPath}/, so a build that writes into ${config.staticPath}/ can keep doing so and run before tsg2astro. A build that writes into public/ has to run again after every rerun.`,
		});
	}
}

const name = siteName(siteDir);
const scaffold = scaffoldFiles(name);

/**
 * What the compare says about a path Astro answers with its own status, and when the move may end with it: only
 * with that status, since any other means the page fails, and only after a check by hand, since the compare skips
 * the content of a page it lists as missing.
 */
const acceptedDifference = (path: string, status: number): string =>
	`If the old site answered ${path} with status 200, the compare lists it as \`missing\` ("Old answers 200, new answers ${status}") and doesn't compare the two pages. This route may leave that one difference when the move is done, as long as the status is ${status} and you've checked by hand that the page matches the old one: compare \`curl -s <old site>${path}\` with \`curl -s <new site>${path}\`. Any other status at ${path} means the page fails, so fix it like any other \`missing\` page.`;

// Astro shows src/pages/404.astro for every URL no other file answers, and the pages rewrite to it. A route of
// the site's own at /404 is that page, so it replaces the scaffold's generic one.
const siteNotFound = pageList.find((p) => isNotFoundRoute(p.file));
if (siteNotFound) {
	const { owner } = siteNotFound;
	report.add({
		kind: "route",
		file: siteNotFound.file,
		construct: owner.name,
		message: `Route "${owner.name}" serves ${owner.tsgPath}, where Astro keeps the page for unknown URLs. Its page replaces the generic one, so it also answers every URL the site has no page for, and Astro answers ${owner.tsgPath} itself with status 404. ${acceptedDifference(owner.tsgPath, 404)}`,
	});
}
files.push(...scaffold.files.filter((f) => !(siteNotFound && f.path === NOT_FOUND_PAGE)));
// Astro keeps /500 and /3xx for itself too
for (const p of pageList) {
	const reserved = reservedRoute(p.file);
	if (!reserved) continue;
	const { owner } = p;
	report.add({
		kind: "route",
		file: p.file,
		construct: owner.name,
		message:
			reserved === "500"
				? `Route "${owner.name}" serves ${owner.tsgPath}, where Astro keeps its server-error page. Astro answers ${owner.tsgPath} with this page and status 500, and shows it in place of every page that fails with an error. ${acceptedDifference(owner.tsgPath, 500)}`
				: `Route "${owner.name}" serves ${owner.tsgPath}, where Astro keeps its redirect page. Astro uses that page only with experimental.redirectPage on, as the body of the redirects it writes at build time. The generated project leaves that option off, so this page is served like any other. Keep it off.`,
	});
}
// Many static hosts answered unknown URLs with the site's /404.html. Here the generic page answers them.
for (const p of routes) {
	if (p.part !== "page" || !/^\/404\.html?$/i.test(p.tsgPath) || siteNotFound) continue;
	report.add({
		kind: "route",
		file: p.file,
		construct: p.name,
		message: `Route "${p.name}" writes ${p.tsgPath}. Many static hosts served that file for every URL they had no page for; here those URLs get the generic page in ${NOT_FOUND_PAGE}. To show this route's page there, make ${NOT_FOUND_PAGE} render ${p.template} with the context that page(emdashApi, "${p.tsgPath}") in ${modules.get(p.name)} returns.`,
	});
}
const envNow = existsSync(join(out, ".env")) ? readFileSync(join(out, ".env"), "utf8") : "";
if (!opts.siteUrl && !/^\s*(export\s+)?EMDASH_SITE_URL\s*=/m.test(envNow)) {
	report.add({
		kind: "env",
		construct: "EMDASH_SITE_URL",
		message: "Set it to the site's public URL before you build (or run tsg2astro with --site-url), or EmDash serves images at full size.",
	});
}

// The report: each route part, the URLs it answers and the files that serve them
const PART_LABEL = { page: "", items: "items", listing: "listing", firstPage: "first page" } as const;
const table = routes.map((p) => ({
	name: p.part === "page" ? p.name : `${p.name} (${PART_LABEL[p.part]})`,
	urls: p.tsgPath,
	files: [p.file, modules.get(p.name) as string, outPath(templates.get(p.template) as Template)],
}));
add(REPORT_FILE, report.toMarkdown(table), "the report");

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const owns = new Set<string>([...OWNED_DIRS, ...scaffold.owns, REPORT_FILE]);
checkOutputs(files, scaffold.owns);

writeProject(out, { remove: owned, owns, files, siteUrl: opts.siteUrl });

const open = report.items().filter((i) => i.kind === "not-translated").length;
const pages = routes.length;
console.log(`✔ Wrote ${out}: ${pages} route part${pages === 1 ? "" : "s"}, ${templates.size} templates, ${loaders.size} loaders, ${staticFiles.length} static files`);
console.log(`✔ Wrote ${join(out, REPORT_FILE)} (${open ? `${open} item${open === 1 ? " needs" : "s need"} your attention` : "nothing left untranslated"})`);
console.log("Next, in that folder: npm install, npm run takeshape:seed, npm run build:node, then npm run start:node.");
