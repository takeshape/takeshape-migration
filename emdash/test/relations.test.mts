/**
 * When two reference fields that point at each other's shapes become one
 * EmDash relation. ts2emdash pairs them only when that loses no link: the
 * links stored on both ends, merged, must fit both fields. Exports are built
 * here, two shapes each, in TakeShape's 2020 schema form.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const emdashPkg = join(root, "node_modules", "emdash");
const emdashCli = join(emdashPkg, JSON.parse(readFileSync(join(emdashPkg, "package.json"), "utf8")).bin.emdash);
const work = mkdtempSync(join(tmpdir(), "relations-"));
after(() => rmSync(work, { recursive: true, force: true }));

type Json = Record<string, any>;

interface Side {
	/** Property name, also the storage key */
	prop: string;
	multiple: boolean;
}
interface Spec {
	/** Region.<regionSide.prop> points at Area */
	regionSide: Side;
	/** Area.<areaSide.prop> points at Region */
	areaSide: Side;
	/** Region id to the Area ids its field holds */
	regionLinks: Record<string, string[]>;
	/** Area id to the Region ids its field holds */
	areaLinks: Record<string, string[]>;
}

const REGION = "REG";
const AREA = "ARE";

function relationshipProp(side: Side, ownShape: string, targetId: string) {
	return {
		title: side.prop,
		"@mapping": `takeshape:local:${ownShape}.${side.prop}`,
		...(side.multiple ? { type: "array", items: { $ref: "#/shapes/TSRelationship/schema" } } : { $ref: "#/shapes/TSRelationship/schema" }),
		"@relationship": { shapeIds: [targetId], type: side.multiple ? "multiple" : "single" },
	};
}

function shape(id: string, name: string, side: Side, targetId: string) {
	return {
		id,
		name,
		title: name,
		model: { type: "multiple" },
		schema: {
			type: "object",
			properties: {
				name: { type: "string", title: "Name", minLength: 1, "@mapping": `takeshape:local:${name}.name` },
				[side.prop]: relationshipProp(side, name, targetId),
			},
		},
	};
}

function row(shapeId: string, id: string, side: Side, targetShape: string, targets: string[] | undefined) {
	const r: Json = {
		_id: id,
		_contentTypeId: shapeId,
		_enabled: true,
		_createdAt: "2020-01-01T00:00:00.000Z",
		_updatedAt: "2020-01-01T00:00:00.000Z",
		_enabledAt: "2020-01-01T00:00:00.000Z",
		name: id,
	};
	if (targets?.length) {
		const links = targets.map((t) => ({ contentTypeId: targetShape, id: t }));
		r[side.prop] = side.multiple ? links : links[0];
	}
	return r;
}

