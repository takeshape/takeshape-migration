/**
 * The Astro project around the translated site, and the rules for the folder it goes in.
 *
 * The project starts from EmDash's starter-cloudflare template (github.com/emdash-cms/templates, commit 1930243)
 * with a second config for Node: tsg2astro/scaffold/ holds its files, and EmDash's agent skills from
 * github.com/emdash-cms/skills at commit 17db933 (the sync for emdash 1.3.0). package.json is written here.
 *
 * Folder rules: tsg2astro writes into an empty folder, or into one it wrote before (it has `.tsg2astro.json`).
 * The marker lists the paths tsg2astro owns. A rerun deletes those and writes them again, and never touches
 * anything else, in particular the content and builds: data.db, uploads/, .wrangler/, takeshape/, node_modules/
 * and dist*.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = ".tsg2astro.json";
export const REPORT_FILE = "tsg2astro-report.md";
/** Folders tsg2astro writes in full. */
export const OWNED_DIRS = ["public", "src/lib/takeshape", "src/loaders", "src/pages", "src/routes", "src/templates"];
/** EmDash's skills are linked here for Claude Code, as the starter does. */
export const CLAUDE_SKILLS_LINK = { path: ".claude/skills", target: "../.agents/skills" };

const here = dirname(fileURLToPath(import.meta.url));
export const SCAFFOLD_DIR = join(here, "scaffold");
/** Our own skills, copied into each project when they exist. */
const OWN_SKILLS_DIR = join(here, "..", "skills");
const OWN_SKILLS = ["resolve-takeshape-site-report"];

/** The pinned packages of a generated project. @emdash-cms/cloudflare must equal emdash. */
export const DEPENDENCIES: Record<string, string> = {
	"@astrojs/cloudflare": "14.4.0",
	"@astrojs/node": "11.1.8",
	"@astrojs/react": "6.0.6",
	"@emdash-cms/cloudflare": "1.3.1",
	astro: "7.4.0",
	emdash: "1.3.1",
	// What src/lib/takeshape imports, at the versions TakeShape ran
	// HTML entities in block text a layout puts in an attribute (nunjucks.ts unescapeHtml), the version parse5 7.3.0 uses
	entities: "6.0.1",
	"github-slugger": "1.5.0",
	// tsg.yml's htmlCompression (html-compression.ts), as takeshape-ssg 12.21.1 pinned it
	minimize: "2.2.0",
	moment: "2.30.1",
	"moment-timezone": "0.5.32",
	prismjs: "1.29.0",
	react: "19.2.4",
	"react-dom": "19.2.4",
	// The image endpoint on Node (src/lib/takeshape/image-sharp.ts), the version astro 7.4.0 installs
	sharp: "0.35.5",
	slugg: "1.2.1",
};
export const DEV_DEPENDENCIES: Record<string, string> = {
	"@astrojs/check": "0.9.10",
	// The oldest release wrangler 4.151.0 accepts (its peer range is ^5.20261006.1)
	"@cloudflare/workers-types": "5.20261006.1",
	typescript: "6.0.3",
	wrangler: "4.151.0",
};

/** A file of the project. `from` says what it was written for, for errors. */
export type OutFile = { path: string; data: string | Buffer; from?: string };

/** A path tsg2astro must never delete or write in an output folder. */
export function neverTouched(rel: string): boolean {
	const top = rel.split("/")[0] ?? "";
	return ["data.db", "uploads", ".wrangler", "takeshape", "node_modules"].includes(top) || top.startsWith("dist") || /^data\.db-/.test(top);
}

/** Entries an output folder may hold before tsg2astro first writes it: the content and builds it never touches. */
const ALLOWED_BEFORE = (name: string) => neverTouched(name) || name === ".DS_Store";

/** The site's name for Cloudflare: the site folder's name, lowercase letters, digits and dashes. */
export function siteName(siteDir: string): string {
	const slug = basename(siteDir)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 57)
		.replace(/-+$/, "");
	return slug || "emdash-site";
}

