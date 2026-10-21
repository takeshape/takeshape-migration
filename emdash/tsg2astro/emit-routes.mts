/**
 * Writes what serves each route: a page or endpoint per route part in src/pages/, a route module per tsg.yml route
 * in src/routes/, the global context in src/routes/_global.ts, and src/lib/takeshape/site.ts with the tsg.yml
 * settings the filters read.
 *
 * Pages stay short: they ask their route module for the context of the requested path and render the template
 * with it, or answer 404. Route modules hold the rest: which loader feeds the route, takeshape-ssg's page rules
 * (runtime/context.ts) and the context each template sees. Both take the EmDash API as an argument, so tests run
 * them against a stub; pages pass the real one from src/lib/takeshape/emdash-api.ts.
 */
import { readFileSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";
import type { TsgConfig, TsgRoute } from "./config.mts";
import type { EmittedFile } from "./emit-astro.mts";
import { loaderPath, pathValues } from "./emit-loader.mts";
import { load } from "./load.mts";
import type { QueryPlan } from "./queries.mts";
import type { Report } from "./report.mts";
import type { PageFile, RoutePlan } from "./routes.mts";
import { importPath, isRawFile, outPath, RUNTIME_DIR, templateKey } from "./scope.mts";
import type { Template } from "./templates.mts";

export const ROUTES_DIR = "src/routes";
export const GLOBAL_MODULE = `${ROUTES_DIR}/_global.ts`;
export const SITE_MODULE = `${RUNTIME_DIR}/site.ts`;
/** Where EmDash serves stored media (the `local()` and `r2()` storage both answer here). */
export const MEDIA_PATH = "/_emdash/api/media/file";

const camelCase = (await load<{ default: (s: string) => string }>("lodash/camelCase.js", "lodash")).default;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const key = (k: string): string => (IDENTIFIER.test(k) ? k : JSON.stringify(k));

/** A JSON value as a JavaScript literal, with bare keys where they are identifiers. */
function literal(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
		return entries.length ? `{ ${entries.map(([k, v]) => `${key(k)}: ${literal(v)}`).join(", ")} }` : "{}";
	}
	return JSON.stringify(value);
}

/** An object literal of code values, on one line when it is short. */
function objectCode(entries: Array<[string, string]>, indent: string): string {
	if (!entries.length) return "{}";
	const inline = `{ ${entries.map(([k, v]) => `${key(k)}: ${v}`).join(", ")} }`;
	if (inline.length <= 80 && !inline.includes("\n")) return inline;
	return `{\n${entries.map(([k, v]) => `${indent}\t${key(k)}: ${v},`).join("\n")}\n${indent}}`;
}

/** A file name for a route module: the route name, kept to safe characters. */
function moduleName(name: string): string {
	const safe = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe || "route";
}

/** The query files a tsg.yml route uses: `{query, variables}` objects and `.graphql` strings, as takeshape-ssg read them. */
export function isQueryConfig(value: unknown): value is { query: string; variables?: Record<string, unknown> } {
	return isObj(value) && typeof value.query === "string" && /\.(graphql|gql)$/.test(value.query);
}

/** Every query file tsg.yml names, in the order takeshape-ssg met them, with the variables of each use. */
export function queryUses(config: TsgConfig): Array<{ file: string; variables: Record<string, unknown>; where: string }> {
	const uses: Array<{ file: string; variables: Record<string, unknown>; where: string }> = [];
	const visit = (value: unknown, where: string) => {
		if (typeof value === "string") {
			if (value.endsWith(".graphql")) uses.push({ file: value, variables: {}, where });
		} else if (isQueryConfig(value)) uses.push({ file: value.query, variables: value.variables ?? {}, where });
		else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) visit(v, `${where}.${k}`);
	};
	visit(config.context, "context");
	for (const [name, route] of Object.entries(config.routes ?? {}) as Array<[string, TsgRoute]>) {
		if (route.context !== undefined) visit(route.context, `routes.${name}.context`);
		const data = route.paginate?.data;
		if (typeof data === "string") uses.push({ file: data, variables: {}, where: `routes.${name}.paginate.data` });
		else if (isQueryConfig(data)) uses.push({ file: data.query, variables: data.variables ?? {}, where: `routes.${name}.paginate.data` });
	}
	return uses;
}

