// Builds the golden output for a test site with the real takeshape-ssg CLI.
// Usage: node test/tsg/build-golden.mts <site name> [--site-dir <path>] [--offline]
// --site-dir  a local-only site (not vendored). Outputs go to test/.cache/goldens/<name>/, never to
//             test/tsg/sites/. Credentials come from TS_PROJECT_ID and TS_API_KEY, or from the site's
//             .takeshaperc, which is read here and passed to the CLI as env. It is never copied.
// --offline   ignores .takeshaperc, passes placeholder credentials and an unroutable endpoint, and
//             fails unless the cache holds every response the build asks for.
// A live run starts with an empty .cache, saves the fresh cache, then rebuilds offline; golden/ is
// the offline output.
// Env: TAKESHAPE_CLI (path to the CLI's dist/index.cjs), TS_PROJECT_ID and TS_API_KEY.
// The CLI refuses to build without a project id and API key, even when every response is cached.
// With both unset and a cache/ in place, this script passes placeholders, so the cached build
// runs offline. The placeholders only work if cache/ holds every response the build asks for.
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const offline = args.includes("--offline");
const siteDirFlag = args.indexOf("--site-dir");
const localSite = siteDirFlag >= 0 ? args[siteDirFlag + 1] : undefined;
if (siteDirFlag >= 0 && !localSite) {
	console.error("--site-dir needs a path.");
	process.exit(2);
}
const name = args.find((a, i) => !a.startsWith("--") && !(siteDirFlag >= 0 && i === siteDirFlag + 1));
if (!name) {
	console.error("Usage: node test/tsg/build-golden.mts <site name> [--site-dir <path>] [--offline]");
	process.exit(2);
}

if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") {
	console.error(`Invalid site name: ${name}`);
	process.exit(2);
}

// Where the site is read from, and where golden/, cache/ and golden.json live.
const siteSource = localSite ? resolve(localSite) : join(here, "sites", name, "site");
const siteDir = localSite ? join(here, "..", ".cache", "goldens", name) : join(here, "sites", name);
if (!existsSync(siteSource)) {
	console.error(`No site at ${siteSource}`);
	process.exit(2);
}

const cli = process.env.TAKESHAPE_CLI ?? "";
if (!cli || !existsSync(cli)) {
	console.error(
		"Set TAKESHAPE_CLI to the TakeShape CLI's dist/index.cjs. The shape-books golden was built with takeshape-ssg 12.21.1; npm's @takeshape/cli stops at 12.17.3.",
	);
	process.exit(2);
}

const goldenJsonPath = join(siteDir, "golden.json");
const previous = existsSync(goldenJsonPath) ? JSON.parse(readFileSync(goldenJsonPath, "utf8")) : {};
const now: string = previous.now ?? "2026-10-15T16:00:00.000Z";

const hasCache = existsSync(join(siteDir, "cache")) && readdirSync(join(siteDir, "cache")).length > 0;
const realProject = offline ? undefined : process.env.TS_PROJECT_ID;
const realKey = offline ? undefined : process.env.TS_API_KEY;
if (Boolean(realProject) !== Boolean(realKey)) {
	console.error("Set both TS_PROJECT_ID and TS_API_KEY, or neither.");
	process.exit(2);
}
// A local site without env credentials may use its own .takeshaperc. Its values go to the CLI as env
// (the CLI lets env win over the rc), so the file is never copied and the key is never printed.
const rcFile = localSite && !offline && !(realProject && realKey) ? join(siteSource, ".takeshaperc") : undefined;
const rcEnv: Record<string, string> = {};
if (rcFile && existsSync(rcFile)) {
	let rc: { projectId?: unknown; linkedApiKey?: { apiKey?: unknown }; [key: string]: unknown };
	try {
		rc = JSON.parse(readFileSync(rcFile, "utf8"));
	} catch {
		// JSON.parse's message quotes the file, which holds the API key, so it is never printed
		console.error(`${rcFile} is not valid JSON. Fix it, or set TS_PROJECT_ID and TS_API_KEY instead.`);
		process.exit(2);
	}
	const pairs: [string, unknown][] = [
		["TS_PROJECT_ID", rc.projectId],
		["TS_API_KEY", rc.linkedApiKey?.apiKey],
		["TS_API_ENDPOINT", rc.endpoint],
		["TS_APP_URL", rc.appUrl],
		["TS_SITE_ID", rc.siteId],
		["TS_SITE_NAME", rc.siteName],
		["TS_PROJECT_NAME", rc.projectName],
	];
	for (const [k, v] of pairs) if (typeof v === "string" && v) rcEnv[k] = v;
}
const hasRc = Boolean(rcEnv.TS_PROJECT_ID && rcEnv.TS_API_KEY);
const hasCredentials = Boolean(realProject && realKey) || hasRc;
if (!hasCredentials && !hasCache) {
	console.error(
		offline
			? `${join(siteDir, "cache")} is missing or empty, so an offline build cannot run. Build live first.`
			: `${join(siteDir, "cache")} is missing or empty, so the build needs the API. Set TS_PROJECT_ID and TS_API_KEY.`,
	);
	process.exit(2);
}
// Offline builds never reach the network: placeholder credentials and an unroutable endpoint. The cache key
// is object-hash of the GraphQL params only (read from the CLI's source), so neither value causes misses.
const placeholderEnv = {
	TS_PROJECT_ID: "offline-placeholder",
	TS_API_KEY: "offline-placeholder",
	TS_API_ENDPOINT: "http://127.0.0.1:9",
};
const credentialEnv: NodeJS.ProcessEnv = hasCredentials ? { ...rcEnv, ...process.env } : placeholderEnv;