export function packageJson(name: string): string {
	const pkg = {
		name,
		version: "0.0.0",
		private: true,
		type: "module",
		scripts: {
			dev: "astro dev",
			build: "astro build",
			preview: "astro preview",
			deploy: "astro build && wrangler deploy",
			"dev:node": "astro dev --config astro.node.config.mjs",
			"build:node": "astro build --config astro.node.config.mjs --outDir dist-node",
			// Astro's Node server reads no .env of its own, and a secret kept there for Node mode must reach getSecret
			"start:node": "node --env-file-if-exists=.env dist-node/server/entry.mjs",
			"takeshape:seed": "emdash seed takeshape/takeshape.seed.json --on-conflict update",
			typecheck: "wrangler types && astro check",
		},
		engines: { node: ">=22.22" },
		dependencies: DEPENDENCIES,
		devDependencies: DEV_DEPENDENCIES,
	};
	return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Every file under a folder, as sorted relative posix paths. */
function filesUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			if (lstatSync(p).isDirectory()) walk(p);
			else if (name !== ".DS_Store") out.push(relative(dir, p).split(sep).join("/"));
		}
	};
	walk(dir);
	return out;
}

/** The project files that do not come from the site, and the paths they make tsg2astro own. */
export function scaffoldFiles(name: string): { files: OutFile[]; owns: string[] } {
	const files: OutFile[] = [];
	const owns = new Set<string>([CLAUDE_SKILLS_LINK.path]);
	const own = (rel: string) => {
		const skill = /^\.agents\/skills\/[^/]+/.exec(rel);
		if (skill) owns.add(skill[0]);
		else if (!OWNED_DIRS.some((d) => rel.startsWith(`${d}/`))) owns.add(rel);
	};
	for (const rel of filesUnder(SCAFFOLD_DIR)) {
		let data: string | Buffer = readFileSync(join(SCAFFOLD_DIR, rel));
		if (rel === "wrangler.jsonc") data = data.toString("utf8").replaceAll("__NAME__", name);
		files.push({ path: rel, data, from: "the scaffold" });
		own(rel);
	}
	files.push({ path: "package.json", data: packageJson(name), from: "the scaffold" });
	own("package.json");
	for (const skill of OWN_SKILLS) {
		const dir = join(OWN_SKILLS_DIR, skill);
		if (!existsSync(dir)) continue;
		for (const rel of filesUnder(dir)) {
			const path = posix.join(".agents/skills", skill, rel);
			files.push({ path, data: readFileSync(join(dir, rel)), from: `the ${skill} skill` });
			own(path);
		}
	}
	return { files, owns: [...owns] };
}

/**
 * Checks every file before anything is written: its path, normalized, stays inside the output folder, sits in a
 * path tsg2astro owns (`OWNED_DIRS`, the scaffold's `scaffoldOwns`, the report), and is not written twice. A file
 * that fails is tsg2astro's own bug, so this throws, naming what each file was written for.
 */
export function checkOutputs(files: OutFile[], scaffoldOwns: string[]): void {
	const written = new Map<string, string>();
	for (const f of files) {
		const path = posix.normalize(f.path);
		if (path === ".." || path.startsWith("../") || posix.isAbsolute(path) || path.includes("\\")) throw new Error(`Internal error: tsg2astro would write ${f.path}, outside the output folder`);
		if (neverTouched(path) || path === MARKER || path === ".env") throw new Error(`Internal error: tsg2astro would write ${path}`);
		if (!OWNED_DIRS.some((d) => path.startsWith(`${d}/`)) && !scaffoldOwns.some((o) => path === o || path.startsWith(`${o}/`)) && path !== REPORT_FILE) {
			throw new Error(`Internal error: ${path} is not in a path tsg2astro owns`);
		}
		const from = f.from ?? "an unnamed source";
		const earlier = written.get(path);
		if (earlier !== undefined) throw new Error(`Internal error: ${path} is written twice, for ${earlier} and for ${from}`);
		written.set(path, from);
	}
}