/**
 * The data files tsg.yml's contexts name, read as takeshape-ssg read them (resolve-context.ts): from the templates
 * folder, JSON with JSON.parse and YAML with js-yaml's safeLoad. Each is written once into src/routes/_data/ as JSON,
 * as it was when tsg2astro ran, under its path from the site folder. A file outside the site folder is never read.
 */
export class DataFiles {
	readonly files = new Map<string, { path: string; source: string; value: unknown }>(); // project path -> file
	readonly siteDir: string;
	readonly templateDir: string;
	readonly parseYaml: (text: string) => unknown;

	constructor(siteDir: string, templateDir: string, parseYaml: (text: string) => unknown) {
		this.siteDir = siteDir;
		this.templateDir = templateDir;
		this.parseYaml = parseYaml;
	}

	/** The project path the data file `name` is written to, or null when it can't be (reported). */
	file(name: string, report: Report, where: string): string | null {
		const abs = resolve(this.templateDir, name);
		const rel = relative(this.siteDir, abs).split(sep).join("/");
		const notTranslated = (why: string) => {
			report.add({ kind: "not-translated", file: "tsg.yml", construct: where, message: `The data file ${name} ${why}, so templates do not see its contents.` });
			return null;
		};
		if (!rel || rel.startsWith("../") || rel === ".." || posix.isAbsolute(rel)) return notTranslated("is outside the site folder and was not read");
		// The whole name, so nav.json, nav.yml and nav.yaml keep a copy each
		const path = `${ROUTES_DIR}/_data/${rel}.json`;
		if (this.files.has(path)) return path;
		let text: string;
		try {
			text = readFileSync(abs, "utf8");
		} catch {
			return notTranslated("was not found");
		}
		let value: unknown;
		try {
			value = /\.ya?ml$/.test(name) ? this.parseYaml(text) : JSON.parse(text);
		} catch (e) {
			return notTranslated(`could not be parsed (${(e as Error).message.split("\n")[0]})`);
		}
		// takeshape-ssg's handleYaml refused a file that loads as nothing or as plain text ("unable to load file")
		if (/\.ya?ml$/.test(name) && (!value || typeof value === "string")) return notTranslated("is empty or holds only text, which takeshape-ssg could not load");
		this.files.set(path, { path, source: `${JSON.stringify(value, null, 2)}\n`, value });
		report.add({
			kind: "note",
			file: "tsg.yml",
			construct: where,
			message: `The data file ${name} is copied into ${path} as it was when tsg2astro ran. When it changes (a front-end build that writes it, say), copy its contents there again.`,
		});
		return path;
	}
}

/** The loader and data imports one generated module needs, named after their query files (by templateKey). */
class Imports {
	readonly from: string;
	readonly plans: Loaders;
	readonly dataFiles: DataFiles | undefined;
	readonly loaders = new Map<string, string>(); // query file -> local name
	readonly data = new Map<string, string>(); // project path -> local name
	readonly names = new Set<string>();

	constructor(from: string, plans: Loaders, dataFiles?: DataFiles) {
		this.from = from;
		this.plans = plans;
		this.dataFiles = dataFiles;
	}

	/** The local name of a data file's import. */
	dataImport(path: string): string {
		const known = this.data.get(path);
		if (known) return known;
		let name = `data${this.data.size}`;
		for (let n = this.data.size; this.names.has(name); n++) name = `data${n}`;
		this.names.add(name);
		this.data.set(path, name);
		return name;
	}

	loader(file: string): string {
		const known = this.loaders.get(file);
		if (known) return known;
		const bare = file.replace(/\.(graphql|gql)$/, "");
		let name = camelCase(`load ${posix.basename(bare)}`);
		if (this.names.has(name)) name = camelCase(`load ${bare}`);
		for (let n = 2; this.names.has(name); n++) name = `${camelCase(`load ${bare}`)}${n}`;
		this.names.add(name);
		this.loaders.set(file, name);
		return name;
	}