/** Writes the export, runs ts2emdash on it, and returns the seed and the report. */
function convert(name: string, spec: Spec): { dir: string; seedFile: string; seed: Json; report: string } {
	const dir = join(work, name);
	const exportDir = join(dir, "export");
	mkdirSync(exportDir, { recursive: true });
	const widget = { widget: "relationship" };
	const schema = {
		apiVersion: "2",
		projectId: "relations-test",
		defaultLocale: "en",
		locales: ["en"],
		shapes: {
			Region: shape(REGION, "Region", spec.regionSide, AREA),
			Area: shape(AREA, "Area", spec.areaSide, REGION),
		},
		forms: {
			Region: { default: { properties: { name: {}, [spec.regionSide.prop]: widget } } },
			Area: { default: { properties: { name: {}, [spec.areaSide.prop]: widget } } },
		},
	};
	const ids = (links: Record<string, string[]>, all: string[]) => [...new Set([...all, ...Object.keys(links)])];
	const regionIds = ids(spec.regionLinks, Object.values(spec.areaLinks).flat());
	const areaIds = ids(spec.areaLinks, Object.values(spec.regionLinks).flat());
	const rows = [
		...regionIds.map((id) => row(REGION, id, spec.regionSide, AREA, spec.regionLinks[id])),
		...areaIds.map((id) => row(AREA, id, spec.areaSide, REGION, spec.areaLinks[id])),
	];
	writeFileSync(join(exportDir, "schema.json"), JSON.stringify(schema, null, 2));
	writeFileSync(join(exportDir, "data.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
	const seedFile = join(dir, "seed.json");
	const reportFile = join(dir, "report.md");
	const res = spawnSync(process.execPath, ["--no-warnings", "ts2emdash.mts", exportDir, "--out", seedFile, "--report", reportFile], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(res.status, 0, `ts2emdash exited ${res.status}: ${res.stderr}`);
	return { dir, seedFile, seed: JSON.parse(readFileSync(seedFile, "utf8")), report: readFileSync(reportFile, "utf8") };
}

const field = (seed: Json, collection: string, slug: string) => seed.collections.find((c: Json) => c.slug === collection)?.fields.find((f: Json) => f.slug === slug);
const entry = (seed: Json, collection: string, id: string) => seed.content[collection].find((e: Json) => e.id === `ts-${id}`);
const refs = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).replace(/^\$ref:ts-/, "").replace(/~stub$/, ""));

/** Every link a field holds, as "<entry> <target>", whichever end of its relation the seed declares it from. */
function linksOf(seed: Json, collection: string, slug: string): string[] {
	const rel = seed.relations?.find((r: Json) => r.slug === field(seed, collection, slug)?.validation?.relation);
	const own = seed.content[collection].flatMap((e: Json) => refs(e.data[slug]).map((t) => `${e.id.slice(3)} ${t}`));
	if (!rel || rel.parentCollection === collection) return own.sort();
	const parentField = seed.collections.find((c: Json) => c.slug === rel.parentCollection).fields.find((f: Json) => f.validation?.relation === rel.slug);
	const declared = seed.content[rel.parentCollection].flatMap((e: Json) => refs(e.data[parentField.slug]).map((t) => `${t} ${e.id.slice(3)}`));
	return [...own, ...declared].sort();
}

// Each Region features one Area, each Area names the Region it belongs to, and the two disagree.
// Two Regions feature the same Area, which a 1:1 relation can't hold.
const disagree = convert("disagree", {
	regionSide: { prop: "featuredArea", multiple: false },
	areaSide: { prop: "region", multiple: false },
	regionLinks: { r1: ["a1"], r2: ["a1"] },
	areaLinks: { a1: ["r1"], a2: ["r1"], a3: ["r2"] },
});

test("fields-that-disagree-stay-separate", () => {
	assert.deepEqual(field(disagree.seed, "regions", "featured_area")?.validation, { targetCollection: "areas", multiple: false });
	assert.notEqual(field(disagree.seed, "areas", "region")?.validation?.relation, field(disagree.seed, "regions", "featured_area")?.validation?.relation);
	assert.doesNotMatch(disagree.report, /two different values/);
});

test("fields-that-disagree-keep-every-link", () => {
	assert.deepEqual(linksOf(disagree.seed, "regions", "featured_area"), ["r1 a1", "r2 a1"]);
	assert.deepEqual(linksOf(disagree.seed, "areas", "region"), ["a1 r1", "a2 r1", "a3 r2"]);
});

// Regions and Areas point at each other, so one of them is created first and its links point forward. Areas come
// first here (collections are ordered depth-first from the first shape), so Area.region's links are declared from a
// new field on regions, created after every area exists.
test("links-that-point-forward-are-declared-from-the-later-end", () => {
	const rel = disagree.seed.relations?.find((r: Json) => r.childCollection === "areas");
	assert.ok(rel, `no relation for areas.region: ${JSON.stringify(disagree.seed.relations)}`);
	assert.equal(rel.parentCollection, "regions");
	assert.equal(rel.maxParentsPerChild, 1);
	assert.equal(rel.maxChildrenPerParent, null);
	assert.deepEqual(field(disagree.seed, "areas", "region")?.validation, { relation: rel.slug });
	const declaring = disagree.seed.collections.find((c: Json) => c.slug === "regions").fields.find((f: Json) => f.validation?.relation === rel.slug);
	assert.ok(declaring, "regions has no field for the relation");
	assert.deepEqual(refs(entry(disagree.seed, "regions", "r1").data[declaring.slug]).sort(), ["a1", "a2"]);
	assert.deepEqual(refs(entry(disagree.seed, "regions", "r2").data[declaring.slug]), ["a3"]);
	assert.equal(entry(disagree.seed, "areas", "a1").data.region, undefined);
	assert.deepEqual(Object.keys(disagree.seed.content), ["areas", "regions"]);
	assert.doesNotMatch(disagree.report, /Collections reference each other/);
});

test("links-that-point-forward-keep-their-field-map-entry", () => {
	const map = JSON.parse(readFileSync(join(disagree.dir, "takeshape-field-map.json"), "utf8"));
	const rel = disagree.seed.relations.find((r: Json) => r.childCollection === "areas");
	assert.deepEqual(map.shapes.Area.properties.region, { kind: "reference", field: "region", target: "Region", multiple: false, relation: rel.slug });
	assert.deepEqual(Object.keys(map.shapes.Region.properties).sort(), ["featuredArea", "name"]);
});

// Area.regions: links that point forward are declared from the later end, and EmDash keeps a link's
// order on that end only, so from the child end they come back in the declaring entries' order. TakeShape's order of
// each multiple field goes into takeshape_link_order, which the migrated site sorts by.
const forwardOrder = convert("forward-order", {
	regionSide: { prop: "featuredArea", multiple: false },
	areaSide: { prop: "regions", multiple: true },
	regionLinks: { r1: ["a1"] },
	areaLinks: { a1: ["r2", "r1"], a2: ["r1"] },
});

test("links-that-point-forward-keep-takeshape-order-in-a-sidecar", () => {
	const rel = forwardOrder.seed.relations?.find((r: Json) => r.childCollection === "areas");
	assert.equal(rel?.parentCollection, "regions", JSON.stringify(forwardOrder.seed.relations));
	assert.deepEqual(entry(forwardOrder.seed, "areas", "a1").data.takeshape_link_order, { regions: ["r2", "r1"] });
	// One link has one order
	assert.equal(entry(forwardOrder.seed, "areas", "a2").data.takeshape_link_order, undefined);
	assert.equal(field(forwardOrder.seed, "areas", "takeshape_link_order")?.type, "json");
	const map = JSON.parse(readFileSync(join(forwardOrder.dir, "takeshape-field-map.json"), "utf8"));
	assert.equal(map.shapes.Area.linkOrder, "takeshape_link_order");
	assert.equal(map.shapes.Region.linkOrder, null);
});

test("fields-that-disagree-apply-with-every-link", () => {
	const db = join(disagree.dir, "data.db");
	const res = spawnSync(process.execPath, ["--no-warnings", emdashCli, "seed", disagree.seedFile, "--database", db, "--on-conflict", "update"], {
		cwd: disagree.dir,
		encoding: "utf8",
		timeout: 120_000,
	});
	const out = `${res.stdout}${res.stderr}`;
	assert.equal(res.status, 0, `emdash seed exited ${res.status}: ${out}`);
	assert.doesNotMatch(out, /failed to write references/);
	assert.doesNotMatch(out, /did not resolve/);
	const sqlite = new DatabaseSync(db, { readOnly: true });
	try {
		// Two featured areas and three area regions
		assert.equal((sqlite.prepare("select count(*) as n from _emdash_content_references").get() as { n: number }).n, 5);
	} finally {
		sqlite.close();
	}
});

// shape-blog: Post.author holds every link and Author.authored is empty. TakeShape answered Author.authored with
// nothing, and one relation would answer it with the posts, so the two stay separate.
const oneSided = convert("one-sided", {
	regionSide: { prop: "areas", multiple: true },
	areaSide: { prop: "region", multiple: false },
	regionLinks: {},
	areaLinks: { a1: ["r1"], a2: ["r1"], a3: ["r2"] },
});

test("one-sided-links-stay-separate", () => {
	assert.deepEqual(oneSided.seed.relations ?? [], []);
	assert.deepEqual(linksOf(oneSided.seed, "regions", "areas"), []);
	assert.deepEqual(linksOf(oneSided.seed, "areas", "region"), ["a1 r1", "a2 r1", "a3 r2"]);
});

// Both ends hold the same links, so one relation answers each end as TakeShape did.
const matching = convert("matching", {
	regionSide: { prop: "areas", multiple: true },
	areaSide: { prop: "region", multiple: false },
	regionLinks: { r1: ["a1", "a2"], r2: ["a3"] },
	areaLinks: { a1: ["r1"], a2: ["r1"], a3: ["r2"] },
});

test("matching-links-pair", () => {
	assert.equal(matching.seed.relations?.length, 1);
	const slug = matching.seed.relations[0].slug;
	assert.equal(field(matching.seed, "regions", "areas")?.validation?.relation, slug);
	assert.equal(field(matching.seed, "areas", "region")?.validation?.relation, slug);
	// Links are declared once, from the parent end: the single field
	assert.equal(matching.seed.relations[0].parentCollection, "areas");
	assert.deepEqual(refs(entry(matching.seed, "areas", "a2").data.region), ["r1"]);
	assert.equal(entry(matching.seed, "regions", "r1").data.areas, undefined);
	assert.doesNotMatch(matching.report, /two different values/);
});

// Collection and field slugs both hold underscores, so "<collection>_<field>" can name two relations. Here Zone.bF
// pairs with Region.zones as relation zz_zz + yy_f, and Area.f, declared from zz by its new field zz_yy_f, would be
// zz + zz_yy_f: the same slug for two relations.
const ZONE = "ZON";
function shapeWith(id: string, name: string, refs: Record<string, { target: string; multiple: boolean }>) {
	const s = shape(id, name, { prop: "unused", multiple: false }, id);
	delete (s.schema.properties as Json).unused;
	for (const [prop, r] of Object.entries(refs)) (s.schema.properties as Json)[prop] = relationshipProp({ prop, multiple: r.multiple }, name, r.target);
	return s;
}
const link = (shapeId: string, ids: string[], multiple: boolean) => {
	const links = ids.map((id) => ({ contentTypeId: shapeId, id }));
	return multiple ? links : links[0];
};
function entryRow(shapeId: string, id: string, values: Json) {
	return { ...row(shapeId, id, { prop: "unused", multiple: false }, shapeId, undefined), ...values };
}

function convertExport(name: string, shapes: Record<string, Json>, rows: Json[], overrides: Json) {
	const dir = join(work, name);
	const exportDir = join(dir, "export");
	mkdirSync(exportDir, { recursive: true });
	const forms = Object.fromEntries(
		Object.entries(shapes).map(([n, s]) => [n, { default: { properties: Object.fromEntries(Object.keys(s.schema.properties).map((p) => [p, p === "name" ? {} : { widget: "relationship" }])) } }]),
	);
	writeFileSync(join(exportDir, "schema.json"), JSON.stringify({ apiVersion: "2", projectId: "relations-test", defaultLocale: "en", locales: ["en"], shapes, forms }, null, 2));
	writeFileSync(join(exportDir, "data.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
	writeFileSync(join(dir, "overrides.json"), JSON.stringify(overrides));
	const seedFile = join(dir, "seed.json");
	const res = spawnSync(process.execPath, ["--no-warnings", "ts2emdash.mts", exportDir, "--out", seedFile, "--report", join(dir, "report.md"), "--config", join(dir, "overrides.json")], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(res.status, 0, `ts2emdash exited ${res.status}: ${res.stderr}`);
	return { dir, seedFile, seed: JSON.parse(readFileSync(seedFile, "utf8")) as Json };
}

const clash = convertExport(
	"relation-slug-clash",
	{
		Region: shapeWith(REGION, "Region", { featuredArea: { target: AREA, multiple: false }, zones: { target: ZONE, multiple: true } }),
		Area: shapeWith(AREA, "Area", { f: { target: REGION, multiple: false } }),
		Zone: shapeWith(ZONE, "Zone", { bF: { target: REGION, multiple: false } }),
	},
	[
		entryRow(REGION, "r1", { featuredArea: link(AREA, ["a1"], false), zones: link(ZONE, ["z1"], true) }),
		entryRow(AREA, "a1", { f: link(REGION, ["r1"], false) }),
		entryRow(AREA, "a2", { f: link(REGION, ["r1"], false) }),
		entryRow(ZONE, "z1", { bF: link(REGION, ["r1"], false) }),
	],
	{ shapes: { Region: { collection: "zz" }, Area: { collection: "zz_yy" }, Zone: { collection: "zz_zz" } }, fields: { "Zone.bF": { slug: "yy_f" } } },
);

test("relation-slugs-stay-unique-across-collections", () => {
	const relations: Json[] = clash.seed.relations;
	const slugs = relations.map((r) => r.slug);
	assert.equal(new Set(slugs).size, slugs.length, `relation slugs repeat: ${slugs.join(", ")}`);
	const pair = relations.find((r) => r.parentCollection === "zz_zz");
	const declared = relations.find((r) => r.parentCollection === "zz" && r.childCollection === "zz_yy");
	assert.ok(pair && declared, JSON.stringify(relations));
	assert.equal(pair.slug, "zz_zz_yy_f");
	assert.deepEqual(field(clash.seed, "zz_yy", "f")?.validation, { relation: declared.slug });
	assert.equal(field(clash.seed, "zz", "zones")?.validation?.relation, pair.slug);
	assert.deepEqual(linksOf(clash.seed, "zz_yy", "f"), ["a1 r1", "a2 r1"]);
	assert.deepEqual(linksOf(clash.seed, "zz_zz", "yy_f"), ["z1 r1"]);
});