/** A path from a marker that tsg2astro may delete: relative, inside the folder, and not content or a build. */
function ownable(rel: unknown): rel is string {
	if (typeof rel !== "string" || !rel || rel.startsWith("/") || rel.includes("\\")) return false;
	const parts = rel.split("/");
	if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
	return !neverTouched(rel) && rel !== MARKER && rel !== ".env";
}

/**
 * Checks that tsg2astro may write into `out`, and returns the paths an earlier run owns. Throws when the folder
 * holds anything else without a marker, or when the marker is unreadable or names a path tsg2astro never owns.
 */
export function earlierOwns(out: string): string[] {
	if (!existsSync(out)) return [];
	if (!lstatSync(out).isDirectory()) throw new Error(`${out} is a file. Pass --out a folder.`);
	const markerPath = join(out, MARKER);
	if (!existsSync(markerPath)) {
		const foreign = readdirSync(out).filter((n) => !ALLOWED_BEFORE(n));
		if (foreign.length) {
			throw new Error(
				`${out} already holds files tsg2astro did not write (${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ", ..." : ""}). Pass --out an empty or new folder.`,
			);
		}
		return [];
	}
	let marker: unknown;
	try {
		marker = JSON.parse(readFileSync(markerPath, "utf8"));
	} catch {
		throw new Error(`${markerPath} is not valid JSON. Delete the folder or pass --out a new one.`);
	}
	const owns = (marker as { owns?: unknown })?.owns;
	if (!Array.isArray(owns)) throw new Error(`${markerPath} has no "owns" list. Delete the folder or pass --out a new one.`);
	const bad = owns.find((p) => !ownable(p));
	if (bad !== undefined) throw new Error(`${markerPath} lists ${JSON.stringify(bad)}, which tsg2astro never writes. Delete the folder or pass --out a new one.`);
	return owns as string[];
}

export function markerJson(owns: Iterable<string>): string {
	return `${JSON.stringify({ version: 1, owns: [...new Set(owns)].sort() }, null, 2)}\n`;
}

/** `.env` with EMDASH_SITE_URL set to `siteUrl`, keeping every other line. */
export function withSiteUrl(existing: string | null, siteUrl: string): string {
	const line = `EMDASH_SITE_URL=${siteUrl}`;
	const lines = (existing ?? "").split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	let set = false;
	const out: string[] = [];
	for (const l of lines) {
		if (/^\s*(export\s+)?EMDASH_SITE_URL\s*=/.test(l)) {
			if (!set) out.push(line);
			set = true;
		} else out.push(l);
	}
	if (!set) out.push(line);
	return `${out.join("\n")}\n`;
}

/**
 * Writes the project: deletes what an earlier run owned and what this run owns, writes the marker, then the
 * files, the skills link and `.env`. The marker goes first, so a run that stops partway leaves a folder the
 * next run accepts and replaces. `write` is a parameter so tests can stop a run partway.
 */
export function writeProject(
	out: string,
	project: { remove: Iterable<string>; owns: Iterable<string>; files: OutFile[]; siteUrl: string | null },
	write: (file: string, data: string | Buffer) => void = writeFileSync,
): void {
	const owns = [...project.owns];
	for (const rel of new Set([...project.remove, ...owns])) rmSync(join(out, rel), { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, MARKER), markerJson(owns));
	for (const f of project.files) {
		const target = join(out, f.path);
		mkdirSync(dirname(target), { recursive: true });
		write(target, f.data);
	}
	if (owns.includes(CLAUDE_SKILLS_LINK.path)) {
		const link = join(out, CLAUDE_SKILLS_LINK.path);
		mkdirSync(dirname(link), { recursive: true });
		try {
			symlinkSync(CLAUDE_SKILLS_LINK.target, link, "dir");
		} catch {
			// No symlinks (Windows without developer mode): a copy works the same for agents
			cpSync(join(out, ".agents", "skills"), link, { recursive: true });
		}
	}
	if (project.siteUrl) {
		const envFile = join(out, ".env");
		writeFileSync(envFile, withSiteUrl(existsSync(envFile) ? readFileSync(envFile, "utf8") : null, project.siteUrl));
	}
}