	lines(): string[] {
		return [
			...[...this.loaders].map(([file, name]) => `import { load as ${name} } from "${importPath(this.from, loaderPath(this.plans.get(file)?.outName ?? file))}";`),
			...[...this.data].map(([path, name]) => `import ${name} from "${importPath(this.from, path)}";`),
		];
	}
}

/** The query plans by query file, as templateKey names it. */
type Loaders = ReadonlyMap<string, QueryPlan>;

/**
 * Code for a tsg.yml context value, as takeshape-ssg resolved it (resolve-context.ts): a `.graphql` file or
 * `{query, variables}` gives the query's data, `.json` and `.yaml` files their contents, a map each of its values,
 * and anything else itself. Null when the value is left out.
 */
function contextCode(value: unknown, imports: Imports, loaders: Loaders, report: Report, where: string, indent: string): string | null {
	const call = (file: string, variables: Record<string, unknown>): string | null => {
		const key = templateKey(file);
		if (!loaders.has(key)) return null; // the query was reported when it was read
		const vars = Object.keys(variables).length ? `, ${literal(variables)}` : "";
		return `await ${imports.loader(key)}(api${vars})`;
	};
	if (typeof value === "string") {
		if (value.endsWith(".graphql")) return call(value, {});
		if (/\.(json|ya?ml)$/.test(value)) {
			if (!imports.dataFiles) {
				report.add({ kind: "not-translated", file: "tsg.yml", construct: where, message: `The data file ${value} is not translated yet, so templates do not see its contents.` });
				return null;
			}
			const path = imports.dataFiles.file(value, report, where);
			return path ? imports.dataImport(path) : null;
		}
		return JSON.stringify(value);
	}
	if (isQueryConfig(value)) return call(value.query, value.variables ?? {});
	if (value && typeof value === "object") {
		const entries: Array<[string, string]> = [];
		for (const [k, v] of Object.entries(value)) {
			const code = contextCode(v, imports, loaders, report, `${where}.${k}`, `${indent}\t`);
			if (code !== null) entries.push([k, code]);
		}
		return objectCode(entries, indent);
	}
	return JSON.stringify(value ?? null);
}

/** The context code at the top of a context: takeshape-ssg kept it only when it was an object, not a list. */
function topContextCode(value: unknown, imports: Imports, loaders: Loaders, report: Report, where: string, indent: string): string {
	if (value === undefined) return "{}";
	const code = contextCode(value, imports, loaders, report, where, indent);
	if (code === null) return "{}";
	// A data file's contents are known now
	if (typeof value === "string" && /\.(json|ya?ml)$/.test(value) && imports.dataFiles) {
		const path = imports.dataFiles.file(value, report, where);
		const held = path ? imports.dataFiles.files.get(path)?.value : undefined;
		return held !== null && typeof held === "object" && !Array.isArray(held) ? code : "{}";
	}
	const isObjectValue = isQueryConfig(value) || (typeof value === "string" && value.endsWith(".graphql")) || (value !== null && typeof value === "object");
	return isObjectValue ? code : "{}";
}

export function emitGlobalModule(config: TsgConfig, loaders: Loaders, report: Report, dataFiles?: DataFiles): EmittedFile {
	const imports = new Imports(GLOBAL_MODULE, loaders, dataFiles);
	const body = topContextCode(config.context, imports, loaders, report, "context", "\t");
	const lines = [
		"// The global context from tsg.yml, which every template sees. takeshape-ssg loaded it once per build; each page",
		"// loads it once per request.",
		`import type { EmDashApi } from "${importPath(GLOBAL_MODULE, `${RUNTIME_DIR}/query.ts`)}";`,
		...imports.lines(),
		"",
		"export async function globalContext(api: EmDashApi) {",
		`\treturn ${body};`,
		"}",
		"",
	];
	return { path: GLOBAL_MODULE, source: lines.join("\n") };
}

/** The path a route's module is written to, unique among the routes. */
export function routeModulePaths(names: string[]): Map<string, string> {
	const out = new Map<string, string>();
	const taken = new Set(["_global"]);
	for (const name of names) {
		let base = moduleName(name);
		for (let n = 2; taken.has(base); n++) base = `${moduleName(name)}-${n}`;
		taken.add(base);
		out.set(name, `${ROUTES_DIR}/${base}.ts`);
	}
	return out;
}

