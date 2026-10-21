/**
 * tsg2astro end to end on the books starter: ts2emdash --site writes the seed and the field map into the output
 * folder's takeshape/, then tsg2astro writes the Astro project around it. The generated route modules then run
 * against a stub EmDash API filled from the seed. The e2e script (npm run test:tsg-e2e) installs and builds the
 * project; npm test doesn't.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EmDashApi, Entry } from "../../tsg2astro/runtime/query.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const site = join(root, "test", "tsg", "sites", "shape-books", "site");
const exportDir = join(root, "test", "fixtures", "shape-books");
const expectedFiles = join(root, "test", "tsg", "expected", "shape-books-files.txt");
// Inside the repo, so the generated runtime finds its packages in emdash/node_modules
const work = join(root, "test", ".out", `tsg-cli-${process.pid}`);
const out = join(work, "emdash-site");
const fieldMap = join(out, "takeshape", "takeshape-field-map.json");
after(() => rmSync(work, { recursive: true, force: true }));

function run(script: string, args: string[]) {
	return spawnSync(process.execPath, ["--no-warnings", script, ...args], { cwd: root, encoding: "utf8" });
}

function tsg2astro(target: string, extra: string[] = [], siteDir = site) {
	return run("tsg2astro/tsg2astro.mts", [siteDir, "--export", exportDir, "--field-map", fieldMap, "--out", target, ...extra]);
}

/** Every file and link under a folder, as sorted relative paths, leaving out `skip` folders. */
function files(dir: string, skip: string[] = []): string[] {
	const found: string[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const rel = relative(dir, p).split("\\").join("/");
			if (skip.includes(rel)) continue;
			const s = lstatSync(p);
			if (s.isDirectory()) walk(p);
			else found.push(rel);
		}
	};
	walk(dir);
	return found.sort();
}

function snapshot(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const f of files(dir, ["takeshape"])) {
		const p = join(dir, f);
		out.set(f, lstatSync(p).isSymbolicLink() ? `link:${readlinkSync(p)}` : createHash("sha256").update(readFileSync(p)).digest("hex"));
	}
	return out;
}

before(() => {
	mkdirSync(work, { recursive: true });
	const seed = run("ts2emdash.mts", [exportDir, "--site", site, "--out", join(out, "takeshape", "takeshape.seed.json"), "--report", join(out, "takeshape", "content-report.md")]);
	assert.equal(seed.status, 0, seed.stderr);
	const res = tsg2astro(out, ["--site-url", "http://localhost:4510"]);
	assert.equal(res.status, 0, `tsg2astro exited ${res.status}:\n${res.stdout}\n${res.stderr}`);
});

test("file-tree", () => {
	const want = readFileSync(expectedFiles, "utf8").split("\n").filter(Boolean);
	assert.deepEqual(files(out, ["takeshape"]), want);
});

test("the project's .gitignore keeps the content and secrets out of git, and the field map and reports in", () => {
	// A repository holding only the generated .gitignore, with no global or system git config, so no other ignore rule plays a part
	const repo = join(work, "gitignore-check");
	mkdirSync(repo, { recursive: true });
	cpSync(join(out, ".gitignore"), join(repo, ".gitignore"));
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	const init = spawnSync("git", ["init", "-q"], { cwd: repo, env, encoding: "utf8" });
	assert.equal(init.status, 0, init.stderr);
	const ignored = (path: string) => spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: repo, env }).status === 0;
	const left = ["takeshape/takeshape.seed.json", "takeshape/takeshape-media.db", "data.db", "data.db-wal", "uploads/ts-1.png", ".env", ".wrangler/state/d1/x", "node_modules/emdash/package.json", "dist/index.html", "dist-node/server/entry.mjs"];
	const kept = ["takeshape/takeshape-field-map.json", "takeshape/content-report.md", "tsg2astro-report.md", "src/pages/index.astro", "public/robots.txt", "frontend/package.json", ".github/workflows/deploy.yml"];
	assert.deepEqual(left.filter((p) => !ignored(p)), [], "ignored");
	assert.deepEqual(kept.filter(ignored), [], "kept");
});

test("the Node server reads .env, so a secret kept there reaches the site", () => {
	const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as { scripts: Record<string, string>; engines: { node: string } };
	// --env-file-if-exists is in Node 22.9 and up, stable from 22.21; the project needs 22.22
	assert.equal(pkg.scripts["start:node"], "node --env-file-if-exists=.env dist-node/server/entry.mjs");
	assert.equal(pkg.engines.node, ">=22.22");
});

