/**
 * Reads a takeshape-ssg site's tsg.yml. A port of the config handling in takeshape-ssg
 * (defaults, lodash merge of defaults, file and environment, then ${...} interpolation).
 */
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { load } from "./load.mts";

export type TsgPaginate = {
	data?: string | { query: string; variables?: Record<string, unknown> };
	property?: string;
	pageSize?: number;
	path?: string;
	template?: string;
	firstPage?: string;
	itemName?: string;
};
export type TsgRoute = { path?: string; template?: string; context?: unknown; paginate?: TsgPaginate };
export type TsgConfig = {
	templatePath: string;
	staticPath: string;
	buildPath: string;
	context: Record<string, unknown>;
	routes: Record<string, TsgRoute>;
	locale: string;
	dates: { tz: string; format: string };
	numbers: { format: string; config?: unknown };
	locales?: Record<string, unknown>;
	pathPrefix: string;
	imageBaseUrl: string;
	assetBaseUrl: string;
	imageDefaults: Record<string, unknown>;
	htmlCompression?: unknown;
	gzip: boolean;
	env: Record<string, string | undefined>;
};

type Mod = { default?: unknown };

const DEFAULTS = {
	env: {},
	context: {},
	routes: {},
	imageBaseUrl: "https://images.takeshape.io",
	assetBaseUrl: "https://assets.takeshape.io",
	imageDefaults: { auto: "compress,format" },
	locale: "en-us",
	pathPrefix: "",
	templatePath: "templates",
	buildPath: "build",
	staticPath: "static",
	dates: { tz: "America/New_York", format: "LLL" },
	numbers: { format: "," },
	gzip: false,
};

/** Path of the tsg.yml for a site folder or for the file itself. */
export async function tsgConfigPath(siteDirOrFile: string): Promise<string> {
	const s = await stat(siteDirOrFile).catch(() => null);
	if (!s) throw new Error(`${siteDirOrFile} does not exist.`);
	return s.isDirectory() ? join(siteDirOrFile, "tsg.yml") : siteDirOrFile;
}

export async function loadTsgConfig(siteDir: string, env: Record<string, string | undefined> = process.env): Promise<TsgConfig> {
	const file = await tsgConfigPath(siteDir);
	const yaml = ((await load<Mod>("js-yaml")).default ?? {}) as { safeLoad: (s: string) => unknown };
	const merge = ((await load<Mod>("lodash/merge.js", "lodash")).default ?? {}) as (...a: unknown[]) => Record<string, unknown>;
	const { jVar } = await load<{ jVar: (o: Record<string, unknown>, opts: Record<string, unknown>) => Record<string, unknown> }>("json-variables");
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		throw new Error(`No ${basename(file)} found at ${file}.`);
	}
	const fromFile = yaml.safeLoad(text) ?? {};
	if (typeof fromFile !== "object" || Array.isArray(fromFile)) throw new Error(`${file} must hold a YAML mapping.`);
	const combined = merge({}, DEFAULTS, fromFile, { env });
	try {
		return jVar(combined, { heads: "${", tails: "}" }) as unknown as TsgConfig;
	} catch (e) {
		throw new Error(`Could not fill in the \${...} values in ${file}: ${e instanceof Error ? e.message : String(e)}`);
	}
}