function plural(word: string): string {
	if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
	if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
	return `${word}s`;
}

/** What one route part serves, in a few words, for comments. */
function describePart(p: RoutePlan, route: TsgRoute): string {
	const each = route.paginate?.itemName ?? "item";
	if (p.part === "items") return `a page for each ${each}`;
	if (p.part === "listing") return `listing pages of ${route.paginate?.pageSize} ${plural(each)}${route.paginate?.firstPage ? ", after the first" : ""}`;
	if (p.part === "firstPage") return "the first listing page";
	return p.output === "html" ? "one page" : "one file";
}

// runtime/filters.ts VARIABLE: the names a route path fills in
const PATH_VARIABLE = /:([a-zA-Z][a-zA-Z0-9.]*)|\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;

/** The names a route path fills in from an item, in order, once each. */
function pathNames(pattern: string): string[] {
	return [...new Set([...pattern.matchAll(PATH_VARIABLE)].map((m) => (m[1] ?? m[2]) as string))];
}

/**
 * The route module for one tsg.yml route: `page(api, path)` for a plain route, `itemPage(api, path)` and
 * `listingPage(api, path)` for a paginated one. Each returns the template's context, or null for a URL
 * takeshape-ssg wrote no page for.
 */
export function emitRouteModule(name: string, route: TsgRoute, parts: RoutePlan[], file: string, loaders: Loaders, report: Report, dataFiles?: DataFiles): EmittedFile {
	const imports = new Imports(file, loaders, dataFiles);
	const helpers = new Set<string>(["pageContext"]);
	const routeContext = topContextCode(route.context, imports, loaders, report, `routes.${name}.context`, "\t");
	const header = [`// Route "${name}" in tsg.yml.`];
	const width = Math.max(...parts.map((p) => p.tsgPath.length));
	for (const p of parts) header.push(`//   ${p.tsgPath.padEnd(width)}  ${p.template}, ${describePart(p, route)} (${p.file})`);
	header.push("// Each function returns the context its template renders with, or null for a URL with no page.");

	const body: string[] = [];
	const queryTypes = new Set<string>(["EmDashApi"]);
	const queryHelpers = new Set<string>();
	const paginate = route.paginate;
	const items = parts.some((p) => p.part !== "page");
	let plan: QueryPlan | undefined;
	if (items && paginate?.data) {
		const data = paginate.data;
		const dataFile = typeof data === "string" ? data : data.query;
		const variables = typeof data === "string" ? {} : (data.variables ?? {});
		plan = loaders.get(templateKey(dataFile)) as QueryPlan;
		const alias = plan.paginatedAlias as string;
		const access = IDENTIFIER.test(alias) ? `.${alias}` : `[${JSON.stringify(alias)}]`;
		queryTypes.add("Pick");
		body.push(
			`/**`,
			` * Every ${paginate.itemName ?? "item"} that ${dataFile} lists in ${alias}, in its order: takeshape-ssg paged through all of them.`,
			` * With a page's pick, the ones that page shows.`,
			` */`,
			"async function items(api: EmDashApi, pick?: Pick) {",
			`\tconst data = await ${imports.loader(templateKey(dataFile))}(api, ${literal(variables)}, { paginate: true, pick });`,
			`\treturn data${access}.items;`,
			"}",
			"",
		);
	}
	const itemPart = parts.find((p) => p.part === "items");
	if (itemPart) {
		helpers.add("findPage").add("itemPages").add("itemContext");
		const alias = paginate?.itemName ? `, ${JSON.stringify(paginate.itemName)}` : "";
		const pattern = JSON.stringify(itemPart.tsgPath);
		// The page's own item and its neighbors are read in full, found by the values its path reads
		const values = plan ? pathValues(plan, pathNames(itemPart.tsgPath), "entry") : null;
		if (values) {
			helpers.add("itemPick");
			for (const h of values.helpers) queryHelpers.add(h);
		}
		const pick = values ? `, itemPick(${pattern}, path, ${JSON.stringify(values.columns)}, ${values.code})` : "";
		helpers.add("loading");
		body.push(
			`/** The page at a ${itemPart.tsgPath} URL. */`,
			"export async function itemPage(api: EmDashApi, path: string) {",
			"\tconst global = loading(globalContext(api));",
			`\tconst page = findPage(itemPages(await items(api${pick}), ${pattern}), path);`,
			"\tif (!page) return null;",
			`\treturn pageContext(await global, ${routeContext}, itemContext(page${alias}), env, locale, page.path);`,
			"}",
			"",
		);
	}
	// listingPage serves both listing parts, so the first page keeps its module when the others are left out
	if (parts.some((p) => p.part === "listing" || p.part === "firstPage") && paginate?.path) {
		helpers.add("listingPick").add("listingContext").add("loading");
		const first = paginate.firstPage ? `, ${JSON.stringify(paginate.firstPage)}` : "";
		const urls = paginate.firstPage ? `${paginate.firstPage} or a ${paginate.path} URL` : `a ${paginate.path} URL`;
		body.push(
			`/** The listing page at ${urls}. Only its own items are read in full. */`,
			"export async function listingPage(api: EmDashApi, path: string) {",
			"\tconst global = loading(globalContext(api));",
			`\tconst pick = listingPick(${literal(paginate.pageSize)}, ${JSON.stringify(paginate.path)}, path${first});`,
			"\tconst page = pick.page(await items(api, pick));",
			"\tif (!page) return null;",
			`\treturn pageContext(await global, ${routeContext}, listingContext(page), env, locale, page.path);`,
			"}",
			"",
		);
	}
	const plain = parts.find((p) => p.part === "page");
	if (plain) {
		helpers.add("isPageUrl");
		body.push(
			`/** The page at ${plain.tsgPath}. */`,
			"export async function page(api: EmDashApi, path: string) {",
			`\tif (!isPageUrl(${JSON.stringify(plain.tsgPath)}, path)) return null;`,
			// The global context and the route's own load together
			...(routeContext === "{}"
				? [`\treturn pageContext(await globalContext(api), {}, {}, env, locale, ${JSON.stringify(plain.tsgPath)});`]
				: [
						`\tconst [global, route] = await Promise.all([globalContext(api), (async () => ${routeContext})()]);`,
						`\treturn pageContext(global, route, {}, env, locale, ${JSON.stringify(plain.tsgPath)});`,
					]),
			"}",
			"",
		);
	}
	const runtime = (f: string) => importPath(file, `${RUNTIME_DIR}/${f}`);
	const lines = [
		...header,
		`import { ${[...helpers].sort().join(", ")} } from "${runtime("context.ts")}";`,
		...(queryHelpers.size ? [`import { ${[...queryHelpers].sort().join(", ")} } from "${runtime("query.ts")}";`] : []),
		`import type { ${[...queryTypes].sort().join(", ")} } from "${runtime("query.ts")}";`,
		`import { env, locale } from "${runtime("site.ts")}";`,
		...imports.lines(),
		`import { globalContext } from "${importPath(file, GLOBAL_MODULE)}";`,
		"",
		...body,
	];
	return { path: file, source: lines.join("\n") };
}