const work = join(here, "..", ".out", `golden-${name}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(siteDir, { recursive: true });
const skipEverywhere = new Set(["node_modules", ".git", ".idea", ".DS_Store", ".takeshaperc"]);
const isEnvFile = (p: string) => p === ".env" || p.startsWith(".env.");
const skipTopLevel = new Set(["build", ".cache", "dist"]);
cpSync(siteSource, work, {
	recursive: true,
	filter: (src) => {
		const rel = src.slice(siteSource.length).replace(/^\//, "");
		if (!rel) return true;
		const parts = rel.split("/");
		return !parts.some((p) => skipEverywhere.has(p) || isEnvFile(p)) && !skipTopLevel.has(parts[0]);
	},
});
// A live run starts with an empty .cache so it refreshes and prunes cache/. Only offline builds read it.
if (!hasCredentials && existsSync(join(siteDir, "cache"))) cpSync(join(siteDir, "cache"), join(work, ".cache"), { recursive: true });

// Runs `takeshape build -c` in the work dir. The CLI exits 0 even when the build fails,
// so the output is the check.
function runBuild(env: NodeJS.ProcessEnv): boolean {
	const result: SpawnSyncReturns<string> = spawnSync(
		process.execPath,
		["--import", join(here, "fixed-clock.mts"), cli, "build", "-c"],
		{ cwd: work, env: { ...process.env, ...env, TSG_FIXED_NOW: now }, encoding: "utf8" },
	);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	process.stdout.write(output);
	return result.status === 0 && !/Error/.test(output);
}

if (!runBuild(credentialEnv)) {
	console.error("The takeshape build reported an error. The golden was not updated.");
	if (offline) {
		console.error("The offline build failed, so cache/ is incomplete: a request missed the cache. Build live to refill it.");
	} else if (!hasCredentials) {
		console.error(`Built offline with placeholder credentials. If cache/ lacks a response the build needs, set real TS_PROJECT_ID and TS_API_KEY.`);
	}
	process.exit(1);
}

if (hasCredentials) {
	// A live build's output order follows the order GraphQL responses arrived. Save the fresh cache,
	// then rebuild offline from it: the offline output is the golden, and it is repeatable.
	if (existsSync(join(work, ".cache"))) {
		rmSync(join(siteDir, "cache"), { recursive: true, force: true });
		cpSync(join(work, ".cache"), join(siteDir, "cache"), { recursive: true });
	}
	rmSync(join(work, "build"), { recursive: true, force: true });
	console.log("Rebuilding offline from the fresh cache.");
	if (!runBuild(placeholderEnv)) {
		console.error("The offline rebuild failed, so the cache is incomplete. The golden was not updated.");
		process.exit(1);
	}
}

const build = join(work, "build");
if (!existsSync(build)) {
	console.error(`The build wrote no ${build}.`);
	process.exit(1);
}

// Route outputs only: leave out the files that came from the site's static folder.
const tsgYml = readFileSync(join(siteSource, "tsg.yml"), "utf8");
const staticPath = (/^staticPath:\s*(\S+)/m.exec(tsgYml)?.[1] ?? "static").replace(/^\.?\/|\/$/g, "");
const listFiles = (dir: string, prefix = ""): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? listFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
	);
const staticFiles = new Set(existsSync(join(siteSource, staticPath)) ? listFiles(join(siteSource, staticPath)) : []);
const pages = listFiles(build).filter((f) => !staticFiles.has(f)).length;

rmSync(join(siteDir, "golden"), { recursive: true, force: true });
cpSync(build, join(siteDir, "golden"), { recursive: true });
writeFileSync(goldenJsonPath, `${JSON.stringify({ cli: "12.21.1", now, pages }, null, 2)}\n`);
console.log(`Golden for ${name}: ${pages} files, clock ${now}`);