test("report-clean", () => {
	const report = readFileSync(join(out, "tsg2astro-report.md"), "utf8");
	assert.ok(!/## Not translated/.test(report), report);
	assert.ok(!report.includes("\u2014"), "no em dashes");
	const rows = report.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Route") && !l.startsWith("| ---"));
	const parts: Array<[string, string]> = [
		["/sitemap.xml", "src/pages/sitemap.xml.ts"],
		["/", "src/pages/index.astro"],
		["/blog/:title/", "src/pages/blog/[title].astro"],
		["/blog/page-:num/", "src/pages/blog/page-[num].astro"],
		["/blog/", "src/pages/blog/index.astro"],
		["/books/:title/", "src/pages/books/[title].astro"],
		["/authors/:name/", "src/pages/authors/[name].astro"],
	];
	assert.equal(rows.length, parts.length, rows.join("\n"));
	parts.forEach(([url, file], i) => {
		assert.ok(rows[i]!.includes(`| ${url} |`), `row ${i + 1} serves ${url}: ${rows[i]}`);
		assert.ok(rows[i]!.includes(file), `row ${i + 1} names ${file}: ${rows[i]}`);
	});
});

test("deterministic", () => {
	const first = snapshot(out);
	const res = tsg2astro(out, ["--site-url", "http://localhost:4510"]);
	assert.equal(res.status, 0, res.stderr);
	assert.deepEqual(snapshot(out), first);
});

test("refuses-foreign-folder", () => {
	const foreign = join(work, "foreign");
	mkdirSync(foreign, { recursive: true });
	writeFileSync(join(foreign, "notes.txt"), "mine");
	const res = tsg2astro(foreign);
	assert.equal(res.status, 1, res.stdout);
	assert.match(res.stderr, /tsg2astro/);
	assert.deepEqual(files(foreign), ["notes.txt"]);
	assert.equal(readFileSync(join(foreign, "notes.txt"), "utf8"), "mine");
});

test("refuses an --out inside the site folder", () => {
	const copy = join(work, "site-out-inside");
	cpSync(site, copy, { recursive: true });
	const before = files(copy);
	const res = tsg2astro(join(copy, "emdash-site"), [], copy);
	assert.equal(res.status, 1, res.stdout);
	assert.match(res.stderr, /--out .*emdash-site is inside the site folder/);
	assert.deepEqual(files(copy), before);
	// The default --out is emdash-site in the working folder, so a run from inside the site is refused too
	const fromSite = spawnSync(process.execPath, ["--no-warnings", join(root, "tsg2astro", "tsg2astro.mts"), ".", "--export", exportDir, "--field-map", fieldMap], { cwd: copy, encoding: "utf8" });
	assert.equal(fromSite.status, 1, fromSite.stdout);
	assert.match(fromSite.stderr, /inside the site folder/);
	assert.deepEqual(files(copy), before);
});

test("keeps-data", () => {
	const keep: Record<string, string> = {
		"data.db": "db",
		"uploads/x": "upload",
		"node_modules/x": "module",
		".wrangler/state/x": "state",
		"dist/x": "dist",
		"dist-node/x": "dist-node",
		"src/components/Mine.astro": "mine",
		".agents/skills/mine/SKILL.md": "my skill",
	};
	for (const [f, text] of Object.entries(keep)) {
		mkdirSync(dirname(join(out, f)), { recursive: true });
		writeFileSync(join(out, f), text);
	}
	// Leftovers in folders tsg2astro owns go away on a rerun
	writeFileSync(join(out, "src", "pages", "stale.astro"), "stale");
	writeFileSync(join(out, "src", "routes", "old.ts"), "old");
	writeFileSync(join(out, ".env"), "SECRET=1\nEMDASH_SITE_URL=http://old.example\n");
	const takeshape = files(join(out, "takeshape"));

	const res = tsg2astro(out, ["--site-url", "http://localhost:4510"]);
	assert.equal(res.status, 0, res.stderr);
	for (const [f, text] of Object.entries(keep)) assert.equal(readFileSync(join(out, f), "utf8"), text, f);
	assert.deepEqual(files(join(out, "takeshape")), takeshape);
	assert.ok(!existsSync(join(out, "src", "pages", "stale.astro")));
	assert.ok(!existsSync(join(out, "src", "routes", "old.ts")));
	assert.equal(readFileSync(join(out, ".env"), "utf8"), "SECRET=1\nEMDASH_SITE_URL=http://localhost:4510\n");
});

test("static files and build scripts: route files win, TakeShape hosts are listed", () => {
	const copy = join(work, "site-copy");
	cpSync(site, copy, { recursive: true });
	writeFileSync(join(copy, "static", "sitemap.xml"), "<urlset/>");
	writeFileSync(join(copy, "static", "javascripts", "api.js"), 'const a = 1;\nfetch("https://api.takeshape.io/project/abc/v3/graphql");\n');
	writeFileSync(join(copy, "package.json"), JSON.stringify({ scripts: { build: "webpack", pull: "curl https://api.takeshape.io/project/abc" } }));
	const target = join(work, "static-out");
	const res = tsg2astro(target, [], copy);
	assert.equal(res.status, 0, res.stderr);
	assert.ok(!existsSync(join(target, "public", "sitemap.xml")));
	assert.ok(existsSync(join(target, "public", "javascripts", "api.js")));
	const report = readFileSync(join(target, "tsg2astro-report.md"), "utf8");
	assert.match(report, /Route "sitemap" also writes this file\. Its page is served.*\(static\/sitemap\.xml\)/);
	assert.match(report, /`https:\/\/api\.takeshape\.io\/project\/abc\/v3\/graphql` Points at TakeShape\. \(static\/javascripts\/api\.js:2\)/);
	assert.match(report, /`scripts\.pull` Runs against https:\/\/api\.takeshape\.io\/project\/abc/);
	assert.match(report, /own scripts \(build, pull\)\. A tsg2astro rerun replaces public\/ with a fresh copy of static\//);
	// No --site-url: the report says to set it
	assert.match(report, /`EMDASH_SITE_URL` Set it to the site's public URL/);
	assert.ok(!existsSync(join(target, ".env")));
});

// A site's main.js can bundle a library with base64 runs of 20,000 letters and more. A host pattern that can start a
// match anywhere inside a run rescans it from every letter, which took 18 minutes on one such site.
test("the TakeShape host scan stays fast on long runs of letters", () => {
	const copy = join(work, "site-long-run");
	cpSync(site, copy, { recursive: true });
	const run = "QUJD".repeat(40_000);
	writeFileSync(join(copy, "static", "javascripts", "bundle.js"), `var a="${run}",b="https://images.takeshape.io/p/dev/x.jpg",c="notakeshape.io";\n`);
	const target = join(work, "long-run-out");
	const res = spawnSync(process.execPath, ["--no-warnings", "tsg2astro/tsg2astro.mts", copy, "--export", exportDir, "--field-map", fieldMap, "--out", target], {
		cwd: root,
		encoding: "utf8",
		timeout: 20_000,
	});
	assert.equal(res.signal, null, "tsg2astro took more than 20 s");
	assert.equal(res.status, 0, res.stderr);
	const report = readFileSync(join(target, "tsg2astro-report.md"), "utf8");
	assert.match(report, /`https:\/\/images\.takeshape\.io\/p\/dev\/x\.jpg` Points at TakeShape\. \(static\/javascripts\/bundle\.js:1\)/);
	assert.doesNotMatch(report, /`takeshape\.io` Points at TakeShape\. \(static\/javascripts\/bundle\.js/);
});

test("image parameters the image endpoint ignores are reported, from tsg.yml and the templates", () => {
	const copy = join(work, "site-images");
	cpSync(site, copy, { recursive: true });
	writeFileSync(join(copy, "tsg.yml"), `imageDefaults:\n  fit: facearea\n  w: 800\n${readFileSync(join(copy, "tsg.yml"), "utf8")}`);
	const book = join(copy, "src", "templates", "pages", "book.html");
	writeFileSync(book, readFileSync(book, "utf8").replace("book.coverImage.path | image }}", "book.coverImage.path | image({w: 400, h: 300, fit: 'crop', sepia: 50}) }}"));
	const target = join(work, "images-out");
	const res = tsg2astro(target, [], copy);
	assert.equal(res.status, 0, res.stderr);
	const report = readFileSync(join(target, "tsg2astro-report.md"), "utf8");
	const section = report.slice(report.indexOf("## Image parameters"));
	assert.match(section, /^- `imageDefaults\.fit` tsg\.yml sets "fit" for every image: the image endpoint ignores "facearea" and resizes as fit "clip" does\. \(tsg\.yml\)$/m);
	assert.match(section, /^- `sepia` The image filter passes "sepia": the image endpoint ignores it\. \(pages\/book\.html:7\)$/m);
	// Parameters the endpoint honors, takeshape-ssg's own auto=compress,format among them, stay out
	assert.ok(!report.includes("imageDefaults.auto"), report);
	assert.ok(!report.includes("`imageDefaults.w`"), report);
	assert.ok(!/^- `fit` /m.test(section), section);
	// The starter itself passes none
	assert.ok(!readFileSync(join(out, "tsg2astro-report.md"), "utf8").includes("## Image parameters"));
});

/** A copy of the books starter with one more route, and its template. */
function siteWithRoute(name: string, route: string, template: string, source: string): string {
	const copy = join(work, `site-${name}`);
	cpSync(site, copy, { recursive: true });
	writeFileSync(join(copy, "tsg.yml"), `${readFileSync(join(copy, "tsg.yml"), "utf8").trimEnd()}\n\n  ${name}:\n${route}`);
	mkdirSync(dirname(join(copy, "src", "templates", template)), { recursive: true });
	writeFileSync(join(copy, "src", "templates", template), source);
	return copy;
}

test("a tsg.yml value from the environment is reported with how to keep a secret out of src/", () => {
	const copy = join(work, "site-env");
	cpSync(site, copy, { recursive: true });
	const yml = readFileSync(join(copy, "tsg.yml"), "utf8");
	writeFileSync(join(copy, "tsg.yml"), yml.replace("  site: data/site.graphql\n", "  site: data/site.graphql\n  searchKey: ${env.TSG2ASTRO_TEST_KEY}\n"));
	process.env.TSG2ASTRO_TEST_KEY = "placeholder-value";
	try {
		const target = join(work, "env-out");
		const res = tsg2astro(target, [], copy);
		assert.equal(res.status, 0, res.stderr);
		const report = readFileSync(join(target, "tsg2astro-report.md"), "utf8");
		const section = report.slice(report.indexOf("## Environment variables"));
		assert.match(section, /^Values the site takes from the environment\. Each line says when the value is read and how to change it\.$/m);
		assert.match(section, /^- `env\.TSG2ASTRO_TEST_KEY` tsg\.yml reads this when it loads\..*npx wrangler secret put TSG2ASTRO_TEST_KEY.*getSecret from astro:env\/server\. \(tsg\.yml\)$/m);
		assert.ok(!section.includes("Set them before you build"), section);
	} finally {
		delete process.env.TSG2ASTRO_TEST_KEY;
	}
});

test("a route at /404 keeps its page, which then answers unknown URLs", () => {
	const copy = siteWithRoute("notFound", "    path: /404\n    template: pages/not-found.html\n", "pages/not-found.html", "<h1>Lost at {{ currentPath }}</h1>\n");
	const target = join(work, "route-404");
	const res = tsg2astro(target, [], copy);
	assert.equal(res.status, 0, res.stderr);
	// The route's page, not the generic one
	const page = readFileSync(join(target, "src", "pages", "404.astro"), "utf8");
	assert.match(page, /route "notFound" in tsg\.yml/);
	assert.ok(!page.includes("Page not found"), page);
	const report = readFileSync(join(target, "tsg2astro-report.md"), "utf8");
	assert.match(report, /^\| notFound \| \/404 \| src\/pages\/404\.astro, /m);
	assert.match(report, /^- `notFound` Route "notFound" serves \/404, .*every URL the site has no page for.*status 404\..*\(src\/pages\/404\.astro\)$/m);
	// The one compare difference this route may leave: compare-sites lists old 200, new 404 as missing and skips the
	// page's content, so it's kept only with status 404 and after a check by hand
	assert.match(report, /^- `notFound` .* If the old site answered \/404 with status 200, the compare lists it as `missing` \("Old answers 200, new answers 404"\) and doesn't compare the two pages\. This route may leave that one difference when the move is done, as long as the status is 404 and you've checked by hand that the page matches the old one: compare `curl -s <old site>\/404` with `curl -s <new site>\/404`\. Any other status at \/404 means the page fails, so fix it like any other `missing` page\. \(src\/pages\/404\.astro\)$/m);
});

test("a route at /404.html leaves unknown URLs on the generic page, and the report says how to change that", () => {
	const copy = siteWithRoute("notFound", "    path: /404.html\n    template: pages/not-found.html\n", "pages/not-found.html", "<h1>Lost at {{ currentPath }}</h1>\n");
	const target = join(work, "route-404-html");
	const res = tsg2astro(target, [], copy);
	assert.equal(res.status, 0, res.stderr);
	assert.match(readFileSync(join(target, "src", "pages", "404.astro"), "utf8"), /Page not found/);
	assert.match(readFileSync(join(target, "src", "pages", "404.html.astro"), "utf8"), /route "notFound" in tsg\.yml/);
	const report = readFileSync(join(target, "tsg2astro-report.md"), "utf8");
	assert.match(report, /^- `notFound` Route "notFound" writes \/404\.html\..*src\/pages\/404\.astro.*page\(emdashApi, "\/404\.html"\).*src\/routes\/notFound\.ts.*\(src\/pages\/404\.html\.astro\)$/m);
});

test("routes at /500 and /3xx, paths Astro keeps for itself, are reported with what Astro does there", () => {
	const copy = siteWithRoute("serverError", "    path: /500/\n    template: pages/server-error.html\n", "pages/server-error.html", "<h1>Something broke</h1>\n");
	writeFileSync(join(copy, "tsg.yml"), `${readFileSync(join(copy, "tsg.yml"), "utf8").trimEnd()}\n\n  moved:\n    path: /3xx\n    template: pages/server-error.html\n`);
	const target = join(work, "route-500");
	const res = tsg2astro(target, [], copy);
	assert.equal(res.status, 0, res.stderr);
	assert.ok(existsSync(join(target, "src", "pages", "500", "index.astro")));
	assert.ok(existsSync(join(target, "src", "pages", "3xx.astro")));
	const report = readFileSync(join(target, "tsg2astro-report.md"), "utf8");
	assert.match(report, /^- `serverError` Route "serverError" serves \/500\/, where Astro keeps its server-error page\..*status 500.*every page that fails.*\(src\/pages\/500\/index\.astro\)$/m);
	// compare-sites lists old 200, new 500 as missing, not status; kept only with status 500 and after a check by hand
	assert.match(report, /^- `serverError` .* If the old site answered \/500\/ with status 200, the compare lists it as `missing` \("Old answers 200, new answers 500"\) and doesn't compare the two pages\. This route may leave that one difference when the move is done, as long as the status is 500 and you've checked by hand that the page matches the old one: compare `curl -s <old site>\/500\/` with `curl -s <new site>\/500\/`\. Any other status at \/500\/ means the page fails, so fix it like any other `missing` page\. \(src\/pages\/500\/index\.astro\)$/m);
	assert.match(report, /^- `moved` Route "moved" serves \/3xx, where Astro keeps its redirect page\..*experimental\.redirectPage.*\(src\/pages\/3xx\.astro\)$/m);
	// The books starter has neither
	assert.ok(!readFileSync(join(out, "tsg2astro-report.md"), "utf8").includes("where Astro keeps"));
});

test("templates and queries named with .. stay inside --out, and ones outside the site are refused", () => {
	const parent = join(work, "dotdot");
	const copy = join(parent, "site");
	cpSync(site, copy, { recursive: true });
	writeFileSync(join(parent, "outside.html"), "<p>not the site's</p>");
	writeFileSync(join(parent, "far.graphql"), "query { getBookList { total } }");
	writeFileSync(join(copy, "static", "icon.svg"), "<svg/>");
	mkdirSync(join(copy, "queries"));
	writeFileSync(join(copy, "queries", "extra.graphql"), "query { getBookList { total } }");
	// templatePath is src/templates, so ../../ is the site folder and ../../../ its parent
	const footer = join(copy, "src", "templates", "partials", "footer.html");
	writeFileSync(footer, `${readFileSync(footer, "utf8")}{% include "../../static/icon.svg" %}\n{% include "../../../outside.html" %}\n`);
	const lines = readFileSync(footer, "utf8").split("\n");
	const yml = readFileSync(join(copy, "tsg.yml"), "utf8");
	writeFileSync(join(copy, "tsg.yml"), yml.replace("  site: data/site.graphql\n", "  site: data/site.graphql\n  extra: ../../queries/extra.graphql\n  far: ../../../far.graphql\n"));
	const target = join(parent, "out");
	const res = tsg2astro(target, [], copy);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(readFileSync(join(target, "src", "templates", "_site", "static", "icon.svg"), "utf8"), "<svg/>");
	assert.match(readFileSync(join(target, "src", "templates", "partials", "footer.astro"), "utf8"), /from "\.\.\/_site\/static\/icon\.svg\?raw"/);
	assert.ok(existsSync(join(target, "src", "loaders", "_site", "queries", "extra.ts")));
	assert.match(readFileSync(join(target, "src", "routes", "_global.ts"), "utf8"), /from "\.\.\/loaders\/_site\/queries\/extra\.ts"/);
	const report = readFileSync(join(target, "tsg2astro-report.md"), "utf8");
	assert.match(report, new RegExp(`^\\| partials/footer\\.html \\| ${lines.length - 1} \\| \`\\.\\./\\.\\./\\.\\./outside\\.html\` \\| .*outside the site folder`, "m"));
	assert.match(report, /^\| tsg\.yml \|  \| `context\.far` \| The query file \.\.\/\.\.\/\.\.\/far\.graphql is outside the site folder/m);
	// Nothing next to the site and the output but what the test put there
	assert.deepEqual(readdirSync(parent).sort(), ["far.graphql", "out", "outside.html", "site"]);
	assert.ok(!files(target).some((f) => /outside|far\./.test(f)), files(target).join("\n"));
});

test("two site files that would become one output file are reported, and neither is written", () => {
	const copy = join(work, "site-same-output");
	cpSync(site, copy, { recursive: true });
	const templates = join(copy, "src", "templates");
	// partials/extra.html and partials/extra.njk both become partials/extra.astro
	writeFileSync(join(templates, "partials", "extra.html"), '<p>{{ "html" }}</p>\n');
	writeFileSync(join(templates, "partials", "extra.njk"), '<p>{{ "njk" }}</p>\n');
	// A file under the templates folder's _site/ and the site file it mirrors both become _site/static/mark.svg
	mkdirSync(join(templates, "_site", "static"), { recursive: true });
	writeFileSync(join(templates, "_site", "static", "mark.svg"), "<svg id=\"templates\"/>");
	writeFileSync(join(copy, "static", "mark.svg"), "<svg id=\"static\"/>");
	const footer = join(templates, "partials", "footer.html");
	const before = readFileSync(footer, "utf8").split("\n").length - 1;
	writeFileSync(
		footer,
		`${readFileSync(footer, "utf8")}{% include "partials/extra.html" %}\n{% include "partials/extra.njk" %}\n{% include "_site/static/mark.svg" %}\n{% include "../../static/mark.svg" %}\n`,
	);
	// data/extra.graphql and data/extra.gql (a .gql query is named with query:) both become src/loaders/data/extra.ts
	writeFileSync(join(templates, "data", "extra.graphql"), "query { getBookList { total } }\n");
	writeFileSync(join(templates, "data", "extra.gql"), "query { getPostList { total } }\n");
	const yml = readFileSync(join(copy, "tsg.yml"), "utf8");
	writeFileSync(join(copy, "tsg.yml"), yml.replace("  site: data/site.graphql\n", "  site: data/site.graphql\n  extraA: data/extra.graphql\n  extraB:\n    query: data/extra.gql\n"));

	const target = join(work, "same-output");
	const res = tsg2astro(target, [], copy);
	assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
	assert.ok(!existsSync(join(target, "src", "templates", "partials", "extra.astro")));
	assert.ok(!existsSync(join(target, "src", "templates", "_site", "static", "mark.svg")));
	assert.ok(!existsSync(join(target, "src", "loaders", "data", "extra.ts")));
	const generatedFooter = readFileSync(join(target, "src", "templates", "partials", "footer.astro"), "utf8");
	assert.ok(!/extra|mark\.svg/.test(generatedFooter), generatedFooter);
	assert.ok(!/extra\.ts/.test(readFileSync(join(target, "src", "routes", "_global.ts"), "utf8")));

	const report = readFileSync(join(target, "tsg2astro-report.md"), "utf8");
	const row = (line: number, construct: string, names: string, path: string) =>
		new RegExp(`^\\| partials/footer\\.html \\| ${line} \\| \`${construct.replace(/[./]/g, "\\$&")}\` \\| ${names.replace(/[./]/g, "\\$&")} both become ${path.replace(/[./]/g, "\\$&")}, so neither is written`, "m");
	assert.match(report, row(before + 1, "partials/extra.html", '"partials/extra.html" and "partials/extra.njk"', "src/templates/partials/extra.astro"));
	assert.match(report, row(before + 2, "partials/extra.njk", '"partials/extra.html" and "partials/extra.njk"', "src/templates/partials/extra.astro"));
	assert.match(report, row(before + 3, "_site/static/mark.svg", '"../../static/mark.svg" and "_site/static/mark.svg"', "src/templates/_site/static/mark.svg"));
	assert.match(report, row(before + 4, "../../static/mark.svg", '"../../static/mark.svg" and "_site/static/mark.svg"', "src/templates/_site/static/mark.svg"));
	for (const use of ["context.extraA", "context.extraB"]) {
		assert.match(report, new RegExp(`^\\| tsg\\.yml \\|  \\| \`${use.replace(".", "\\.")}\` \\| The query files data/extra\\.gql and data/extra\\.graphql both become src/loaders/data/extra\\.ts, so neither has a loader`, "m"));
	}
});

test("a route whose template shares its output file is reported by its name and URL", () => {
	const copy = join(work, "site-shared-route");
	cpSync(site, copy, { recursive: true });
	// pages/extra.html and pages/extra.htm both become src/templates/pages/extra.astro
	writeFileSync(join(copy, "src", "templates", "pages", "extra.html"), "<p>html</p>\n");
	writeFileSync(join(copy, "src", "templates", "pages", "extra.htm"), "<p>htm</p>\n");
	const routes = "  extraA:\n    path: /extra-a/\n    template: pages/extra.html\n  extraB:\n    path: /extra-b/\n    template: pages/extra.htm\n";
	writeFileSync(join(copy, "tsg.yml"), `${readFileSync(join(copy, "tsg.yml"), "utf8").trimEnd()}\n\n${routes}`);

	const target = join(work, "shared-route");
	const res = tsg2astro(target, [], copy);
	assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
	assert.ok(!existsSync(join(target, "src", "templates", "pages", "extra.astro")));
	assert.ok(!existsSync(join(target, "src", "pages", "extra-a")));
	assert.ok(!existsSync(join(target, "src", "pages", "extra-b")));

	const report = readFileSync(join(target, "tsg2astro-report.md"), "utf8");
	const both = '"pages/extra.htm" and "pages/extra.html" both become src/templates/pages/extra.astro, so neither is written';
	const esc = (s: string) => s.replace(/[./]/g, "\\$&");
	for (const [route, url, template] of [["extraA", "/extra-a/", "pages/extra.html"], ["extraB", "/extra-b/", "pages/extra.htm"]]) {
		const row = `| tsg.yml |  | \`routes.${route}.template\` | Route "${route}" serves ${url} with "${template}", but ${both} and ${url} has no pages.`;
		assert.match(report, new RegExp(`^${esc(row).replace(/\|/g, "\\|")}`, "m"));
	}
	// One item per route, none that names the template alone
	assert.ok(!/^\| tsg\.yml \|  \| `pages\/extra\.html?` \|/m.test(report), report);
});

test("three files that would become one output file are named without the words for two", () => {
	const copy = join(work, "site-three-outputs");
	cpSync(site, copy, { recursive: true });
	const templates = join(copy, "src", "templates");
	// pages/extra.html, pages/extra.htm and pages/extra.njk all become src/templates/pages/extra.astro
	// (with Nunjucks in it, so the .njk isn't copied as a raw file)
	for (const ext of ["html", "htm", "njk"]) writeFileSync(join(templates, "pages", `extra.${ext}`), `<p>{{ "${ext}" }}</p>\n`);
	const footer = join(templates, "partials", "footer.html");
	const line = readFileSync(footer, "utf8").split("\n").length;
	writeFileSync(footer, `${readFileSync(footer, "utf8")}{% include "pages/extra.njk" %}\n`);
	// The templates folder's _site/static/extra.graphql and .gql, and the site's static/extra.graphql, all become
	// src/loaders/_site/static/extra.ts
	mkdirSync(join(templates, "_site", "static"), { recursive: true });
	writeFileSync(join(templates, "_site", "static", "extra.graphql"), "query { getBookList { total } }\n");
	writeFileSync(join(templates, "_site", "static", "extra.gql"), "query { getPostList { total } }\n");
	writeFileSync(join(copy, "static", "extra.graphql"), "query { getAuthorList { total } }\n");
	const queries = "  extraA: _site/static/extra.graphql\n  extraB:\n    query: _site/static/extra.gql\n  extraC: ../../static/extra.graphql\n";
	const yml = readFileSync(join(copy, "tsg.yml"), "utf8").replace("  site: data/site.graphql\n", `  site: data/site.graphql\n${queries}`);
	const routes = "  extraA:\n    path: /extra-a/\n    template: pages/extra.html\n  extraB:\n    path: /extra-b/\n    template: pages/extra.htm\n";
	writeFileSync(join(copy, "tsg.yml"), `${yml.trimEnd()}\n\n${routes}`);

	const target = join(work, "three-outputs");
	const res = tsg2astro(target, [], copy);
	assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
	assert.ok(!existsSync(join(target, "src", "templates", "pages", "extra.astro")));
	assert.ok(!existsSync(join(target, "src", "loaders", "_site", "static", "extra.ts")));

	const report = readFileSync(join(target, "tsg2astro-report.md"), "utf8");
	const row = (s: string) => new RegExp(`^${s.replace(/[./|()]/g, "\\$&")}`, "m");
	const all = '"pages/extra.htm", "pages/extra.html" and "pages/extra.njk" become src/templates/pages/extra.astro, so none of them is written';
	for (const [route, url, template] of [["extraA", "/extra-a/", "pages/extra.html"], ["extraB", "/extra-b/", "pages/extra.htm"]]) {
		assert.match(report, row(`| tsg.yml |  | \`routes.${route}.template\` | Route "${route}" serves ${url} with "${template}", but ${all} and ${url} has no pages. Rename all but one of the files in a copy of the site`));
	}
	assert.match(report, row(`| partials/footer.html | ${line} | \`pages/extra.njk\` | ${all} and this line gets nothing.`));
	for (const use of ["extraA", "extraB", "extraC"]) {
		assert.match(report, row(`| tsg.yml |  | \`context.${use}\` | The query files ../../static/extra.graphql, _site/static/extra.gql and _site/static/extra.graphql become src/loaders/_site/static/extra.ts, so none of them has a loader.`));
	}
	// The words for two files stay out of every item about three
	const items = report.split("\n").filter((l) => l.includes("extra"));
	assert.ok(items.length >= 6, report);
	for (const item of items) assert.ok(!/\b(both|neither|two)\b/.test(item), item);
});

test("the final check refuses two files at one path, and paths outside the folder", async () => {
	const { checkOutputs } = await import("../../tsg2astro/scaffold.mts");
	const ok = [
		{ path: "src/pages/index.astro", data: "", from: 'route "homepage"' },
		{ path: "package.json", data: "", from: "the scaffold" },
	];
	assert.doesNotThrow(() => checkOutputs(ok, ["package.json"]));
	assert.throws(
		() => checkOutputs([...ok, { path: "src/pages/./index.astro", data: "", from: "the scaffold" }], ["package.json"]),
		/Internal error: src\/pages\/index\.astro is written twice, for route "homepage" and for the scaffold/,
	);
	assert.throws(() => checkOutputs([{ path: "src/templates/../../../x.astro", data: "" }], []), /Internal error: .*outside the output folder/);
	assert.throws(() => checkOutputs([{ path: "src/x/y.ts", data: "" }], []), /Internal error: src\/x\/y\.ts is not in a path tsg2astro owns/);
});

test("a run that stops partway leaves a folder the next run takes", async () => {
	const { writeProject } = await import("../../tsg2astro/scaffold.mts");
	const target = join(work, "partial");
	cpSync(join(out, "takeshape"), join(target, "takeshape"), { recursive: true });
	let written = 0;
	const failing = (file: string, data: string | Buffer) => {
		if (++written === 2) throw new Error("disk full");
		writeFileSync(file, data);
	};
	const files = [
		{ path: "src/pages/a.astro", data: "a" },
		{ path: "src/pages/b.astro", data: "b" },
	];
	assert.throws(() => writeProject(target, { remove: [], owns: ["src/pages", "tsg2astro-report.md"], files, siteUrl: null }, failing), /disk full/);
	// The marker went first, so the folder is tsg2astro's and a rerun replaces what it holds
	assert.ok(existsSync(join(target, ".tsg2astro.json")));
	assert.ok(existsSync(join(target, "src", "pages", "a.astro")));
	const res = tsg2astro(target);
	assert.equal(res.status, 0, res.stderr);
	assert.ok(!existsSync(join(target, "src", "pages", "a.astro")));
	assert.ok(existsSync(join(target, "src", "pages", "blog", "[title].astro")));
});

// ---------------------------------------------------------------------------
// The generated route modules, against a stub API filled from the seed
// ---------------------------------------------------------------------------

type SeedEntry = { id: string; slug?: string; status?: string; data: Record<string, unknown>; taxonomies?: Record<string, string[]> };
type SeedField = { slug: string; type: string; validation?: { targetCollection?: string } };
type Seed = {
	collections: Array<{ slug: string; fields: SeedField[] }>;
	content: Record<string, SeedEntry[]>;
	taxonomies: Array<{ name: string; terms: Array<{ slug: string; label: string }> }>;
};

/**
 * EmDash after `emdash seed`, as the pages read it. EmDash 1.3 makes every reference field of the seed a
 * relation: the field is not in `data`, and getEmDashReferences answers it with the published entries it
 * points at, in stored order.
 */
function seedApi(seed: Seed): EmDashApi {
	const refs = (v: unknown): unknown => (typeof v === "string" && v.startsWith("$ref:") ? v.slice(5) : Array.isArray(v) ? v.map(refs) : v);
	const targets = new Map(seed.collections.flatMap((c) => c.fields.filter((f) => f.type === "reference").map((f) => [`${c.slug}.${f.slug}`, f.validation?.targetCollection] as const)));
	const raw: Record<string, Entry[]> = {};
	for (const [name, list] of Object.entries(seed.content)) {
		raw[name] = list.map((e) => ({
			id: e.slug ?? e.id,
			data: { ...Object.fromEntries(Object.entries(e.data).map(([k, v]) => [k, refs(v)])), id: e.id, slug: e.slug ?? null, status: e.status ?? "published" },
		}));
	}
	// With `select`, only those fields and the system ones, as rows.ts reads them
	const stored = (collection: string, e: Entry, select?: unknown): Entry => {
		const keep = Array.isArray(select) ? new Set(["id", "slug", "status", ...(select as string[])]) : null;
		return { id: e.id, data: Object.fromEntries(Object.entries(e.data).filter(([k]) => !targets.has(`${collection}.${k}`) && (!keep || keep.has(k)))) };
	};
	const labels = new Map(seed.taxonomies.flatMap((t) => t.terms.map((term) => [`${t.name}:${term.slug}`, term.label] as const)));
	return {
		async collection(type, filter) {
			let entries = (raw[type] ?? []).filter((e) => e.data.status === (filter.status ?? "published"));
			for (const [key, want] of Object.entries((filter.where ?? {}) as Record<string, unknown>)) {
				entries = entries.filter((e) => (Array.isArray(want) ? want.includes(e.data[key]) : e.data[key] === want));
			}
			if (typeof filter.limit === "number") entries = entries.slice(0, filter.limit);
			return { entries: entries.map((e) => stored(type, e, filter.select)) };
		},
		async entry(type, slugOrId) {
			const found = (raw[type] ?? []).find((e) => e.id === slugOrId || e.data.id === slugOrId);
			return found ? stored(type, found) : null;
		},
		async byIds(type, ids, select) {
			return (raw[type] ?? []).filter((e) => e.data.status === "published" && ids.includes(e.data.id as string)).map((e) => stored(type, e, select));
		},
		async terms(collection, entryIds, taxonomy) {
			const found = new Map<string, Array<{ slug: string; label: string }>>();
			for (const id of entryIds) {
				const entry = seed.content[collection]?.find((e) => e.id === id);
				found.set(id, (entry?.taxonomies?.[taxonomy] ?? []).map((slug) => ({ slug, label: labels.get(`${taxonomy}:${slug}`) ?? slug })));
			}
			return found;
		},
		async references(collection, entries, field, select) {
			const target = targets.get(`${collection}.${field}`);
			return new Map(
				entries.map((entry) => {
					const parent = (raw[collection] ?? []).find((e) => e.data.id === entry.data.id);
					if (!target || parent?.data.status !== "published") return [entry.data.id as string, []];
					const found = [parent.data[field]]
						.flat()
						.map((ref) => (raw[target] ?? []).find((e) => e.data.id === ref && e.data.status === "published"))
						.filter((e): e is Entry => e !== undefined)
						.map((e) => stored(target, e, select));
					return [entry.data.id as string, found];
				}),
			);
		},
		async referrers(collection, field, list, select) {
			const target = targets.get(`${collection}.${field}`);
			return new Map(
				list.map((t) => {
					const live = target ? (raw[target] ?? []).some((e) => e.data.id === t.data.id && e.data.status === "published") : false;
					const found = (raw[collection] ?? []).filter((e) => live && e.data.status === "published" && [e.data[field]].flat().includes(t.data.id)).map((e) => stored(collection, e, select));
					return [t.data.id as string, found];
				}),
			);
		},
	};
}

test("unknown-urls-404", async () => {
	const api = seedApi(JSON.parse(readFileSync(join(out, "takeshape", "takeshape.seed.json"), "utf8")) as Seed);
	type Ctx = Record<string, any> | null;
	const posts = (await import(pathToFileURL(join(out, "src", "routes", "posts.ts")).href)) as {
		itemPage(api: EmDashApi, path: string): Promise<Ctx>;
		listingPage(api: EmDashApi, path: string): Promise<Ctx>;
	};
	const books = (await import(pathToFileURL(join(out, "src", "routes", "books.ts")).href)) as { itemPage(api: EmDashApi, path: string): Promise<Ctx> };

	// Five posts, four a page: /blog/ and /blog/page-2/, nothing past them, and no /blog/page-1/ since firstPage took it
	const first = await posts.listingPage(api, "/blog/");
	assert.equal(first?.items.length, 4);
	assert.deepEqual(first?.pagination, { currentPage: 1, totalPages: 2 });
	assert.equal(first?.currentPath, "/blog/");
	assert.equal(first?.site.settings.siteTitle, "Shape Books");
	assert.equal((await posts.listingPage(api, "/blog/page-2/"))?.items.length, 1);
	assert.equal(await posts.listingPage(api, "/blog/page-3/"), null);
	assert.equal(await posts.listingPage(api, "/blog/page-1/"), null);

	const book = await books.itemPage(api, "/books/peter-pan/");
	assert.equal(book?.book.title, "Peter Pan");
	assert.equal(book?.item, book?.book);
	assert.equal(book?.currentPath, "/books/peter-pan/");
	assert.equal(await books.itemPage(api, "/books/unknown/"), null);

	const post = await posts.itemPage(api, "/blog/reinventing-peter-pan/");
	assert.equal(post?.post.title, "Reinventing Peter Pan ");
	assert.equal(await posts.itemPage(api, "/blog/unknown/"), null);

	// What the pages answer: a URL without its slash redirects only when a page is there
	const { answer } = (await import(pathToFileURL(join(out, "src", "lib", "takeshape", "context.ts")).href)) as typeof import("../../tsg2astro/runtime/context.ts");
	const at = (url: string, ...finds: Array<(api: EmDashApi, path: string) => Promise<Ctx>>) =>
		answer(new URL(`http://localhost${url}`), finds.map((find, i) => ({ find: (path: string) => find(api, path), template: i })));
	assert.deepEqual(await at("/books/peter-pan", books.itemPage), { redirect: "/books/peter-pan/" });
	assert.equal(await at("/books/unknown", books.itemPage), null);
	assert.equal(await at("/blog/page-3", posts.listingPage, posts.itemPage), null);
	assert.equal(await at("/blog/page-1", posts.listingPage, posts.itemPage), null);
	assert.deepEqual(await at("/blog", posts.listingPage), { redirect: "/blog/" });
	const sitemap = (await import(pathToFileURL(join(out, "src", "routes", "sitemap.ts")).href)) as { page(api: EmDashApi, path: string): Promise<Ctx> };
	assert.ok((await sitemap.page(api, "/sitemap.xml"))?.posts);
	assert.equal(await at("/sitemap.xml/", sitemap.page), null);
});

test("item and listing pages build only their own items, and find what the whole list gives", async () => {
	const api = seedApi(JSON.parse(readFileSync(join(out, "takeshape", "takeshape.seed.json"), "utf8")) as Seed);
	type Ctx = Record<string, any> | null;
	const { itemPages, listingPages } = (await import(pathToFileURL(join(out, "src", "lib", "takeshape", "context.ts")).href)) as typeof import("../../tsg2astro/runtime/context.ts");
	const source = readFileSync(join(out, "src", "routes", "posts.ts"), "utf8");
	assert.match(source, /itemPick\("\/blog\/:title\/", path, \["title"\], \(entry\) => \(\{ title: \(entry\.data\.title \?\? ""\) \}\)\)/);
	assert.match(source, /listingPick\(4, "\/blog\/page-:num\/", path, "\/blog\/"\)/);
	for (const [route, loader, list, pattern, name] of [
		["posts", "posts", "getPostList", "/blog/:title/", "post"],
		["books", "books", "getBookList", "/books/:title/", "book"],
		["authors", "authors", "page", "/authors/:name/", "author"],
	] as const) {
		const module = (await import(pathToFileURL(join(out, "src", "routes", `${route}.ts`)).href)) as { itemPage(api: EmDashApi, path: string): Promise<Ctx> };
		const { load } = (await import(pathToFileURL(join(out, "src", "loaders", "data", `${loader}.ts`)).href)) as { load(api: EmDashApi, v: object, o: object): Promise<Record<string, any>> };
		const all = itemPages((await load(api, {}, { paginate: true }))[list].items, pattern);
		assert.ok(all.length > 1, route);
		for (const page of all) {
			const ctx = await module.itemPage(api, page.path);
			assert.deepEqual([ctx?.[name], ctx?.previousItem, ctx?.nextItem, ctx?.previousPath, ctx?.nextPath], [page.item, page.previousItem, page.nextItem, page.previousPath, page.nextPath], page.path);
		}
	}
	const posts = (await import(pathToFileURL(join(out, "src", "routes", "posts.ts")).href)) as { listingPage(api: EmDashApi, path: string): Promise<Ctx> };
	const { load } = (await import(pathToFileURL(join(out, "src", "loaders", "data", "posts.ts")).href)) as { load(api: EmDashApi, v: object, o: object): Promise<Record<string, any>> };
	for (const page of listingPages((await load(api, {}, { paginate: true })).getPostList.items, 4, "/blog/page-:num/", "/blog/")) {
		const ctx = await posts.listingPage(api, page.path);
		assert.deepEqual([ctx?.items, ctx?.pagination], [page.items, { currentPage: page.currentPage, totalPages: page.totalPages }], page.path);
	}
});

test("references reach the pages", async () => {
	const api = seedApi(JSON.parse(readFileSync(join(out, "takeshape", "takeshape.seed.json"), "utf8")) as Seed);
	type Ctx = Record<string, any> | null;
	const route = async (name: string) => (await import(pathToFileURL(join(out, "src", "routes", `${name}.ts`)).href)) as Record<string, (api: EmDashApi, path: string) => Promise<Ctx>>;
	const [posts, books, authors, homepage] = await Promise.all(["posts", "books", "authors", "homepage"].map(route));

	const post = await posts!.itemPage!(api, "/blog/reinventing-peter-pan/");
	assert.deepEqual(post?.post.author, { name: "J. M. Barrie" });
	const book = await books!.itemPage!(api, "/books/treasure-island/");
	assert.deepEqual(book?.book.author, { name: "Robert Louis Stevenson" });
	// The our-books partial on every page prints each book's author from the global context
	assert.deepEqual(new Set(book?.site.books.items.map((b: any) => b.author.name)), new Set(["J. M. Barrie", "Robert Louis Stevenson", "C.S. Lewis", "Lewis Carroll"]));

	const author = await authors!.itemPage!(api, "/authors/lewis-carroll/");
	assert.equal(author?.author.authored.total, 1);
	assert.deepEqual(author?.author.authored.items.map((b: any) => b.title), ["Alice in Wonderland"]);

	const home = await homepage!.page!(api, "/");
	assert.equal(home?.page.hero.featuredPost.title, "Follow the rabbit");
	assert.deepEqual(home?.page.hero.featuredPost.author, { name: "Lewis Carroll" });
	assert.equal(home?.page.featuredBook.title, "The Lion, the Witch, and the Wardrobe");
	assert.deepEqual(home?.page.featuredBook.author, { name: "C.S. Lewis" });
});

test("a post titled like a listing page still gets its page", async () => {
	// Astro sends /blog/page-builder-tips/ to page-[num].astro, which takeshape-ssg never gave a listing page
	const seed = JSON.parse(readFileSync(join(out, "takeshape", "takeshape.seed.json"), "utf8")) as Seed;
	const first = seed.content.posts![0]!;
	seed.content.posts!.push({
		...first,
		id: "ts-page-builder-tips",
		slug: "page-builder-tips",
		data: { ...first.data, title: "Page builder tips", takeshape_id: "page-builder-tips", takeshape_created_at: "2030-01-01T00:00:00.000Z" },
	});
	const api = seedApi(seed);
	type Ctx = Record<string, any> | null;
	const posts = (await import(pathToFileURL(join(out, "src", "routes", "posts.ts")).href)) as {
		itemPage(api: EmDashApi, path: string): Promise<Ctx>;
		listingPage(api: EmDashApi, path: string): Promise<Ctx>;
	};
	const { answer } = (await import(pathToFileURL(join(out, "src", "lib", "takeshape", "context.ts")).href)) as typeof import("../../tsg2astro/runtime/context.ts");
	const page = readFileSync(join(out, "src", "pages", "blog", "page-[num].astro"), "utf8");
	const listingAt = page.indexOf("=> listingPage(emdashApi, path), template: Landing");
	const itemAt = page.indexOf("=> itemPage(emdashApi, path), template: Individual");
	assert.ok(listingAt > 0 && itemAt > listingAt, page);
	const candidates = [
		{ find: (path: string) => posts.listingPage(api, path), template: "Landing" },
		{ find: (path: string) => posts.itemPage(api, path), template: "Individual" },
	];
	const found = (await answer(new URL("http://localhost/blog/page-builder-tips/"), candidates)) as { template: string; context: Record<string, any> };
	assert.equal(found.template, "Individual");
	assert.equal(found.context.post.title, "Page builder tips");
	const listing = (await answer(new URL("http://localhost/blog/page-2/"), candidates)) as { template: string; context: Record<string, any> };
	assert.equal(listing.template, "Landing");
	assert.equal(listing.context.items.length, 2);
});