const pascalName = (template: Template): string => {
	const base = posix.basename(template.name).replace(/\.[^.]+$/, "");
	const name = camelCase(base).replace(/^[a-z]/, (c) => c.toUpperCase());
	return /^[A-Za-z]/.test(name) ? name : `T${name}`;
};

const functionName = (p: RoutePlan): string => (p.part === "page" ? "page" : p.part === "items" ? "itemPage" : "listingPage");

/**
 * The page or endpoint for one page file. It asks each candidate route part, in order, for the context of the
 * requested URL, and renders the first one found with that part's template; `answer` (runtime/context.ts) also
 * gives the redirect to a page's folder URL, and null for a 404.
 */
export function emitPage(page: PageFile, routes: Readonly<Record<string, TsgRoute>>, modules: ReadonlyMap<string, string>, templates: ReadonlyMap<string, Template>): EmittedFile {
	const { file, owner, candidates } = page;
	const route = routes[owner.name] as TsgRoute;
	const found = owner.part === "page" ? "loads its data" : owner.part === "items" ? `finds the ${route.paginate?.itemName ?? "item"} for the URL` : "finds the page for the URL";
	const module = modules.get(owner.name) as string;
	const ownerTemplate = templates.get(owner.template) as Template;
	const source = owner.part === "page" && ownerTemplate.kind === "raw" ? `Its template has no Nunjucks in it, so it needs no data.` : `${module} ${found}.`;
	const lines = [`// ${owner.tsgPath} (route "${owner.name}" in tsg.yml): ${describePart(owner, route)}. ${source}`];
	const others = candidates.filter((c) => c.file !== file);
	if (others.length) {
		const list = [...new Set(others.map((c) => `${c.tsgPath} (route "${c.name}")`))].join(", ");
		lines.push(`// A URL here can also belong to ${list}, so this file tries them in tsg.yml order, as takeshape-ssg did.`);
	}

	// A plain route whose template has no Nunjucks in it is the same on every request: it needs no data, so it
	// answers without EmDash, and a database error cannot break it
	const fixed = (c: RoutePlan): boolean => c.part === "page" && (templates.get(c.template) as Template).kind === "raw";
	const loading = candidates.filter((c) => !fixed(c));

	// Imports: route functions by module, renamed only when two modules give the same name
	const fnCount = new Map<string, Set<string>>();
	for (const c of loading) fnCount.set(functionName(c), (fnCount.get(functionName(c)) ?? new Set()).add(c.name));
	const local = (c: RoutePlan): string => {
		const fn = functionName(c);
		return (fnCount.get(fn) as Set<string>).size > 1 && c.name !== owner.name ? camelCase(`${c.name} ${fn}`) : fn;
	};
	const byModule = new Map<string, Set<string>>();
	for (const c of loading) {
		const m = modules.get(c.name) as string;
		const fn = functionName(c);
		byModule.set(m, (byModule.get(m) ?? new Set()).add(local(c) === fn ? fn : `${fn} as ${local(c)}`));
	}
	const html = owner.output === "html";
	const helpers = ["answer", ...(loading.length < candidates.length ? ["isPageUrl"] : [])];
	const imports = [
		...(html ? [] : ['import type { APIContext } from "astro";']),
		`import { ${helpers.join(", ")} } from "${importPath(file, `${RUNTIME_DIR}/context.ts`)}";`,
		...(loading.length ? [`import { emdashApi } from "${importPath(file, `${RUNTIME_DIR}/emdash-api.ts`)}";`] : []),
	];
	for (const [m, names] of byModule) imports.push(`import { ${[...names].sort().join(", ")} } from "${importPath(file, m)}";`);
	// Templates: components for pages, render functions for endpoints. Their names stay clear of every name the
	// page declares or reads, so no import is shadowed.
	const templateNames = new Map<string, string>();
	const taken = new Set<string>([
		...["Astro", "Fragment", "Template", "found", "context", "url", "redirect", "rewrite", "GET", "Response", "APIContext"],
		...helpers,
		"emdashApi",
		...loading.map(local),
	]);
	for (const c of candidates) {
		if (templateNames.has(c.template)) continue;
		const t = templates.get(c.template) as Template;
		const base = html ? pascalName(t) : isRawFile(t) ? "text" : "render";
		let name = base;
		for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
		taken.add(name);
		templateNames.set(c.template, name);
		const spec = importPath(file, outPath(t));
		if (html) imports.push(`import ${name} from "${spec}";`);
		else if (isRawFile(t)) imports.push(`import ${name} from "${spec}?raw";`);
		else imports.push(name === "render" ? `import { render } from "${spec}";` : `import { render as ${name} } from "${spec}";`);
	}
	const entry = (c: RoutePlan): string => {
		const t = templates.get(c.template) as Template;
		const name = templateNames.get(c.template) as string;
		const template = !html && isRawFile(t) ? `() => ${name}` : name;
		const find = fixed(c) ? `async (path) => (isPageUrl(${JSON.stringify(c.tsgPath)}, path) ? {} : null)` : `(path) => ${local(c)}(emdashApi, path)`;
		return `{ find: ${find}, template: ${template} }`;
	};
	const list = candidates.length === 1 ? `[${entry(candidates[0] as RoutePlan)}]` : `[\n${candidates.map((c) => `\t${entry(c)},`).join("\n")}\n]`;
	if (html) {
		lines.push(...imports, "", `const found = await answer(Astro.url, ${list});`);
		lines.push('if (!found) return Astro.rewrite("/404");', 'if ("redirect" in found) return Astro.redirect(found.redirect, 301);', "const { template: Template, context } = found;");
		return { path: file, source: ["---", ...lines, "---", "<Template {...context} />", ""].join("\n") };
	}
	lines.push(...imports, "", "export async function GET({ url, redirect, rewrite }: APIContext) {");
	// A template with no Nunjucks in it is plain text, which ignores the context
	const raw = candidates.some((c) => isRawFile(templates.get(c.template) as Template));
	const typed = raw ? "<(context: Record<string, unknown>) => string>" : "";
	lines.push(`\tconst found = await answer${typed}(url, ${list.replace(/\n/g, "\n\t")});`);
	lines.push('\tif (!found) return rewrite("/404");', '\tif ("redirect" in found) return redirect(found.redirect, 301);');
	lines.push(`\treturn new Response(found.template(found.context), { headers: { "Content-Type": ${JSON.stringify(owner.contentType)} } });`, "}", "");
	return { path: file, source: lines.join("\n") };
}

