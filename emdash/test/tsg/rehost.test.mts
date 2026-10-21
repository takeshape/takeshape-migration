/**
 * tsg2astro/rehost.mts on a small project, offline: test/fake-fetch.mts in images mode answers both TakeShape CDN
 * hosts, and its log says which URLs were fetched.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fakeFetch = pathToFileURL(join(root, "test", "fake-fetch.mts")).href;
const work = mkdtempSync(join(tmpdir(), "rehost-"));
after(() => rmSync(work, { recursive: true, force: true }));

const LOGO = "https://images.takeshape.io/p1/dev/a1/logo.png?auto=format%2Ccompress";

function project(name: string): string {
	const out = join(work, name);
	const files: Record<string, string> = {
		"src/templates/partials/head.astro": `<script type="application/ld+json">{ "logo": { "url": "${LOGO}" }, "image": "https://images.takeshape.io/p1/dev/a8/12 Harbor View cc.jpeg" }</script>\n<img srcset="https://images.takeshape.io/p1/dev/a9/s.jpg?w=300 300w, https://images.takeshape.io/p1/dev/a9/s.jpg?w=600 600w">\n`,
		"src/templates/pages/icons.astro": '<img src="https://images.takeshape.io/p1/dev/a2/icon%20one.png?w=400&amp;auto=format">\n<a href={`https://assets.takeshape.io/${nj.escape(x)}`}>dynamic</a>\n<svg><use href="https://assets.takeshape.io/p1/dev/a6/icons.svg#search"></use></svg>\n<img src="https://images.takeshape.io/p1/dev/a7/dim.jpg?con=50&amp;auto=format">\n',
		"public/assets/main.css": ".hero{background:url(https://images.takeshape.io/p1/dev/a3/bg.jpg?w=1600);background-size:cover;color:red}\n",
		"public/assets/main.js": `var api='https://api.takeshape.io/project/p1/graphql';var logo="${LOGO}";var wave="https://images.takeshape.io/p1/dev/a4/wave%20(1).jpg?w=300";var photo='https://images.takeshape.io/p1/dev/a5/Owner\\'s%20photo.jpg?w=30';var seeds="https://images.takeshape.io/p1/dev/b1/seeds%20Gardener's%20Guide.webp?auto=compress";\n`,
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(out, path)), { recursive: true });
		writeFileSync(join(out, path), text);
	}
	return out;
}

function rehost(out: string, log: string) {
	return spawnSync(process.execPath, ["--no-warnings", "--import", fakeFetch, "tsg2astro/rehost.mts", out], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, FAKE_FETCH: "images", FAKE_FETCH_LOG: log },
	});
}

test("TakeShape CDN files move onto the site, each URL to one local file", () => {
	const out = project("first");
	const log = join(work, "fetch.log");
	const res = rehost(out, log);
	assert.equal(res.status, 0, res.stderr);
	const head = readFileSync(join(out, "src/templates/partials/head.astro"), "utf8");
	const js = readFileSync(join(out, "public/assets/main.js"), "utf8");
	const icons = readFileSync(join(out, "src/templates/pages/icons.astro"), "utf8");
	const css = readFileSync(join(out, "public/assets/main.css"), "utf8");
	const logo = /"url": "(\/_takeshape-files\/[^"]+)"/.exec(head)?.[1];
	assert.ok(logo, head);
	assert.match(logo, /\/logo\.png$/);
	assert.ok(js.includes(`var logo="${logo}"`), js);
	assert.match(icons, /<img src="\/_takeshape-files\/[0-9a-f]+\/icon-one\.png">/);
	// The ) that closes an unquoted url() ends the URL, and the declarations after it stay
	assert.match(css, /background:url\(\/_takeshape-files\/[0-9a-f]+\/bg\.jpg\);background-size:cover;color:red\}/);
	// A quoted file name with raw spaces is one URL; a srcset's are several
	assert.match(head, /"image": "\/_takeshape-files\/[0-9a-f]+\/12-Harbor-View-cc\.jpeg"/);
	assert.match(head, /srcset="\/_takeshape-files\/[0-9a-f]+\/s\.jpg 300w, \/_takeshape-files\/[0-9a-f]+\/s\.jpg 600w"/);
	// A fragment stays on the local URL, so the <use> still picks its symbol
	assert.match(icons, /<use href="\/_takeshape-files\/[0-9a-f]+\/icons\.svg#search">/);
	// A filename with parentheses in it is whole; only the ) that closes a CSS url() is not part of the URL
	assert.match(js, /var wave="\/_takeshape-files\/[0-9a-f]+\/wave-1-\.jpg"/);
	// An apostrophe escaped inside a JavaScript string is part of the file name
	assert.match(js, /var photo='\/_takeshape-files\/[0-9a-f]+\/Owner-s-photo\.jpg'/);
	// A minifier's double-quoted string keeps the apostrophe raw, and it is part of the file name too
	assert.match(js, /var seeds="\/_takeshape-files\/[0-9a-f]+\/seeds-Gardener-s-Guide\.webp"/);
	// Left alone: the API, which needs an endpoint of its own, and a URL the template builds
	assert.ok(js.includes("'https://api.takeshape.io/project/p1/graphql'"));
	assert.ok(icons.includes("`https://assets.takeshape.io/${nj.escape(x)}`"));
	// Each file is in public/ and in the cache that survives a tsg2astro rerun
	for (const local of [logo, ...[...icons.matchAll(/\/_takeshape-files\/[^"#]+/g)].map((m) => m[0])]) {
		assert.ok(existsSync(join(out, "public", local)), local);
		assert.ok(existsSync(join(out, "takeshape", "files", local.replace(/^\/_takeshape-files\//, ""))), local);
	}
	// An image URL that only recompresses fetches the original from assets.takeshape.io; any other parameter, imgix's
	// variant. A fragment never reaches the server.
	const fetched = readFileSync(log, "utf8").trim().split("\n").sort();
	assert.deepEqual(fetched, [
		"https://assets.takeshape.io/p1/dev/a1/logo.png",
		"https://assets.takeshape.io/p1/dev/a6/icons.svg",
		"https://assets.takeshape.io/p1/dev/a8/12%20Harbor%20View%20cc.jpeg",
		"https://assets.takeshape.io/p1/dev/b1/seeds%20Gardener's%20Guide.webp",
		"https://images.takeshape.io/p1/dev/a2/icon%20one.png?w=400&auto=format",
		"https://images.takeshape.io/p1/dev/a3/bg.jpg?w=1600",
		"https://images.takeshape.io/p1/dev/a4/wave%20(1).jpg?w=300",
		"https://images.takeshape.io/p1/dev/a5/Owner's%20photo.jpg?w=30",
		"https://images.takeshape.io/p1/dev/a7/dim.jpg?con=50&auto=format",
		"https://images.takeshape.io/p1/dev/a9/s.jpg?w=300",
		"https://images.takeshape.io/p1/dev/a9/s.jpg?w=600",
	]);
	const report = readFileSync(join(out, "takeshape", "rehost-report.md"), "utf8");
	assert.match(report, /api\.takeshape\.io\/project\/p1\/graphql/);
	assert.match(report, /11 files/);
	// Downloads are renamed into place once written, so no partial file is left to look finished
	for (const dir of readdirSync(join(out, "takeshape", "files"))) {
		for (const f of readdirSync(join(out, "takeshape", "files", dir))) assert.ok(!f.endsWith(".part"), `${dir}/${f}`);
	}

	// A rerun over a fresh tsg2astro output fetches nothing and writes the same files
	const again = project("again");
	rmSync(join(again, "takeshape"), { recursive: true, force: true });
	mkdirSync(join(again, "takeshape", "files"), { recursive: true });
	for (const dir of readdirSync(join(out, "takeshape", "files"))) {
		for (const f of readdirSync(join(out, "takeshape", "files", dir))) {
			mkdirSync(join(again, "takeshape", "files", dir), { recursive: true });
			writeFileSync(join(again, "takeshape", "files", dir, f), readFileSync(join(out, "takeshape", "files", dir, f)));
		}
	}
	const log2 = join(work, "fetch2.log");
	assert.equal(rehost(again, log2).status, 0);
	assert.ok(!existsSync(log2) || readFileSync(log2, "utf8").trim() === "");
	assert.equal(readFileSync(join(again, "src/templates/partials/head.astro"), "utf8"), head);
});
