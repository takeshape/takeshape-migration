/**
 * The field map and the legacy fields, from a ts2emdash run on the
 * shape-books fixture. The converter writes into a temp folder.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { FieldMap } from "../ts2emdash.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "test", "fixtures", "shape-books");
const work = mkdtempSync(join(tmpdir(), "field-map-"));
after(() => rmSync(work, { recursive: true, force: true }));

type Json = Record<string, any>;
interface Converted {
	seed: Json;
	map: FieldMap;
	mapText: string;
}

function convert(name: string, extra: string[] = [], exportDir = fixture): Converted {
	const out = join(work, name);
	const seedFile = join(out, "seed.json");
	const res = spawnSync(process.execPath, ["--no-warnings", "ts2emdash.mts", exportDir, "--out", seedFile, "--report", join(out, "report.md"), ...extra], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(res.status, 0, `ts2emdash exited ${res.status}: ${res.stderr}`);
	const mapText = readFileSync(join(out, "takeshape-field-map.json"), "utf8");
	return { seed: JSON.parse(readFileSync(seedFile, "utf8")), map: JSON.parse(mapText), mapText };
}

const normal = convert("normal");
const bare = convert("bare", ["--no-legacy-fields"]);
// The same project exported by TakeShape in 2026: schema 3.67 (shapedb mappings, relationships as `@ref` with a
// getRelated resolver), and asset paths that start with {{PROJECT_ID}}
const current = convert("current", [], join(root, "test", "tsg", "sites", "shape-books", "export"));

function collection(map: FieldMap, shape: string) {
	const s = map.shapes[shape];
	assert.equal(s?.kind, "collection", `${shape} is not a collection in the map`);
	return s as Extract<FieldMap["shapes"][string], { kind: "collection" }>;
}

test("post-feature-image", () => {
	assert.deepEqual(collection(normal.map, "Post").properties.featureImage, { kind: "asset", field: "feature_image", multiple: false });
});

test("author-reverse", () => {
	assert.deepEqual(collection(normal.map, "Author").reverse.authored, { shape: "Book", property: "author" });
});

test("homepage-object", () => {
	const hero = collection(normal.map, "Homepage").properties.hero;
	assert.equal(hero.kind, "object");
	assert.deepEqual((hero as Json).properties.featuredPost, { kind: "reference", field: "hero_featured_post", target: "Post", multiple: false, relation: null });
	assert.equal(collection(normal.map, "Homepage").single, true);
});

test("post-tags", () => {
	assert.deepEqual(collection(normal.map, "Post").properties.tags, { kind: "taxonomy", taxonomy: "tag", target: "Tag", multiple: true });
});

test("map-is-sorted-and-versioned", () => {
	assert.equal(normal.map.version, 1);
	assert.equal(normal.mapText, `${JSON.stringify(JSON.parse(normal.mapText, (_k, v) => v), null, 2)}\n`);
	const sorted = (v: unknown): boolean =>
		Array.isArray(v) ? v.every(sorted) : v && typeof v === "object" ? Object.keys(v).every((k, i, a) => i === 0 || a[i - 1] <= k) && Object.values(v).every(sorted) : true;
	assert.ok(sorted(normal.map), "keys are not sorted");
});

test("legacy-timestamps", () => {
	const rows = readFileSync(join(fixture, "data.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Json);
	const byId = new Map(rows.map((r) => [r._id, r]));
	let checked = 0;
	for (const [slug, entries] of Object.entries(normal.seed.content as Record<string, Json[]>)) {
		for (const e of entries) {
			const row = byId.get(String(e.id).slice(3).replace(/~stub$/, ""));
			assert.ok(row, `${slug}/${e.id} has no row`);
			assert.equal(e.data.takeshape_created_at, row._createdAt, `${slug}/${e.id} created`);
			assert.equal(e.data.takeshape_updated_at, row._updatedAt, `${slug}/${e.id} updated`);
			assert.equal(typeof e.data.takeshape_id, "string");
			checked++;
		}
	}
	assert.ok(checked > 0);
	assert.ok(normal.seed.content.homepage.length === 1 || normal.seed.content.homepage, "Homepage singleton is in the seed");
	const home = collection(normal.map, "Homepage");
	assert.deepEqual(home.legacy, { id: "takeshape_id", publishedAt: "takeshape_published_at", createdAt: "takeshape_created_at", updatedAt: "takeshape_updated_at" });
	const fields = (normal.seed.collections as Json[]).find((c) => c.slug === home.collection)!.fields.map((f: Json) => f.slug);
	for (const f of ["takeshape_id", "takeshape_published_at", "takeshape_created_at", "takeshape_updated_at"]) assert.ok(fields.includes(f), `Homepage lacks ${f}`);
});

test("no-legacy-fields", () => {
	for (const [name, s] of Object.entries(bare.map.shapes)) if (s.kind === "collection") assert.equal(s.legacy, null, name);
	for (const c of bare.seed.collections as Json[]) {
		const fields = c.fields.map((f: Json) => f.slug);
		for (const f of ["takeshape_id", "takeshape_published_at", "takeshape_created_at", "takeshape_updated_at"]) assert.ok(!fields.includes(f), `${c.slug} has ${f}`);
	}
	for (const entries of Object.values(bare.seed.content as Record<string, Json[]>)) {
		for (const e of entries) for (const f of ["takeshape_id", "takeshape_created_at", "takeshape_updated_at"]) assert.ok(!(f in e.data));
	}
});

test("term-order", () => {
	// Each entry with terms keeps TakeShape's order of them, which EmDash's taxonomy tables do not hold
	const rows = readFileSync(join(fixture, "data.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Json);
	const tagName = new Map(rows.filter((r) => r._shapeId === "rJBYXVyuQ" || r._contentTypeId === "rJBYXVyuQ").map((r) => [r._id, r.rkZYm41d7]));
	const labelOf = new Map((normal.seed.taxonomies as Json[]).flatMap((t) => t.terms.map((term: Json) => [`${t.name}:${term.slug}`, term.label])));
	let checked = 0;
	for (const e of normal.seed.content.posts as Json[]) {
		const row = rows.find((r) => r._id === String(e.id).slice(3))!;
		const expected = (row.Hkb57EkOQ as Json[] | undefined)?.map((ref) => tagName.get(ref.id)) ?? [];
		const order = e.data.takeshape_term_order?.tag ?? [];
		assert.deepEqual(order.map((slug: string) => labelOf.get(`tag:${slug}`)), expected, String(e.slug));
		if (expected.length) checked++;
	}
	assert.equal(checked, 5);
	const peterPan = (normal.seed.content.posts as Json[]).find((e) => e.slug === "reinventing-peter-pan")!;
	assert.deepEqual(peterPan.data.takeshape_term_order, { tag: ["vestibulum-tellus", "pellentesque"] });
	assert.deepEqual((normal.seed.content.books as Json[])[0]!.data.takeshape_term_order, { genre: ["fantasy"] });

	// A json field on collections with taxonomies, named in the field map; written without legacy fields too
	for (const converted of [normal, bare]) {
		const posts = (converted.seed.collections as Json[]).find((c) => c.slug === "posts")!;
		assert.deepEqual(posts.fields.find((f: Json) => f.slug === "takeshape_term_order")?.type, "json");
		assert.equal(collection(converted.map, "Post").termOrder, "takeshape_term_order");
		assert.equal(collection(converted.map, "Book").termOrder, "takeshape_term_order");
		assert.equal(collection(converted.map, "Author").termOrder, null);
		assert.ok(!(converted.seed.collections as Json[]).find((c) => c.slug === "authors")!.fields.some((f: Json) => f.slug === "takeshape_term_order"));
	}
});

test("current-export-plans-like-the-pattern-export", () => {
	for (const shape of ["Post", "Book", "Author", "Homepage", "SiteSettings", "Genre", "Tag"]) {
		assert.deepEqual(current.map.shapes[shape], normal.map.shapes[shape], shape);
	}
	const fields = (seed: Json) => Object.fromEntries((seed.collections as Json[]).map((c) => [c.slug, c.fields]));
	assert.deepEqual(fields(current.seed), fields(normal.seed));
});

test("current-export-asset-urls-name-the-project", () => {
	const urls = new Set(JSON.stringify(current.seed).match(/https:\/\/assets\.takeshape\.io\/[^"]+/g) ?? []);
	assert.equal(urls.size, 19);
	for (const url of urls) assert.match(url, /^https:\/\/assets\.takeshape\.io\/00000006-0000-4000-8000-000000000006\/dev\//);
});

// A navigation's links: a list of objects whose sublinks are a list too, so the converter keeps it as JSON,
// with a button field TakeShape never stored. The skipped button must not take the JSON field's place in the map.
test("a skipped field inside a JSON field leaves the JSON field in the map", () => {
	const dir = join(work, "nav-export");
	mkdirSync(dir, { recursive: true });
	const str = (key: string, title: string) => ({ type: "string", title, "@mapping": `takeshape:local:${key}` });
	const schema = {
		apiVersion: "2",
		projectId: "p",
		defaultLocale: "en",
		locales: ["en"],
		shapes: {
			Navigation: { id: "NAV", name: "Navigation", title: "Navigation", model: { type: "single" }, schema: { type: "object", properties: { links: { type: "array", title: "Links", "@mapping": "takeshape:local:Navigation.lk", items: { "@ref": "local:NavigationLinks" } } } } },
			NavigationLinks: {
				id: "NL",
				name: "NavigationLinks",
				title: "Links",
				schema: {
					type: "object",
					properties: {
						text: str("NavigationLinks.tx", "Text"),
						blurb: { type: "object", title: "Blurb", "@mapping": "takeshape:local:NavigationLinks.bl", "@tag": "draftjs" },
						note: { type: "string", title: "Note", "@mapping": "takeshape:local:NavigationLinks.nt", "@tag": "mdx" },
						sublinks: { type: "array", title: "Sublinks", "@mapping": "takeshape:local:NavigationLinks.sl", items: { "@ref": "NavigationLinksSublinks" } },
					},
				},
			},
			NavigationLinksSublinks: { id: "NS", name: "NavigationLinksSublinks", title: "Sublinks", schema: { type: "object", properties: { text: str("NavigationLinksSublinks.st", "Text"), button: { "@ref": "local:NavigationButton", title: "Button" } } } },
			NavigationButton: { id: "NB", name: "NavigationButton", title: "Button", schema: { type: "object", properties: { text: { type: "string", title: "Text" } } } },
		},
		forms: {},
	};
	writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
	const blurb = JSON.stringify({ blocks: [{ key: "b1", text: "Read ours", type: "unstyled", depth: 0, inlineStyleRanges: [{ offset: 5, length: 4, style: "BOLD" }], entityRanges: [], data: {} }], entityMap: {} });
	writeFileSync(join(dir, "data.jsonl"), `${JSON.stringify({ _id: "n1", _shapeId: "NAV", _enabled: true, lk: [{ tx: "Reports", bl: blurb, nt: "Field\n\nGuide", sl: [{ st: "Annual" }] }] })}\n`);
	const { map, seed } = convert("nav", [], dir);
	assert.deepEqual(collection(map, "Navigation").properties.links, { kind: "json", field: "links" });
	const [link] = seed.content.navigation[0].data.links;
	assert.equal(link.text, "Reports");
	assert.deepEqual(link.sublinks, [{ text: "Annual" }]);
	// Rich text inside a JSON list keeps its blocks, so the site can print the HTML TakeShape printed
	assert.equal(link.blurb._type, "takeshapeRichText");
	assert.deepEqual(link.blurb.blocks[0].children.map((c: Json) => [c.text, c.marks]), [["Read ", []], ["ours", ["strong"]]]);
	// MDX too, with the text TakeShape stored, which the field returned as it was
	assert.equal(link.note._type, "takeshapeRichText");
	assert.equal(link.note.source, "Field\n\nGuide");
	assert.deepEqual(link.note.blocks.map((b: Json) => b.children.map((c: Json) => c.text).join("")), ["Field", "Guide"]);
});

// Repeater rows that hold link { text url }: both became the row field "link", the URL overwrote the text, and the
// field map had no "link" for the site's queries
test("an object inside a repeater row keeps each of its fields", () => {
	const dir = join(work, "rows-export");
	mkdirSync(dir, { recursive: true });
	const str = (key: string, title: string) => ({ type: "string", title, "@mapping": `takeshape:local:${key}` });
	const schema = {
		apiVersion: "2",
		projectId: "p",
		defaultLocale: "en",
		locales: ["en"],
		shapes: {
			Contact: { id: "CONTACT", name: "Contact", title: "Contact", model: { type: "single" }, schema: { type: "object", properties: { ways: { type: "array", title: "Ways", "@mapping": "takeshape:local:Contact.wy", items: { "@ref": "local:ContactWays" } } } } },
			ContactWays: { id: "CW", name: "ContactWays", title: "Ways", schema: { type: "object", properties: { title: str("ContactWays.tt", "Title"), link: { title: "Link", "@ref": "local:ContactWaysLink", "@mapping": "takeshape:local:ContactWays.lk" } } } },
			ContactWaysLink: { id: "CL", name: "ContactWaysLink", title: "Link", schema: { type: "object", properties: { text: str("ContactWaysLink.tx", "Text"), url: str("ContactWaysLink.ur", "URL") } } },
		},
		forms: {},
	};
	writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
	// A row that holds nothing still counts: TakeShape returned it with every field null
	writeFileSync(join(dir, "data.jsonl"), `${JSON.stringify({ _id: "c1", _shapeId: "CONTACT", _enabled: true, wy: [{ tt: "Email", lk: { tx: "Write to us", ur: "/write/" } }, { tt: "Phone" }, { _shapeId: "CW" }] })}\n`);
	const { map, seed } = convert("rows", [], dir);
	const field = seed.collections.find((c: Json) => c.slug === "contact").fields.find((f: Json) => f.slug === "ways");
	assert.deepEqual(field.validation.subFields.map((s: Json) => s.slug), ["title", "link_text", "link_url"]);
	assert.deepEqual(seed.content.contact[0].data.ways, [{ title: "Email", link_text: "Write to us", link_url: "/write/" }, { title: "Phone" }, {}]);
	assert.deepEqual(collection(map, "Contact").properties.ways, {
		kind: "repeater",
		field: "ways",
		properties: {
			title: { kind: "scalar", field: "title", type: "string" },
			link: { kind: "object", properties: { text: { kind: "scalar", field: "link_text", type: "string" }, url: { kind: "scalar", field: "link_url", type: "string" } } },
		},
	});
});

// A quiz question: MDX in an inline object, tagged on the property, with no form widget the converter finds; the
// site asks for question(format: html)
test("a property tagged mdx in an inline object converts as Markdown", () => {
	const dir = join(work, "mdx-tag-export");
	mkdirSync(dir, { recursive: true });
	const schema = {
		apiVersion: "2",
		projectId: "p",
		defaultLocale: "en",
		locales: ["en"],
		shapes: {
			Lesson: { id: "LES", name: "Lesson", title: "Lesson", model: { type: "single" }, schema: { type: "object", properties: { quiz: { title: "Quiz", "@ref": "local:Quiz", "@mapping": "takeshape:local:Lesson.qz" } } } },
			Quiz: { id: "QZ", name: "Quiz", title: "Quiz", schema: { type: "object", properties: { question: { type: "string", title: "Question", "@tag": "mdx", "@mapping": "takeshape:local:Quiz.qn" } } } },
		},
		forms: {},
	};
	writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
	writeFileSync(join(dir, "data.jsonl"), `${JSON.stringify({ _id: "l1", _shapeId: "LES", _enabled: true, qz: { qn: "Which planet is **closest to the sun?**" } })}\n`);
	const { map, seed } = convert("mdx-tag", [], dir);
	const quiz = collection(map, "Lesson").properties.quiz;
	assert.deepEqual(quiz?.kind === "object" ? quiz.properties.question : quiz, { kind: "richText", field: "quiz_question", format: "markdown" });
	const [block] = seed.content.lesson[0].data.quiz_question;
	assert.deepEqual(block.children.map((c: Json) => [c.text, c.marks]), [["Which planet is ", []], ["closest to the sun?", ["strong"]]]);
});

// An MDX title: TakeShape's MDX renderer read entities and the spaces around a paragraph as Markdown does, where
// EmDash's markdownToPortableText keeps both as written ("We&amp;#x2019;re", "&nbsp;friendly")
test("Markdown text keeps what Markdown means: entities decoded, paragraphs trimmed, code spans as written", () => {
	const dir = join(work, "mdx-entities-export");
	mkdirSync(dir, { recursive: true });
	const schema = {
		apiVersion: "2",
		projectId: "p",
		defaultLocale: "en",
		locales: ["en"],
		shapes: { Page: { id: "PG", name: "Page", title: "Page", model: { type: "single" }, schema: { type: "object", properties: { title: { type: "string", title: "Title", "@tag": "mdx", "@mapping": "takeshape:local:Page.ti" } } } } },
		forms: {},
	};
	writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
	const text = "We&#x2019;re building a\n\n friendly &amp; the city&#8217;s `a&amp;b` network \n\nFrom small towns to big cities, ";
	writeFileSync(join(dir, "data.jsonl"), `${JSON.stringify({ _id: "p1", _shapeId: "PG", _enabled: true, ti: text })}\n`);
	const { seed } = convert("mdx-entities", [], dir);
	const blocks = seed.content.page[0].data.title;
	assert.deepEqual(
		blocks.map((b: Json) => b.children.map((c: Json) => [c.text, c.marks])),
		[[["We’re building a", []]], [["friendly & the city’s ", []], ["a&amp;b", ["code"]], [" network", []]], [["From small towns to big cities,", []]]],
	);
});

// An inline button { text url } with no @mapping on its properties: TakeShape stored such a property under its own
// name (read from TakeShape's source). Only a property a service resolves is not stored.
test("a property without @mapping is stored under its name", () => {
	const dir = join(work, "unmapped-export");
	mkdirSync(dir, { recursive: true });
	const schema = {
		apiVersion: "2",
		projectId: "p",
		defaultLocale: "en",
		locales: ["en"],
		shapes: {
			Banner: { id: "BANNER", name: "Banner", title: "Banner", model: { type: "single" }, schema: { type: "object", properties: { button: { title: "Button", "@ref": "local:linkButton", "@mapping": "takeshape:local:Banner.bt" } } } },
			linkButton: { id: "BB", name: "linkButton", title: "Button", schema: { type: "object", properties: { text: { type: "string", title: "Text" }, url: { type: "string", title: "Url" }, live: { type: "string", title: "Live", "@resolver": { name: "rest:get" } } } } },
		},
		forms: {},
	};
	writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
	writeFileSync(join(dir, "data.jsonl"), `${JSON.stringify({ _id: "b1", _shapeId: "BANNER", _enabled: true, bt: { text: "Sign up", url: "/signup/", _shapeId: "BB" } })}\n`);
	const { map, seed } = convert("unmapped", [], dir);
	const data = seed.content.banner[0].data;
	assert.equal(data.button_text, "Sign up");
	assert.equal(data.button_url, "/signup/");
	const button = collection(map, "Banner").properties.button;
	assert.deepEqual(button?.kind === "object" ? Object.keys(button.properties).sort() : button, ["live", "text", "url"]);
	assert.equal(button?.kind === "object" ? button.properties.live?.kind : null, "skipped");
});

test("a single shape's slug property stays the entry's slug", () => {
	// A page that prints `page | route('story')` for a single entry reads that entry's slug
	const dir = join(work, "single-slug-export");
	mkdirSync(dir, { recursive: true });
	const schema = {
		apiVersion: "2",
		projectId: "p",
		defaultLocale: "en",
		locales: ["en"],
		shapes: {
			Brief: {
				id: "BRIEF",
				name: "Brief",
				title: "Brief",
				model: { type: "single" },
				schema: { type: "object", properties: { title: { type: "string", title: "Title", "@mapping": "takeshape:local:Brief.ti" }, slug: { type: "string", title: "Slug", "@mapping": "takeshape:local:Brief.sl" } } },
			},
		},
		forms: {},
	};
	writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
	writeFileSync(join(dir, "data.jsonl"), `${JSON.stringify({ _id: "b1", _shapeId: "BRIEF", _enabled: false, ti: "Executive briefing", sl: "annual-executive-briefing" })}\n`);
	const { map, seed } = convert("single-slug", [], dir);
	assert.equal(seed.content.brief[0].slug, "annual-executive-briefing");
	assert.deepEqual(collection(map, "Brief").properties.slug, { kind: "entrySlug" });
});

test("an entry that links to itself keeps the link through the apply", () => {
	// A related-stories field (Story or Page, so JSON) can list the story itself; emdash seed resolves a $ref only
	// to entries created before, so a link to the entry itself stayed "$ref:ts-…" text
	const dir = join(work, "self-link-export");
	mkdirSync(dir, { recursive: true });
	const rel = (shapeIds: string[], multiple: boolean, key: string) => ({
		title: key,
		"@mapping": `takeshape:local:Story.${key}`,
		...(multiple ? { type: "array", items: { $ref: "#/shapes/TSRelationship/schema" } } : { $ref: "#/shapes/TSRelationship/schema" }),
		"@relationship": { shapeIds, type: multiple ? "multiple" : "single" },
	});
	const schema = {
		apiVersion: "2",
		projectId: "p",
		defaultLocale: "en",
		locales: ["en"],
		shapes: {
			Story: { id: "STO", name: "Story", title: "Story", model: { type: "multiple" }, schema: { type: "object", properties: { title: { type: "string", title: "Title", "@mapping": "takeshape:local:Story.ti" }, related: rel(["STO", "PAG"], true, "re"), next: rel(["STO"], false, "nx") } } },
			Page: { id: "PAG", name: "Page", title: "Page", model: { type: "multiple" }, schema: { type: "object", properties: { title: { type: "string", title: "Title", "@mapping": "takeshape:local:Page.ti" } } } },
		},
		forms: {},
	};
	const link = (shapeId: string, id: string) => ({ shapeId, id });
	writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
	writeFileSync(
		join(dir, "data.jsonl"),
		[
			{ _id: "s1", _shapeId: "STO", _enabled: true, ti: "Lighthouses", re: [link("STO", "s1"), link("PAG", "p1")], nx: link("STO", "s1") },
			{ _id: "p1", _shapeId: "PAG", _enabled: true, ti: "About" },
		]
			.map((r) => JSON.stringify(r))
			.join("\n"),
	);
	convert("self-link", [], dir);
	const out = join(work, "self-link");
	const emdashPkg = join(root, "node_modules", "emdash");
	const cli = join(emdashPkg, JSON.parse(readFileSync(join(emdashPkg, "package.json"), "utf8")).bin.emdash);
	const res = spawnSync(process.execPath, ["--no-warnings", cli, "seed", join(out, "seed.json"), "--database", join(out, "data.db"), "--on-conflict", "update"], { cwd: out, encoding: "utf8", timeout: 120_000 });
	assert.equal(res.status, 0, `emdash seed exited ${res.status}: ${res.stdout}${res.stderr}`);
	const sqlite = new DatabaseSync(join(out, "data.db"), { readOnly: true });
	try {
		const rows = sqlite.prepare("select id, related from ec_stories").all() as Array<{ id: string; related: string }>;
		assert.equal(rows.length, 1);
		const related = JSON.parse(rows[0]!.related) as Array<{ collection: string; id: string }>;
		assert.equal(related[0]!.id, rows[0]!.id);
		const own = sqlite.prepare("select count(*) as n from _emdash_content_references").get() as { n: number };
		assert.equal(own.n, 1);
	} finally {
		sqlite.close();
	}
});

// TakeShape returned an unpublished entry wherever a published one linked to it, so the old site could show it; EmDash
// shows published entries only. The report lists each draft that a published entry links to, so the owner can publish
// the ones that should be public.
test("the report lists the drafts that published entries link to", () => {
	const dir = join(work, "linked-drafts-export");
	mkdirSync(dir, { recursive: true });
	const rel = (key: string, multiple: boolean) => ({
		title: key,
		"@mapping": `takeshape:local:Story.${key}`,
		...(multiple ? { type: "array", items: { $ref: "#/shapes/TSRelationship/schema" } } : { $ref: "#/shapes/TSRelationship/schema" }),
		"@relationship": { shapeIds: ["PER"], type: multiple ? "multiple" : "single" },
	});
	const schema = {
		apiVersion: "1",
		projectId: "p",
		defaultLocale: "en",
		locales: ["en"],
		shapes: {
			Story: { id: "STO", name: "Story", title: "Story", model: { type: "multiple" }, schema: { type: "object", properties: { title: { type: "string", title: "Title", "@mapping": "takeshape:local:Story.ti" }, people: rel("pe", true) } } },
			Person: { id: "PER", name: "Person", title: "Person", model: { type: "multiple" }, schema: { type: "object", properties: { name: { type: "string", title: "Name", "@mapping": "takeshape:local:Person.nm" } } } },
		},
		forms: {},
	};
	const link = (id: string) => ({ shapeId: "PER", id });
	writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
	writeFileSync(
		join(dir, "data.jsonl"),
		[
			{ _id: "s1", _shapeId: "STO", _enabled: true, ti: "Team", pe: [link("will"), link("ann")] },
			{ _id: "s2", _shapeId: "STO", _enabled: true, ti: "About", pe: [link("will")] },
			// A draft that links to a draft: not something the public site showed
			{ _id: "s3", _shapeId: "STO", _enabled: false, ti: "Old draft", pe: [link("dee")] },
			{ _id: "will", _shapeId: "PER", _enabled: false, nm: "Will" },
			{ _id: "ann", _shapeId: "PER", _enabled: true, nm: "Ann" },
			{ _id: "dee", _shapeId: "PER", _enabled: false, nm: "Dee" },
		]
			.map((r) => JSON.stringify(r))
			.join("\n"),
	);
	convert("linked-drafts", [], dir);
	const report = readFileSync(join(work, "linked-drafts", "report.md"), "utf8");
	const section = report.split("## Drafts that published entries link to")[1]?.split("\n## ")[0] ?? "";
	assert.match(section, /\| Will \| `persons` \| `will` \| 2 \| `stories\/about`, `stories\/team` \|/, section);
	assert.doesNotMatch(section, /Dee|Ann/);
	assert.match(report, /\*\*1\*\* draft is linked from published entries/);
});

test("a field named after an SQL keyword is renamed, so EmDash can turn on search for its collection", () => {
	// EmDash 1.3.0 writes field names unquoted into its search index's SQL: a Story.references field failed
	// `emdash seed` with "Failed to enable search for stories: near "references": syntax error"
	const dir = join(work, "sql-keyword-export");
	mkdirSync(dir, { recursive: true });
	const prop = (title: string, key: string) => ({ type: "string", title, "@mapping": `takeshape:local:Story.${key}` });
	const schema = {
		apiVersion: "2",
		projectId: "p",
		defaultLocale: "en",
		locales: ["en"],
		shapes: {
			Story: { id: "STO", name: "Story", title: "Story", model: { type: "multiple" }, schema: { type: "object", properties: { title: prop("Title", "ti"), references: prop("References", "rf"), order: prop("Order", "or"), values: { title: "Values", "@ref": "local:valueBox", "@mapping": "takeshape:local:Story.va" } } } },
			// An inline object's name only prefixes its fields' columns, so it keeps its name
			valueBox: { id: "VB", name: "valueBox", title: "Values", schema: { type: "object", properties: { intro: { type: "string", title: "Intro" } } } },
		},
		forms: { Story: { default: { properties: { title: { widget: "singleLineText" }, references: { widget: "markdownText" }, order: { widget: "singleLineText" } }, order: ["title", "references", "order"] } } },
	};
	writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
	writeFileSync(join(dir, "data.jsonl"), `${JSON.stringify({ _id: "s1", _shapeId: "STO", _enabled: true, ti: "Lighthouses", rf: "Marlowe and others, 2002", or: "3", va: { intro: "Why lighthouses", _shapeId: "VB" } })}\n`);
	const { map } = convert("sql-keyword", [], dir);
	const story = collection(map, "Story").properties;
	assert.equal(story.references && "field" in story.references ? story.references.field : null, "ts_references");
	assert.equal(story.order && "field" in story.order ? story.order.field : null, "ts_order");
	const values = story.values?.kind === "object" ? story.values.properties.intro : null;
	assert.equal(values && "field" in values ? values.field : null, "values_intro");
	const out = join(work, "sql-keyword");
	const emdashPkg = join(root, "node_modules", "emdash");
	const cli = join(emdashPkg, JSON.parse(readFileSync(join(emdashPkg, "package.json"), "utf8")).bin.emdash);
	const res = spawnSync(process.execPath, ["--no-warnings", cli, "seed", join(out, "seed.json"), "--database", join(out, "data.db"), "--on-conflict", "update"], { cwd: out, encoding: "utf8", timeout: 120_000 });
	assert.equal(res.status, 0, `emdash seed exited ${res.status}: ${res.stdout}${res.stderr}`);
	assert.doesNotMatch(`${res.stdout}${res.stderr}`, /Failed to enable search/);
	const sqlite = new DatabaseSync(join(out, "data.db"), { readOnly: true });
	try {
		const config = sqlite.prepare("select search_config from _emdash_collections where slug = 'stories'").get() as { search_config: string | null };
		assert.equal(JSON.parse(config.search_config ?? "{}").enabled, true);
		const hits = sqlite.prepare(`select count(*) as n from "_emdash_fts_stories" where "_emdash_fts_stories" match 'marlowe'`).get() as { n: number };
		assert.equal(hits.n, 1);
	} finally {
		sqlite.close();
	}
});