/** The moment locale file a tsg.yml locale needs, as moment's chooseLocale would pick it, or null for English. */
export function momentLocaleFile(locale: string, available: (name: string) => boolean): string | null {
	const parts = locale.toLowerCase().replace(/_/g, "-").split("-");
	for (let n = parts.length; n > 0; n--) {
		const name = parts.slice(0, n).join("-");
		if (name === "en") return null;
		if (available(name)) return `moment/locale/${name}.js`;
	}
	return null;
}

/** src/lib/takeshape/site.ts: the tsg.yml settings the filters and the page contexts read. */
export function emitSiteModule(config: TsgConfig, momentLocale: string | null): EmittedFile {
	const routes: Array<[string, string]> = [];
	for (const [name, route] of Object.entries(config.routes ?? {}) as Array<[string, TsgRoute]>) {
		const value: Record<string, unknown> = {};
		if (route.path !== undefined) value.path = route.path;
		if (route.paginate?.path !== undefined) value.paginate = { path: route.paginate.path };
		routes.push([name, literal(value)]);
	}
	const compression = config.htmlCompression as { enabled?: unknown; options?: Record<string, unknown> } | undefined;
	const lines = [
		"// The settings from tsg.yml that the TakeShape filters (filters.ts) and the page contexts (context.ts) read.",
		"// Every route module imports this file, so configure() runs before any template renders.",
		'import { configure } from "./filters.ts";',
		...(momentLocale ? [`// moment formats dates in ${config.locale} with this locale file.`, `import "${momentLocale}";`] : []),
		"",
		"/** tsg.yml `locale`. Templates see it as `locale`, and the date filter formats with it. */",
		`export const locale = ${JSON.stringify(config.locale)};`,
		"/**",
		" * takeshape-ssg passed the build's environment variables to templates as `env` and `environmentVariables`.",
		" * Pages pass an empty object; tsg2astro-report.md lists any template that reads them.",
		" */",
		"export const env: Record<string, string | undefined> = {};",
		"/** tsg.yml `htmlCompression`: minimize's options, which src/middleware.ts runs over each page, or null when it is off. */",
		`export const htmlCompression: Record<string, unknown> | null = ${compression?.enabled ? literal({ loose: true, ...(compression.options ?? {}) }) : "null"};`,
		"",
		"configure({",
		`\troutes: ${objectCode(routes, "\t")},`,
		`\tpathPrefix: ${JSON.stringify(config.pathPrefix ?? "")},`,
		`\timageDefaults: ${literal(config.imageDefaults ?? {})},`,
		`\tdates: ${literal({ tz: config.dates?.tz, format: config.dates?.format })},`,
		"\tlocale,",
		`\tmediaPath: ${JSON.stringify(MEDIA_PATH)},`,
		"});",
		"",
	];
	return { path: SITE_MODULE, source: lines.join("\n") };
}
