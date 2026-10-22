#!/usr/bin/env node
/**
 * ts2emdash: convert a TakeShape project export into an EmDash seed file.
 *
 *   node ts2emdash.mts <export-dir> [options]
 *
 * <export-dir> is the unzipped TakeShape project export (the folder that holds
 * schema.json and data.jsonl). Run this from inside your new EmDash project so
 * it can use EmDash's own Markdown to Portable Text converter.
 *
 * Options
 *   --out <file>              Seed file to write        (default: seed/takeshape.seed.json)
 *   --report <file>           Migration report to write (default: takeshape-migration-report.md)
 *   --field-map <file>        Field map to write (default: takeshape-field-map.json next to --out)
 *   --config <file>           Optional overrides (skip or rename shapes and fields)
 *   --download-assets <dir>   Also download every TakeShape asset into <dir> as a backup
 *   --taxonomies-as-collections  Keep TakeShape taxonomy shapes as collections
 *   --no-legacy-fields        Skip the takeshape_id, takeshape_published_at, takeshape_created_at and takeshape_updated_at fields
 *   --preload-media local     Download every image and file once, into --uploads-dir and
 *                             --database, before the import. Safe to rerun; see the guide.
 *   --media-ledger <file>     Record of preloaded media (default: takeshape-media.db next to --out)
 *   --database <file>         EmDash database the preload writes to (default: ./data.db)
 *   --uploads-dir <dir>       EmDash uploads folder the preload writes to (default: ./uploads)
 *   --media-concurrency <n>   Downloads at a time during the preload (default: 8)
 *   --site <dir|tsg.yml>      A takeshape-ssg site: entries behind its routes get the slug its URLs used
 *                             (needs the tsg2astro folder next to this script)
 *
 * Requires Node 22.18+ (it runs TypeScript directly) and the emdash package in the project.
 */

import { readFile, writeFile, mkdir, readdir, stat, rename, rm } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Kysely } from "kysely";
import type { FieldType, MediaRepository, SeedCollection, SeedContentEntry, SeedField, SeedFile, SeedTaxonomy, SeedTaxonomyTerm, Storage } from "emdash";
// Type-only, so this script still runs on its own, without the tsg2astro folder
import type { PTBlock, PTMarkDef, RichTextSidecar, RichTextSidecarEntry } from "./tsg2astro/runtime/portable-text.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// TakeShape export format, as observed in real exports
interface TSProperty {
	type?: string;
	title?: string;
	format?: string;
	enum?: unknown[];
	$ref?: string;
	items?: TSProperty;
	"@mapping"?: string;
	"@resolver"?: unknown;
	"@relationship"?: { shapeIds?: unknown[]; type?: string; relatedName?: string };
	"@tag"?: string;
	// Schemas from 3.18 on: a relationship is a getRelated resolver with `@ref` (or `oneOf` refs)
	"@ref"?: string;
	oneOf?: TSProperty[];
	"@backreference"?: { enabled?: boolean; name?: string };
	"@input"?: unknown;
	"@args"?: unknown;
	"@output"?: TSProperty;
}
interface TSShape {
	id?: string;
	title?: string;
	description?: string;
	model?: { type?: string };
	schema?: { properties?: Record<string, TSProperty>; required?: string[] };
}
interface TSFormNode {
	widget?: string;
	order?: string[];
	properties?: Record<string, TSFormNode>;
}
interface TSSchema {
	projectId?: string;
	projectName?: string;
	shapes?: Record<string, TSShape>;
	forms?: Record<string, { default?: TSFormNode }>;
	locales?: string[];
	defaultLocale?: string;
	workflows?: unknown;
}
/** One line of data.jsonl. Field values sit under storage keys, so the rest stays open. */
interface TSRow {
	_id: string;
	_shapeId?: string;
	_contentTypeId?: string;
	_enabled?: boolean;
	_status?: string;
	_enabledAt?: string;
	_createdAt?: string;
	_updatedAt?: string;
	[storageKey: string]: unknown;
}
type JsonObject = Record<string, unknown>;

// --config overrides
interface ShapeOverride {
	skip?: boolean;
	as?: "collection" | "taxonomy";
	collection?: string;
	name?: string;
}
interface FieldOverride {
	skip?: boolean;
	slug?: string;
}
interface Overrides {
	shapes?: Record<string, ShapeOverride>;
	fields?: Record<string, FieldOverride>;
}

interface Asset {
	id: string;
	path: string;
	filename: string;
	mimeType: string;
	isImage: boolean;
	title?: string;
	description?: string;
	caption: string;
	url: string;
}
interface MediaInfo {
	url: string;
	filename?: string;
	alt?: string;
	caption?: string;
	/** TakeShape's asset title, which EmDash's $media ignores and the preload keeps in meta. */
	title?: string;
}
/** EmDash downloads a $media URL when the seed is applied. */
interface MediaRef {
	$media: MediaInfo;
}
/** One image or file the media preload downloads: a TakeShape asset, or a TakeShape URL with no asset behind it. */
interface MediaSource {
	key: string; // "asset:<id>" or "url:<url>"
	fetchUrl: string;
	filename: string;
	alt?: string;
	caption?: string;
	exportMimeType?: string;
}
interface SourceUse {
	source: MediaSource;
	usedBy: Set<string>; // "<collection>/<slug or id>"
}
/** What the seed needs to point at a preloaded media row. */
interface LedgerEntry {
	mediaId: string;
	storageKey: string;
	filename: string;
	mimeType: string;
	width?: number;
	height?: number;
	alt?: string; // the row's alt; a $media reference's own alt wins over it
}
interface PreloadResult {
	entries: Map<string, LedgerEntry>; // by source key, successful sources only
	downloaded: number;
	present: number;
	refreshed: number;
	bytes: number;
	failed: { use: SourceUse; error: string }[];
	unused: string[]; // storage keys a refreshed source left behind (its file type changed)
}
/** The preload's own SQLite file: EmDash's tables plus takeshape_media_sources. */
interface Ledger {
	db: Kysely<any>;
	media: MediaRepository;
	close(): Promise<void>;
}
/** Draft.js raw content as TakeShape stores it. Offsets count Unicode code points. */
interface DraftBlock {
	key?: string;
	type?: string;
	text?: string;
	depth?: number;
	inlineStyleRanges?: { offset?: number; length?: number; style?: string }[];
	entityRanges?: { offset?: number; length?: number; key?: string | number }[];
	data?: JsonObject;
}
interface DraftEntity {
	type?: string;
	data?: JsonObject;
}
interface DraftRaw {
	blocks: DraftBlock[];
	entityMap: Record<string, DraftEntity>;
}
// Portable Text and the rich-text sidecar are defined next to the renderer
// that reads them, in the folder migrated sites get. Exported here too for
// the tests and older callers.
export type { PTBlock, RichTextSidecar, RichTextSidecarEntry };

// How each TakeShape property becomes an EmDash field
type FieldKind = "scalar" | "draft" | "draftText" | "markdown" | "asset" | "assetList" | "reference" | "taxonomy" | "repeater" | "json" | "entrySlug" | "legacyId" | "legacyDate" | "legacyCreated" | "legacyUpdated" | "richTextSidecar" | "termOrder" | "linkOrder";
interface FieldPlan {
	prop: string;
	path: string[];
	slug: string;
	label: string;
	widget: string;
	kind: FieldKind;
	/** EmDash field type; "taxonomy" fields become term assignments, not columns */
	type: FieldType | "taxonomy";
	sub?: string;
	note?: string;
	taxonomy?: string;
	targetShape?: string;
	target?: string;
	multiple?: boolean;
	schemaShape?: string | null;
	subPlans?: FieldPlan[];
	inlineName?: string;
	options?: string[];
	searchable?: boolean;
	relation?: string;
	relatedName?: string;
	inverseOf?: RefField;
	/** Not a TakeShape property: this field declares the links of that one, which point forward in seed order */
	declares?: RefField;
}
interface PlanBase {
	id: string;
	name: string;
	shape: TSShape;
	count: number;
	fields: FieldPlan[];
}
interface TaxonomyPlan extends PlanBase {
	kind: "taxonomy";
	labelProp?: string;
	slugProp?: string | null;
	taxonomy: string;
	terms: SeedTaxonomyTerm[];
}
interface CollectionPlan extends PlanBase {
	kind: "collection";
	slug: string;
	routable: boolean;
	slugFrom?: FieldPlan;
	titleField?: FieldPlan;
	entries: SeedContentEntry[];
	published: number;
}
type ShapePlan = TaxonomyPlan | CollectionPlan;

// ---------------------------------------------------------------------------
// Field map: written next to the seed so tools that read TakeShape data by
// property name (tsg2astro) can find the EmDash collection and field.
// ---------------------------------------------------------------------------

export type LegacyFields = { id: "takeshape_id"; publishedAt: "takeshape_published_at"; createdAt: "takeshape_created_at"; updatedAt: "takeshape_updated_at" };
export type PropertyMapEntry =
	| { kind: "scalar"; field: string; type: string }
	| { kind: "richText"; field: string; format: "draftjs" | "markdown" }
	| { kind: "richTextPlain"; field: string }
	| { kind: "asset"; field: string; multiple: boolean }
	| { kind: "reference"; field: string; target: string; multiple: boolean; relation: string | null }
	| { kind: "taxonomy"; taxonomy: string; target: string; multiple: boolean }
	| { kind: "object"; properties: Record<string, PropertyMapEntry> }
	| { kind: "repeater"; field: string; properties: Record<string, PropertyMapEntry> }
	| { kind: "json"; field: string }
	| { kind: "entrySlug" }
	| { kind: "skipped"; reason: string };
export type ShapeMapEntry =
	| {
			kind: "collection";
			shapeId: string;
			collection: string;
			/** For reading only: tsg2astro takes single shapes from the export's schema. */
			single: boolean;
			legacy: LegacyFields | null;
			richTextSidecar: "takeshape_rich_text" | null;
			/** Missing in maps written before it existed: read that as null. */
			termOrder?: "takeshape_term_order" | null;
			/** Missing in maps written before it existed: read that as null. */
			linkOrder?: "takeshape_link_order" | null;
			properties: Record<string, PropertyMapEntry>;
			/** For reading only: tsg2astro takes reverse fields from the export's schema (tsg2astro/schema.mts). */
			reverse: Record<string, { shape: string; property: string }>;
	  }
	| { kind: "taxonomy"; shapeId: string; taxonomy: string; labelProperty: string; slugProperty: string | null }
	| { kind: "skipped"; shapeId: string; reason: string };
export type FieldMap = { version: 1; shapes: Record<string, ShapeMapEntry> };
interface RefField {
	plan: CollectionPlan;
	f: FieldPlan;
}
// emdash exports SeedFile but not the type of one relation in it
type SeedRelation = NonNullable<SeedFile["relations"]>[number];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const opts: {
	out: string;
	report: string;
	fieldMap: string | null;
	config: string | null;
	downloadAssets: string | null;
	taxonomiesAsCollections: boolean;
	legacyFields: boolean;
	preloadMedia: "local" | null;
	mediaLedger: string | null;
	database: string;
	uploadsDir: string;
	mediaConcurrency: number;
	site: string | null;
} = {
	out: "seed/takeshape.seed.json",
	report: "takeshape-migration-report.md",
	fieldMap: null,
	config: null,
	downloadAssets: null,
	taxonomiesAsCollections: false,
	legacyFields: true,
	preloadMedia: null,
	mediaLedger: null,
	database: "./data.db",
	uploadsDir: "./uploads",
	mediaConcurrency: 8,
	site: null,
};
let exportDir: string | null = null;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--out") opts.out = args[++i];
	else if (a === "--report") opts.report = args[++i];
	else if (a === "--field-map") opts.fieldMap = args[++i];
	else if (a === "--config") opts.config = args[++i];
	else if (a === "--download-assets") opts.downloadAssets = args[++i];
	else if (a === "--taxonomies-as-collections") opts.taxonomiesAsCollections = true;
	else if (a === "--no-legacy-fields") opts.legacyFields = false;
	else if (a === "--preload-media") {
		const mode = args[++i];
		if (mode === "r2") fail("R2 mode is not available yet. Use --preload-media local.");
		if (mode !== "local") fail(`--preload-media takes local, got ${mode ?? "nothing"}`);
		opts.preloadMedia = mode;
	} else if (a === "--media-ledger") opts.mediaLedger = args[++i];
	else if (a === "--database") opts.database = args[++i];
	else if (a === "--uploads-dir") opts.uploadsDir = args[++i];
	else if (a === "--media-concurrency") {
		const n = Number(args[++i]);
		if (!Number.isInteger(n) || n < 1) fail("--media-concurrency takes a whole number of 1 or more");
		opts.mediaConcurrency = n;
	} else if (a === "--site") {
		const v = args[++i];
		if (!v) fail("--site takes the folder of your takeshape-ssg site, or its tsg.yml");
		opts.site = v;
	} else if (a === "-h" || a === "--help") {
		console.log(
			"Usage: node ts2emdash.mts <export-dir> [--out seed.json] [--report report.md] [--field-map map.json] [--config overrides.json] [--download-assets dir] [--taxonomies-as-collections] [--no-legacy-fields] [--preload-media local] [--media-ledger file] [--database file] [--uploads-dir dir] [--media-concurrency n] [--site dir|tsg.yml]",
		);
		process.exit(0);
	} else if (!a.startsWith("--") && !exportDir) exportDir = a;
	else fail(`Unknown option: ${a}`);
}
if (!exportDir) fail("Pass the path to your unzipped TakeShape export. Run with --help for options.");

function fail(msg: string): never {
	console.error(`ts2emdash: ${msg}`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Converters (EmDash's own for Markdown; Draft.js is converted below)
// ---------------------------------------------------------------------------

async function load<T>(spec: string, name: string): Promise<T> {
	try {
		return await import(spec);
	} catch {
		fail(`Could not load ${spec}. Run this from your EmDash project and install it: npm i -D ${name}`);
	}
}
const { markdownToPortableText } = await load<typeof import("emdash/client")>("emdash/client", "emdash");
// EmDash's own reserved names, so a shape called User or a field called status never collides
const emdashCore: Partial<typeof import("emdash")> = await import("emdash").catch(() => ({}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ASSET_BASE = "https://assets.takeshape.io";
const TS_HOST = /^https?:\/\/(images|assets)\.takeshape\.io\//i;
// EmDash's search writes field names into its FTS5 table and triggers unquoted, so one of these as a column fails to
// enable search for its whole collection (a field named `references`: `near "references": syntax error`). The names
// that failed EmDash 1.3.0's fts-manager statements, run for every SQLite keyword, plus FTS5's own rowid and rank.
const FTS_UNSAFE = new Set<string>([
	"add", "all", "alter", "and", "as", "autoincrement", "between", "case", "check", "collate", "commit", "constraint",
	"create", "default", "deferrable", "delete", "distinct", "drop", "else", "escape", "except", "exists", "foreign",
	"from", "group", "having", "in", "index", "insert", "intersect", "into", "is", "isnull", "join", "limit", "not",
	"nothing", "notnull", "null", "on", "or", "order", "primary", "rank", "references", "returning", "rowid", "select",
	"set", "table", "then", "to", "transaction", "union", "unique", "update", "using", "values", "when", "where",
]);
const RESERVED = new Set<string>([
	...(emdashCore.RESERVED_FIELD_SLUGS ?? [
		"id", "slug", "status", "author_id", "primary_byline_id", "created_at", "updated_at",
		"published_at", "scheduled_at", "deleted_at", "version", "live_revision_id",
		"draft_revision_id", "terms", "bylines", "byline",
	]),
]);
const RESERVED_COLLECTIONS = new Set<string>(emdashCore.RESERVED_COLLECTION_SLUGS ?? [
	"content", "media", "users", "revisions", "taxonomies", "options", "audit_logs", "reorder", "relations",
]);
const REPEATER_TYPES = new Set<string>(["string", "text", "url", "number", "integer", "boolean", "datetime", "select", "image"]);
// Storage keys of TakeShape's built-in Asset shape, used when schema.json omits it.
const ASSET_KEYS: Record<string, string> = {
	path: "Hk6FQuz5", filename: "H1oYQOM9", mimeType: "SyCYX_Gq", title: "By5tQOMc",
	description: "B1Zsra3fx", caption: "SyWVsd98x", credit: "Skn_i_5Ll", sourceUrl: "SJXSidnXE",
};

// ---------------------------------------------------------------------------
// Report bookkeeping
// ---------------------------------------------------------------------------

const report = {
	taxonomies: [] as { shape: string; name: string; terms: number; collections: string[] }[],
	skippedShapes: [] as { shape: string; reason: string }[],
	skippedFields: [] as { shape: string; prop: string; reason: string }[],
	warnings: [] as string[],
	tsLinks: new Map<string, Set<string>>(), // url -> where it appears
	// Draft.js content kept as TakeShape printed it, without converting the entity
	inlineEntities: new Map<string, number>(), // entity type inside a text block, text kept -> ranges
	fallbackBlocks: new Map<string, number>(), // atomic entity type kept as TakeShape's fallback HTML -> blocks
	missingImages: 0, // atomic images whose asset is not in the export, kept as TakeShape's fallback HTML
	nestedBlocks: 0, // non-list blocks TakeShape nested under a list item, now at the top level
	droppedStyles: new Map<string, number>(), // Draft.js inline style with no EmDash mark -> ranges
	unresolved: [] as { where: string; target: string }[],
	assets: { total: 0, images: 0, files: 0, referenced: new Set<string>() },
};
const warn = (m: string) => report.warnings.push(m);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const snake = (s: string) =>
	String(s)
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase()
		.replace(/^(\d)/, "f_$1") || "field";
const UNCOUNTABLE = /(^|_)(media|data|content|news|info|information|equipment|series|software|feedback|staff)$/;
const plural = (s: string) =>
	UNCOUNTABLE.test(s) ? s : /(s|x|z|ch|sh)$/.test(s) ? `${s}es` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`;
const singular = (s: string) =>
	/ies$/.test(s) ? `${s.slice(0, -3)}y` : /(ses|xes|zes|ches|shes)$/.test(s) ? s.slice(0, -2) : /[^s]s$/.test(s) ? s.slice(0, -1) : s;
const slugify = (s: unknown) =>
	String(s ?? "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 96);
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const isObj = (v: unknown): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v);
const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const storageKey = (prop: TSProperty | undefined) => {
	const m = typeof prop?.["@mapping"] === "string" && prop["@mapping"].match(/\.([^.]+)$/);
	return m ? m[1] : null;
};
/** Where a property is stored: its @mapping's key, else its own name (TakeShape's source does the same), unless a service resolves it. */
const keyOf = (name: string, prop: TSProperty | undefined): string | null => storageKey(prop) ?? (prop && !prop["@resolver"] && !prop["@relationship"] ? name : null);
const refShapeName = (prop: TSProperty | undefined) => {
	const r = prop?.$ref || prop?.items?.$ref;
	const m = typeof r === "string" && r.match(/^#\/shapes\/([^/]+)\/schema$/);
	return m && m[1] !== "TSRelationship" ? m[1] : null;
};

/**
 * Exports from schema 3.18 on describe a relationship as a getRelated resolver (`shapedb:getRelated`, earlier
 * `takeshape:getRelated`) with `@ref: "local:Author"` (or `oneOf` refs), on `items` for a list. This rewrites each
 * one into the form older exports use, `@relationship: { shapeIds, type, relatedName }` on a TSRelationship
 * `$ref`, which the rest of the converter reads. TakeShape's own source converts between the two the same way.
 * An inline object written as `@ref` gets the `$ref` form too.
 */
function legacyRelationships(schema: TSSchema): TSSchema {
	const shapes = schema.shapes ?? {};
	const idOf = (ref: unknown): string | undefined => {
		const name = typeof ref === "string" ? ref.replace(/^local:/, "") : "";
		return shapes[name]?.id ?? (name === "Asset" ? "ASSET" : undefined);
	};
	const fix = (prop: TSProperty) => {
		const p = prop["@output"] ?? prop;
		const resolver = isObj(p["@resolver"]) ? p["@resolver"].name : undefined;
		if (resolver === "shapedb:getRelated" || resolver === "takeshape:getRelated") {
			const node = p.items ?? p;
			const refs = node.oneOf ? node.oneOf.map((o) => o["@ref"]) : [node["@ref"]];
			const multiple = p.type === "array";
			const relationship: NonNullable<TSProperty["@relationship"]> = { shapeIds: refs.map(idOf).filter((id) => id !== undefined), type: multiple ? "multiple" : "single" };
			if (prop["@backreference"]?.name) relationship.relatedName = prop["@backreference"].name;
			for (const k of ["@ref", "oneOf", "@resolver", "@input", "@args", "@output", "items", "$ref"] as const) delete prop[k];
			prop["@relationship"] = relationship;
			if (multiple) {
				prop.type = "array";
				prop.items = { $ref: "#/shapes/TSRelationship/schema" };
			} else prop.$ref = "#/shapes/TSRelationship/schema";
			return;
		}
		for (const node of [prop, prop.items]) {
			const name = typeof node?.["@ref"] === "string" ? node["@ref"].replace(/^local:/, "") : undefined;
			if (node && name && shapes[name] && !node.$ref) node.$ref = `#/shapes/${name}/schema`;
		}
	};
	for (const shape of Object.values(shapes)) for (const prop of Object.values(shape.schema?.properties ?? {})) fix(prop);
	return schema;
}

async function findFile(dir: string, name: string, depth = 3): Promise<string | null> {
	const direct = join(dir, name);
	if (existsSync(direct)) return direct;
	if (depth === 0) return null;
	for (const entry of await readdir(dir)) {
		const p = join(dir, entry);
		if ((await stat(p)).isDirectory()) {
			const hit = await findFile(p, name, depth - 1);
			if (hit) return hit;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Load the export
// ---------------------------------------------------------------------------

let root = resolve(exportDir!);
if (!existsSync(root)) fail(`${root} does not exist.`);
if (/\.zip$/i.test(root)) {
	// Unzip next to the archive with whatever the OS provides (unzip, or tar on macOS and Windows)
	const { execFileSync } = await import("node:child_process");
	const target = root.replace(/\.zip$/i, "");
	await mkdir(target, { recursive: true });
	try {
		execFileSync("unzip", ["-oq", root, "-d", target], { stdio: "ignore" });
	} catch {
		try {
			execFileSync("tar", ["-xf", root, "-C", target], { stdio: "ignore" });
		} catch {
			fail(`Could not unzip ${root}. Unzip it yourself and pass the folder instead.`);
		}
	}
	root = target;
}
const schemaPath = await findFile(root, "schema.json");
const dataPath = await findFile(root, "data.jsonl");
if (!schemaPath) fail(`No schema.json found under ${root}. Unzip the TakeShape export first.`);
if (!dataPath) fail(`No data.jsonl found under ${root}. Export the project with its data (not an empty export).`);

const schema: TSSchema = legacyRelationships(JSON.parse(await readFile(schemaPath, "utf8")));
const rows: TSRow[] = (await readFile(dataPath, "utf8"))
	.split("\n")
	.filter((l) => l.trim())
	.map((l, n): TSRow | null => {
		try {
			return JSON.parse(l);
		} catch {
			warn(`data.jsonl line ${n + 1} is not valid JSON and was skipped.`);
			return null;
		}
	})
	.filter((r): r is TSRow => Boolean(r));

// Slugs that keep the old site's URLs. The helper loads only when --site is given, so this
// script still runs on its own as a single file.
let siteSlugs = new Map<string, string>();
const siteSlugNotes: string[] = [];
const siteSlugChanges: { collection: string; from: string; to: string }[] = [];
if (opts.site) {
	let helper: typeof import("./tsg2astro/site-slugs.mts");
	try {
		helper = await import(new URL("./tsg2astro/site-slugs.mts", import.meta.url).href);
	} catch (e) {
		fail(`--site needs the tsg2astro folder next to ts2emdash.mts, with its packages installed (npm i -D js-yaml json-variables lodash graphql slugg): ${e instanceof Error ? e.message : String(e)}`);
	}
	try {
		const result = await helper.computeSiteSlugs(resolve(opts.site), { schema, rows });
		siteSlugs = result.slugs;
		siteSlugNotes.push(...result.notes);
	} catch (e) {
		fail(`Could not read the site at ${opts.site}: ${e instanceof Error ? e.message : String(e)}`);
	}
}
const reservedSiteSlugs = new Set(siteSlugs.values());
// Shapes with entries that had pages: their other entries step around every page's slug, since routes of several
// collections can share URLs (/:slug/). A collection without pages only keeps its own slugs apart.
const shapesWithPages = new Set(rows.filter((r) => siteSlugs.has(r._id)).map((r) => r._shapeId ?? r._contentTypeId));

const config: Overrides = opts.config ? JSON.parse(await readFile(opts.config, "utf8")) : {};
const shapeCfg = (name: string): ShapeOverride => config.shapes?.[name] ?? {};
const fieldCfg = (shape: string, prop: string): FieldOverride => config.fields?.[`${shape}.${prop}`] ?? {};

const shapes = schema.shapes ?? {};
const shapeById = new Map<string, TSShape>();
const shapeByName = new Map<string, TSShape>();
for (const [name, s] of Object.entries(shapes)) {
	shapeByName.set(name, s);
	if (s.id) shapeById.set(s.id, s);
}
const forms = schema.forms ?? {};
const locales = schema.locales ?? [];
const defaultLocale = schema.defaultLocale ?? locales[0];
if (locales.length > 1) {
	warn(`The project has ${locales.length} locales (${locales.join(", ")}). Only ${defaultLocale} values are migrated; add translations in EmDash after configuring i18n.`);
}

const rowShapeId = (r: TSRow) => r._shapeId ?? r._contentTypeId;
const rowsById = new Map(rows.map((r) => [r._id, r]));

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

const assetShape = shapeById.get("ASSET") ?? shapeByName.get("Asset");
const assetKey = (name: string) => storageKey(assetShape?.schema?.properties?.[name]) ?? ASSET_KEYS[name];
const assets = new Map<string, Asset>();
// TakeShape's own export writes {{PROJECT_ID}} where an asset path starts with the project id; each row keeps the id
const projectPlaceholder = "{{PROJECT_ID}}";
let pathsWithoutProject = 0;
for (const r of rows) {
	if (rowShapeId(r) !== "ASSET") continue;
	let path = str(r[assetKey("path")]);
	if (!path) continue;
	const projectId = str(r._projectId) ?? schema.projectId;
	if (path.includes(projectPlaceholder)) {
		if (projectId) path = path.replaceAll(projectPlaceholder, projectId);
		else pathsWithoutProject++;
	}
	const mimeType = str(r[assetKey("mimeType")]) ?? "";
	const isImage = mimeType.startsWith("image/");
	const caption = draftPlainText(r[assetKey("caption")]);
	assets.set(r._id, {
		id: r._id,
		path,
		filename: str(r[assetKey("filename")]) ?? path.split("/").pop() ?? path,
		mimeType,
		isImage,
		title: str(r[assetKey("title")]),
		description: str(r[assetKey("description")]),
		caption,
		// Original bytes. images.takeshape.io (imgix) recompresses, often to JPEG.
		url: `${ASSET_BASE}/${escapePath(path)}`,
	});
}
if (pathsWithoutProject) warn(`${pathsWithoutProject} asset path(s) start with ${projectPlaceholder} and the export does not say which project, so those files cannot be downloaded.`);
report.assets.total = assets.size;
report.assets.images = [...assets.values()].filter((a) => a.isImage).length;
report.assets.files = assets.size - report.assets.images;

const assetAlt = (a: Asset) => {
	const alt = a.description || a.title || a.caption;
	return alt ? String(alt).slice(0, 500) : undefined;
};

function mediaFor(assetId: unknown): MediaRef | null {
	const a = typeof assetId === "string" ? assets.get(assetId) : undefined;
	if (!a) return null;
	report.assets.referenced.add(a.id);
	const media: MediaInfo = { url: a.url, filename: a.filename };
	const alt = assetAlt(a);
	if (alt) media.alt = alt;
	if (a.caption) media.caption = a.caption;
	// EmDash keeps no title on an image; the preload puts it in the value's meta, where loaders read it
	if (a.title) media.title = String(a.title);
	return { $media: media };
}

// ---------------------------------------------------------------------------
// Rich text
// ---------------------------------------------------------------------------

function parseDraft(v: unknown): DraftRaw | null {
	if (v === null || v === undefined || v === "") return null;
	let raw = v;
	if (typeof v === "string") {
		try {
			raw = JSON.parse(v);
		} catch {
			return null;
		}
	}
	if (!isObj(raw) || !Array.isArray(raw.blocks)) return null;
	return { blocks: raw.blocks.filter(isObj) as DraftBlock[], entityMap: (isObj(raw.entityMap) ? raw.entityMap : {}) as Record<string, DraftEntity> };
}

function draftPlainText(v: unknown): string {
	const raw = parseDraft(v);
	if (!raw) return typeof v === "string" ? v : "";
	return raw.blocks.map((b) => String(b.text ?? "")).join("\n").trim();
}

// Draft.js to Portable Text, block for block, following TakeShape's own
// renderer. The migrated site renders these blocks back into the HTML
// TakeShape printed, so they keep everything that HTML depends on, and the
// sidecar holds what a block cannot.

// Inline styles that become EmDash marks, in TakeShape's nesting order (innermost first)
const DRAFT_MARKS: [style: string, mark: string][] = [
	["BOLD", "strong"], ["ITALIC", "em"], ["UNDERLINE", "underline"], ["STRIKETHROUGH", "strike-through"],
	["CODE", "code"], ["SUB", "subscript"], ["SUP", "superscript"],
];
// The tags TakeShape printed for them. Captions and credits only had the first five.
const DRAFT_TAGS: [style: string, tag: string][] = [
	["BOLD", "strong"], ["ITALIC", "em"], ["UNDERLINE", "ins"], ["STRIKETHROUGH", "del"], ["CODE", "code"],
	["SMALL", "small"], ["SUB", "sub"], ["SUP", "sup"],
];
const DRAFT_HEADINGS = new Map([
	["header-one", "h1"], ["header-two", "h2"], ["header-three", "h3"], ["header-four", "h4"], ["header-five", "h5"], ["header-six", "h6"],
]);
// Entity data keys TakeShape printed as attributes, plus any data-* key
const LINK_ATTRS = new Map([["url", "href"], ["href", "href"], ["rel", "rel"], ["target", "target"], ["title", "title"], ["className", "class"]]);
const IMAGE_ATTRS = new Map([["src", "src"], ["height", "height"], ["width", "width"], ["alt", "alt"], ["className", "class"]]);

type PTSpan = { _type: "span"; _key: string; text: string; marks: string[] };
/** One block's text with the entity and the inline styles of each UTF-16 unit. */
interface DraftChars {
	text: string;
	styles: string[][];
	entities: (string | null)[];
}

const listOf = <T,>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
const entityData = (e: DraftEntity | undefined): JsonObject => (isObj(e?.data) ? e.data : {});

/** The UTF-16 index of code point `cp` in `text`, clamped to its end. Draft.js offsets count code points. */
function utf16Index(text: string, cp: number): number {
	let i = 0;
	for (let n = 0; n < cp && i < text.length; n++) {
		const high = text.charCodeAt(i);
		const pair = high >= 0xd800 && high <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
		i += pair ? 2 : 1;
	}
	return i;
}

function draftRange(text: string, r: { offset?: number; length?: number }): [number, number] {
	const offset = Math.max(0, Number(r?.offset) || 0);
	const length = Number(r?.length) || 0;
	return length > 0 ? [utf16Index(text, offset), utf16Index(text, offset + length)] : [0, 0];
}

function draftChars(b: DraftBlock, entityMap: Record<string, DraftEntity>): DraftChars {
	const text = String(b.text ?? "");
	// Styles keep the order they were added in: TakeShape's exporter splits runs whose order differs
	const styles: string[][] = Array.from({ length: text.length }, () => []);
	for (const r of listOf(b.inlineStyleRanges)) {
		const style = String(r?.style ?? "");
		const [start, end] = draftRange(text, r);
		for (let i = start; i < end; i++) if (!styles[i].includes(style)) styles[i].push(style);
	}
	const entities: (string | null)[] = new Array(text.length).fill(null);
	for (const r of listOf(b.entityRanges)) {
		const key = String(r?.key);
		if (!Object.hasOwn(entityMap, key)) continue;
		const [start, end] = draftRange(text, r);
		for (let i = start; i < end; i++) entities[i] = key;
	}
	return { text, styles, entities };
}

/** Runs of text with one entity and one set of styles, split where TakeShape's exporter split them. */
function draftPieces({ text, styles, entities }: DraftChars) {
	const same = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i]);
	const pieces: { start: number; end: number; entity: string | null; styles: string[] }[] = [];
	let start = 0;
	for (let i = 1; i <= text.length; i++) {
		if (i < text.length && entities[i] === entities[start] && same(styles[i], styles[start])) continue;
		pieces.push({ start, end: i, entity: entities[start], styles: styles[start] });
		start = i;
	}
	return pieces;
}

/** The attributes TakeShape printed for an entity: data keys in order, the last one mapped to a name wins. */
function draftAttrs(names: Map<string, string>, data: JsonObject): [string, string][] {
	const attrs = new Map<string, unknown>();
	for (const [k, v] of Object.entries(data)) {
		const name = names.get(k) ?? (/^data-[a-z0-9-]+$/.test(k) ? k : undefined);
		if (name) attrs.set(name, v);
	}
	return [...attrs].filter(([, v]) => v).map(([k, v]) => [k, String(v)]);
}

/** TakeShape's own HTML for a block's content, for blocks kept as HTML. */
function draftInlineHtml(chars: DraftChars, entityMap: Record<string, DraftEntity>, tags: [string, string][]): string {
	if (!chars.text) return "<br>";
	const t = chars.text;
	let text = "";
	for (let i = 0; i < t.length; i++) text += t[i] === " " && (i === 0 || i === t.length - 1 || t[i - 1] === " ") ? "\xA0" : t[i];
	const encode = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\xA0/g, "&nbsp;").replace(/\n/g, "<br>\n");
	const attrs = (list: [string, string][]) => list.map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
	const pieces = draftPieces(chars);
	let html = "";
	for (let i = 0; i < pieces.length; ) {
		const key = pieces[i].entity;
		let content = "";
		for (; i < pieces.length && pieces[i].entity === key; i++) {
			let piece = encode(text.slice(pieces[i].start, pieces[i].end));
			for (const [style, tag] of tags) if (pieces[i].styles.includes(style)) piece = `<${tag}>${piece}</${tag}>`;
			content += piece;
		}
		const entity = key ? entityMap[key] : undefined;
		const type = String(entity?.type ?? "").toUpperCase();
		if (type === "LINK") html += `<a${attrs(draftAttrs(LINK_ATTRS, entityData(entity)))}>${content}</a>`;
		else if (type === "IMAGE") html += `<img${attrs(draftAttrs(IMAGE_ATTRS, entityData(entity)))}/>`;
		else html += content;
	}
	return html;
}

function linkMarkDef(key: string, data: JsonObject, where: string): PTMarkDef {
	const attrs = draftAttrs(LINK_ATTRS, data);
	const attr = (name: string) => attrs.find(([k]) => k === name)?.[1];
	const def: PTMarkDef = { _type: "link", _key: key, href: attr("href") ?? "", blank: attr("target") === "_blank" };
	for (const [name, field] of [["target", "tsTarget"], ["title", "tsTitle"], ["rel", "tsRel"], ["class", "tsClass"]]) {
		const v = attr(name);
		if (v) def[field] = v;
	}
	const dataAttrs = attrs.filter(([k]) => k.startsWith("data-"));
	if (dataAttrs.length) def.tsData = Object.fromEntries(dataAttrs);
	def.tsAttrOrder = attrs.map(([k]) => k);
	noteTakeShapeLink(String(def.href), where);
	return def;
}

/** A link into TakeShape's CDN stops working when TakeShape shuts down, so the report lists it. */
function noteTakeShapeLink(href: string, where: string) {
	if (!TS_HOST.test(href)) return;
	if (!report.tsLinks.has(href)) report.tsLinks.set(href, new Set());
	report.tsLinks.get(href)!.add(where);
}

function draftTextBlock(b: DraftBlock, type: string, key: string, chars: DraftChars, entityMap: Record<string, DraftEntity>, where: string, plain: boolean): PTBlock {
	const children: PTSpan[] = [];
	const markDefs: PTMarkDef[] = [];
	const linkKeys = new Map<string, string>();
	for (const p of draftPieces(chars)) {
		const marks = DRAFT_MARKS.filter(([style]) => p.styles.includes(style)).map(([, mark]) => mark);
		const entity = p.entity ? entityMap[p.entity] : undefined;
		if (p.entity && String(entity?.type ?? "").toUpperCase() === "LINK") {
			let k = linkKeys.get(p.entity);
			if (!k) {
				k = `${key}-l${linkKeys.size}`;
				linkKeys.set(p.entity, k);
				markDefs.push(linkMarkDef(k, entityData(entity), where));
			}
			marks.push(k);
		}
		children.push({ _type: "span", _key: `${key}-s${children.length}`, text: chars.text.slice(p.start, p.end), marks });
	}
	if (!children.length) children.push({ _type: "span", _key: `${key}-s0`, text: "", marks: [] });
	if (!plain) {
		// What a block cannot keep goes in the report. TakeShape printed only the text of an embed here.
		for (const r of listOf(b.inlineStyleRanges)) {
			const style = String(r?.style ?? "");
			if (!DRAFT_MARKS.some(([s]) => s === style)) report.droppedStyles.set(style, (report.droppedStyles.get(style) ?? 0) + 1);
		}
		for (const r of listOf(b.entityRanges)) {
			const k = String(r?.key);
			const t = Object.hasOwn(entityMap, k) ? String(entityMap[k]?.type ?? "") : null;
			if (t === null || /^(link|oembed)$/i.test(t)) continue;
			report.inlineEntities.set(t, (report.inlineEntities.get(t) ?? 0) + 1);
		}
	}
	const block: PTBlock = { _type: "block", _key: key, style: DRAFT_HEADINGS.get(type) ?? (type === "blockquote" || type === "pullquote" ? "blockquote" : "normal") };
	if (type === "unordered-list-item" || type === "ordered-list-item") {
		block.listItem = type === "unordered-list-item" ? "bullet" : "number";
		block.level = (Number(b.depth) || 0) + 1;
	}
	block.children = children;
	block.markDefs = markDefs;
	return block;
}

/** An atomic image with its asset: an EmDash image block, plus its size, caption and credit in the sidecar. */
function draftImage(key: string, asset: Asset, data: JsonObject, where: string): { block: PTBlock; entry: RichTextSidecarEntry } {
	report.assets.referenced.add(asset.id);
	const media: MediaInfo = { url: asset.url, filename: asset.filename };
	if (asset.description) media.alt = asset.description.slice(0, 500);
	const block: PTBlock = { _type: "image", _key: key, asset: { $media: media } };
	// TakeShape printed the asset's description as alt and its title as title
	if (asset.description) block.alt = asset.description;
	if (asset.title) block.title = asset.title;
	if (typeof data.alignment === "string" && data.alignment) block.alignment = data.alignment;
	const link = isObj(data.link) ? data.link : {};
	if (link.url) {
		block.link = { href: String(link.url), blank: Boolean(link.external) };
		noteTakeShapeLink(String(link.url), where);
	}
	const captionText = draftPlainText(data.caption);
	if (captionText) block.caption = captionText;
	const entry: RichTextSidecarEntry = { assetId: asset.id };
	if (typeof data.size === "string" && data.size) entry.size = data.size;
	if (captionText) entry.captionText = captionText;
	const caption = draftToPortableText(data.caption, `${where} (image caption)`, true)?.blocks;
	if (caption) entry.caption = caption;
	const credit = draftToPortableText(data.credit, `${where} (image credit)`, true)?.blocks;
	if (credit) entry.credit = credit;
	return { block, entry };
}

function draftAtomic(key: string, chars: DraftChars, entityMap: Record<string, DraftEntity>, where: string, plain: boolean): { block: PTBlock; entry?: RichTextSidecarEntry } {
	// TakeShape used the entity on the block's first character
	const entity = chars.entities[0] ? entityMap[chars.entities[0]] : undefined;
	const type = String(entity?.type ?? "");
	const data = entityData(entity);
	if (!plain && type === "image") {
		const asset = assets.get(String(data.id));
		if (asset) return draftImage(key, asset, data, where);
		report.missingImages++;
	} else if (!plain && type === "oembed") {
		return { block: { _type: "htmlBlock", _key: key, html: typeof data.html === "string" ? data.html : "" }, entry: { oembed: true } };
	} else if (!plain && entity) report.fallbackBlocks.set(type, (report.fallbackBlocks.get(type) ?? 0) + 1);
	// Anything else TakeShape printed as a figure holding the block's content
	const html = `<figure>${draftInlineHtml(chars, entityMap, plain ? DRAFT_TAGS.slice(0, 5) : DRAFT_TAGS)}</figure>`;
	return { block: { _type: "htmlBlock", _key: key, html } };
}

const isListItem = (b: DraftBlock) => b.type === "unordered-list-item" || b.type === "ordered-list-item";
const depthOf = (b: DraftBlock) => Number(b.depth) || 0;

/**
 * Blocks other than list items that TakeShape printed inside a list item.
 * Its exporter nested every block one level deeper than the list item before
 * it, whatever the block's type. Portable Text keeps a level only on list
 * items, so these now print at the top level.
 */
function nestedNonListBlocks(blocks: DraftBlock[]): number {
	let i = 0;
	let nested = 0;
	const walk = (inList: boolean) => {
		const b = blocks[i++];
		if (inList && !isListItem(b)) nested++;
		const next = blocks[i];
		if (isListItem(b) && next && depthOf(next) === depthOf(b) + 1) {
			const depth = depthOf(next);
			while (i < blocks.length && depthOf(blocks[i]) === depth) walk(true);
		}
	};
	while (i < blocks.length) walk(false);
	return nested;
}

/**
 * Draft.js rich text as Portable Text, plus a sidecar of what the blocks
 * cannot hold, keyed by block _key. Block keys are Draft.js's own. `plain`
 * converts an image caption or credit, which TakeShape printed without
 * pullquote, section-break, embed or image handling.
 */
function draftToPortableText(v: unknown, where: string, plain = false): { blocks: PTBlock[]; sidecar: Record<string, RichTextSidecarEntry> } | null {
	const raw = parseDraft(v);
	// TakeShape printed nothing for one empty block
	if (!raw?.blocks.length || (raw.blocks.length === 1 && !String(raw.blocks[0].text ?? ""))) return null;
	report.nestedBlocks += nestedNonListBlocks(raw.blocks);
	const blocks: PTBlock[] = [];
	const sidecar: Record<string, RichTextSidecarEntry> = {};
	const usedKeys = new Set<string>();
	raw.blocks.forEach((b, i) => {
		const base = typeof b.key === "string" && b.key ? b.key : `b${i}`;
		let key = base;
		for (let n = 2; usedKeys.has(key); n++) key = `${base}-${n}`;
		usedKeys.add(key);
		const type = String(b.type ?? "unstyled");
		const chars = draftChars(b, raw.entityMap);
		if (type === "atomic") {
			const { block, entry } = draftAtomic(key, chars, raw.entityMap, where, plain);
			blocks.push(block);
			if (entry) sidecar[key] = entry;
		} else if (type === "code-block") {
			const lang = isObj(b.data) && b.data.lang ? String(b.data.lang).toLowerCase() : "";
			blocks.push({ _type: "code", _key: key, code: chars.text, ...(lang ? { language: lang } : {}) });
		} else if (type === "section-break" && !plain) {
			blocks.push({ _type: "break", _key: key, style: "lineBreak" });
		} else if (plain && (type === "pullquote" || type === "section-break")) {
			// TakeShape printed captions and credits without pullquote or section-break handling: as paragraphs
			blocks.push(draftTextBlock(b, "unstyled", key, chars, raw.entityMap, where, plain));
		} else {
			blocks.push(draftTextBlock(b, type, key, chars, raw.entityMap, where, plain));
			if (type === "pullquote") sidecar[key] = { pullquote: true };
		}
	});
	return { blocks, sidecar };
}

function markdownToPT(md: unknown, where: string) {
	if (typeof md !== "string" || !md.trim()) return null;
	return postProcessPortableText(markdownToPortableText(md), where);
}

// Named references Markdown text holds in practice; others stay as written. Numeric ones all decode.
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™", hellip: "…",
	mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·",
	bull: "•", deg: "°", eacute: "é", egrave: "è", aacute: "á", oacute: "ó", iacute: "í", uacute: "ú", ntilde: "ñ", ccedil: "ç",
};

/** Entity references in Markdown text, as CommonMark reads them: &#8217;, &#x2019; and the names above. */
function decodeMarkdownEntities(s: string): string {
	return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
		if (name !== undefined) return NAMED_ENTITIES[name] ?? m;
		const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
		// CommonMark: 0 and anything past Unicode or in the surrogate range read as U+FFFD
		return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
	});
}

/**
 * A Markdown text block as Markdown means it: entity references decoded outside code spans, and a paragraph's lines
 * without the spaces and tabs at their start and the block without them at its end. EmDash's markdownToPortableText
 * keeps both as written, which printed "We&amp;#x2019;re" and "&nbsp;interconnected" where TakeShape's MDX renderer
 * printed "We’re" and "interconnected".
 */
function markdownText(block: PTBlock): void {
	const spans = (block.children ?? []).filter((c) => typeof c.text === "string");
	for (const span of spans) {
		if (!(span.marks ?? []).includes("code")) span.text = decodeMarkdownEntities(span.text!).replace(/\n[ \t]+/g, "\n");
	}
	const first = spans[0];
	const last = spans[spans.length - 1];
	if (first && !(first.marks ?? []).includes("code")) first.text = first.text!.replace(/^[ \t]+/, "");
	if (last && !(last.marks ?? []).includes("code")) last.text = last.text!.replace(/[ \t]+$/, "");
	if (spans.length > 1) block.children = (block.children ?? []).filter((c) => c.text !== "");
}

/** Markdown's Portable Text: TakeShape image URLs become $media, and links to TakeShape's CDN go in the report. */
function postProcessPortableText(blocks: readonly object[] | null | undefined, where: string): PTBlock[] | null {
	const out: PTBlock[] = [];
	for (const raw of blocks ?? []) {
		const block = raw as PTBlock;
		if (block?._type === "image") {
			for (const k of ["alt", "caption"] as const) {
				const s = block[k];
				if (typeof s === "string") block[k] = decodeEntities(s);
			}
			if (!block.alt && block.caption) block.alt = block.caption.slice(0, 150);
			const url = block.asset?.url ?? block.asset?._ref;
			if (typeof url === "string" && TS_HOST.test(url)) {
				const clean = url.split("?")[0];
				const media: MediaInfo = { url: clean };
				if (block.alt) media.alt = block.alt;
				block.asset = { $media: media };
			}
			out.push(block);
			continue;
		}
		if (block?._type === "block") {
			markdownText(block);
			for (const def of block.markDefs ?? []) {
				// CommonMark decodes entity references in a link's destination too
				if (def?._type === "link" && typeof def.href === "string") def.href = decodeMarkdownEntities(def.href);
				if (def?._type === "link" && typeof def.href === "string") noteTakeShapeLink(def.href, where);
			}
		}
		out.push(block);
	}
	return out.length ? out : null;
}

function decodeEntities(s: string) {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// Plan: which shapes become collections, taxonomies, or nothing
// ---------------------------------------------------------------------------

const plans = new Map<string, ShapePlan>(); // shapeId -> plan
const usedCollectionSlugs = new Set<string>();
const usedTaxonomyNames = new Set<string>();

for (const [name, s] of Object.entries(shapes)) {
	const id = s.id ?? name;
	const modelType = s.model?.type;
	if (!modelType) continue; // not stored in ShapeDB (inline object or service shape)
	if (id === "ASSET" || name === "Asset" || name.startsWith("TS")) continue;
	const cfg = shapeCfg(name);
	const count = rows.filter((r) => rowShapeId(r) === id).length;
	if (cfg.skip) {
		report.skippedShapes.push({ shape: name, reason: "Skipped by config" });
		continue;
	}
	const props = s.schema?.properties ?? {};
	if (!Object.values(props).some((p) => storageKey(p))) {
		report.skippedShapes.push({ shape: name, reason: "No stored properties (service or computed shape)" });
		continue;
	}
	// A TakeShape taxonomy becomes an EmDash taxonomy only when it is a plain
	// list of terms (a label and maybe a slug). Richer ones, such as an Author
	// with a photo and bio, stay collections so no data is lost.
	const stored = Object.entries(props).filter(([, p]) => storageKey(p));
	const labelIndex = stored.findIndex(([, q]) => q.type === "string");
	const extras = stored.filter(([n], i) => i !== labelIndex && !/^slug$/i.test(n));
	const plainTerms = extras.length === 0;
	const asTaxonomy = modelType === "taxonomy" && plainTerms && cfg.as !== "collection" && !opts.taxonomiesAsCollections;
	if (modelType === "taxonomy" && !asTaxonomy && cfg.as !== "collection" && !opts.taxonomiesAsCollections) {
		warn(`Taxonomy "${name}" has extra fields (${extras.map(([n]) => n).join(", ")}), so it was kept as a collection and linked with reference fields.`);
	}
	if (asTaxonomy || cfg.as === "taxonomy") {
		let tname = cfg.name ?? singular(snake(name));
		while (usedTaxonomyNames.has(tname)) tname = `${tname}_2`;
		usedTaxonomyNames.add(tname);
		plans.set(id, { kind: "taxonomy", id, name, shape: s, taxonomy: tname, count, fields: [], terms: [] });
		continue;
	}
	const routable = modelType !== "single";
	let slug = cfg.collection ?? (routable ? plural(snake(name)) : snake(name));
	if (!/^[a-z][a-z0-9_]*$/.test(slug)) slug = `c_${slug.replace(/[^a-z0-9_]/g, "_")}`;
	if (RESERVED_COLLECTIONS.has(slug)) {
		warn(`Shape "${name}" would be collection "${slug}", a name EmDash reserves, so it became "ts_${slug}". Rename it with a config override if you prefer.`);
		slug = `ts_${slug}`;
	}
	while (usedCollectionSlugs.has(slug)) slug = `${slug}_2`;
	usedCollectionSlugs.add(slug);
	plans.set(id, { kind: "collection", id, name, shape: s, slug, routable, count, fields: [], entries: [], published: 0 });
}

const planOf = (shapeId: string) => plans.get(shapeId);

// ---------------------------------------------------------------------------
// Plan fields
// ---------------------------------------------------------------------------

function widgetOf(shapeName: string, path: string[]) {
	let node = forms[shapeName]?.default;
	for (const p of path) node = node?.properties?.[p];
	return node?.widget;
}

function valuesOf(shapeId: string, keyPath: string[]) {
	const out: unknown[] = [];
	for (const r of rows) {
		if (rowShapeId(r) !== shapeId) continue;
		let v: unknown = r;
		for (const k of keyPath) v = isObj(v) ? v[k] : undefined;
		if (!empty(v)) out.push(v);
	}
	return out;
}

function relTargets(prop: TSProperty) {
	return (prop["@relationship"]?.shapeIds ?? []).map(String);
}

/**
 * Decide the EmDash field for one TakeShape property.
 * Returns an array (inline objects flatten into several fields) of field plans.
 */
function planProperty(plan: ShapePlan, propName: string, prop: TSProperty, keyPath: string[], formPath: string[], slugPrefix = "", labelPrefix = ""): FieldPlan[] {
	const shapeName = plan.name;
	const cfg = fieldCfg(shapeName, formPath.join("."));
	const key = keyOf(propName, prop);
	const label = `${labelPrefix}${prop.title ?? propName}`;
	if (cfg.skip) {
		report.skippedFields.push({ shape: shapeName, prop: formPath.join("."), reason: "Skipped by config" });
		return [];
	}
	if (!key) {
		if (prop["@resolver"] || prop["@relationship"] === undefined) {
			report.skippedFields.push({
				shape: shapeName,
				prop: formPath.join("."),
				reason: prop["@resolver"] ? "Resolved from a connected service, not stored in TakeShape" : "Not stored in TakeShape",
			});
		}
		return [];
	}
	const path = [...keyPath, key];
	const widget = widgetOf(shapeName, formPath) ?? "";
	const values = valuesOf(plan.id, path);
	let slug = cfg.slug ?? `${slugPrefix}${snake(propName)}`;
	if (RESERVED.has(slug)) slug = `ts_${slug}`;
	// A field's slug is its column, which can't be an SQL keyword; an inline object's slug below only prefixes its fields'
	const base = { prop: formPath.join("."), path, slug: FTS_UNSAFE.has(slug) ? `ts_${slug}` : slug, label, widget };

	// Relationships (assets, taxonomies, other entries)
	if (prop["@relationship"]) {
		const targets = relTargets(prop);
		const multiple = prop.type === "array" || prop["@relationship"].type === "multiple";
		if (targets.length && targets.every((t) => t === "ASSET")) {
			const referenced = values
				.flatMap((v) => (Array.isArray(v) ? v : [v]))
				.map((v) => (isObj(v) && typeof v.id === "string" ? assets.get(v.id) : undefined))
				.filter((a): a is Asset => Boolean(a));
			const allImages = referenced.every((a) => a.isImage);
			if (!multiple) return [{ ...base, kind: "asset", type: allImages ? "image" : "file" }];
			if (allImages) return [{ ...base, kind: "assetList", type: "repeater", sub: "image" }];
			return [{ ...base, kind: "json", type: "json", note: "Mixed file list kept as JSON" }];
		}
		const targetPlans = targets.map(planOf).filter((p): p is ShapePlan => Boolean(p));
		if (targetPlans.length === 1 && targetPlans[0].kind === "taxonomy") {
			return [{ ...base, kind: "taxonomy", taxonomy: targetPlans[0].taxonomy, targetShape: targetPlans[0].id, type: "taxonomy" }];
		}
		if (targetPlans.length === 1 && targetPlans[0].kind === "collection") {
			return [{ ...base, kind: "reference", type: "reference", target: targetPlans[0].slug, multiple, relatedName: prop["@relationship"].relatedName }];
		}
		return [{ ...base, kind: "json", type: "json", note: "Links to several shapes, kept as JSON with entry ids" }];
	}

	// Draft.js rich text
	if (prop["@tag"] === "draftjs") {
		if (/singleline/i.test(widget)) return [{ ...base, kind: "draftText", type: "string", note: "Single-line rich text, formatting dropped" }];
		return [{ ...base, kind: "draft", type: "portableText" }];
	}

	// Inline objects: flatten one level into prefixed fields
	const inlineName = refShapeName(prop);
	if (inlineName && prop.type !== "array") {
		const inline = shapeByName.get(inlineName);
		const subProps = inline?.schema?.properties ?? {};
		const nested = Object.entries(subProps).flatMap(([n, p]): FieldPlan[] =>
			refShapeName(p) && !p["@relationship"]
				? [{ ...base, prop: [...formPath, n].join("."), path: [...path, keyOf(n, p) ?? ""], slug: `${slug}_${snake(n)}`, label: `${label}: ${p.title ?? n}`, kind: "json", type: "json", schemaShape: refShapeName(p), note: "Nested object kept as JSON" }]
				: planProperty(plan, n, p, path, [...formPath, n], `${slug}_`, `${label}: `),
		);
		return nested;
	}

	// Arrays of inline objects: repeater when every sub-field fits, otherwise JSON
	if (inlineName && prop.type === "array") {
		const inline = shapeByName.get(inlineName);
		const subProps = Object.entries(inline?.schema?.properties ?? {});
		const subPlans = subProps.flatMap(([n, p]) => {
			const fake = { ...plan, id: "__none__" };
			// Row fields are named by their path in the row, so an object's fields (link.text, link.url) stay apart
			return planProperty(fake, n, p, [], [...formPath, n]).map((f) => ({ ...f, slug: f.prop.split(".").slice(formPath.length).map(snake).join("_") }));
		});
		const fits = subPlans.length > 0 && subPlans.every((f) => REPEATER_TYPES.has(f.type) && (f.kind === "scalar" || f.kind === "asset"));
		if (fits) return [{ ...base, kind: "repeater", type: "repeater", subPlans, inlineName }];
		return [{ ...base, kind: "json", type: "json", schemaShape: inlineName, note: "List of objects kept as JSON" }];
	}

	if (prop.type === "array") {
		if (prop.items?.type === "string") return [{ ...base, kind: "scalar", type: "multiSelect" }];
		return [{ ...base, kind: "json", type: "json" }];
	}
	if (prop.type === "boolean") return [{ ...base, kind: "scalar", type: "boolean" }];
	if (prop.type === "integer") return [{ ...base, kind: "scalar", type: "integer" }];
	if (prop.type === "number") return [{ ...base, kind: "scalar", type: "number" }];
	if (prop.type === "string" || prop.type === undefined) {
		if (prop.format === "date-time" || /^date(time)?$/i.test(widget)) return [{ ...base, kind: "scalar", type: "datetime" }];
		// An inline object's MDX field has no widget in its shape's form; its property says what it is
		const tag = String(prop["@tag"] ?? "");
		if (/markdown|mdx/i.test(widget) || /^(mdx|markdown)$/i.test(tag)) {
			return [{ ...base, kind: "markdown", type: "portableText", note: /mdx/i.test(widget) || /mdx/i.test(tag) ? "MDX components become plain text" : undefined }];
		}
		if (Array.isArray(prop.enum) || /dropdown|radio/i.test(widget)) {
			const options = Array.isArray(prop.enum) ? prop.enum.map(String) : [...new Set(values.map(String))];
			return [{ ...base, kind: "scalar", type: "select", options }];
		}
		if (/paragraph/i.test(widget) || values.some((v) => typeof v === "string" && (v.length > 200 || v.includes("\n")))) {
			return [{ ...base, kind: "scalar", type: "text" }];
		}
		return [{ ...base, kind: "scalar", type: "string" }];
	}
	return [{ ...base, kind: "json", type: "json" }];
}

for (const plan of plans.values()) {
	const props = plan.shape.schema?.properties ?? {};
	const order = forms[plan.name]?.default?.order ?? Object.keys(props);
	const names = [...new Set([...order, ...Object.keys(props)])].filter((n) => props[n] && !n.startsWith("_"));
	const fields = names.flatMap((n) => planProperty(plan, n, props[n], [], [n]));
	if (plan.kind === "taxonomy") {
		plan.fields = fields;
		continue;
	}
	// The TakeShape "slug" property becomes the EmDash entry slug
	const slugField = fields.find((f) => f.slug === "ts_slug" || /^slug$/i.test(f.widget));
	if (slugField) {
		slugField.kind = "entrySlug";
		plan.slugFrom = slugField;
	}
	const seen = new Set<string>();
	plan.fields = fields
		.filter((f) => f.kind !== "entrySlug")
		.map((f) => {
			let s = f.slug;
			while (seen.has(s)) s = `${s}_2`;
			seen.add(s);
			return { ...f, slug: s };
		});
	plan.titleField =
		plan.fields.find((f) => f.type === "string" && /^(title|name|headline|heading)$/.test(f.slug)) ??
		plan.fields.find((f) => f.type === "string");
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

const seedIdOf = (rowId: string) => `ts-${rowId}`;
const linkTarget = (v: unknown): string | null => (isObj(v) ? str(v.id) ?? str(v._id) ?? null : typeof v === "string" ? v : null);

function getPath(row: unknown, path: string[]): unknown {
	let v = row;
	for (const k of path) v = isObj(v) ? v[k] : undefined;
	if (isObj(v) && defaultLocale && Object.keys(v).length && Object.keys(v).every((k) => locales.includes(k))) {
		v = v[defaultLocale]; // localized value
	}
	return v;
}

function toDatetime(v: unknown) {
	const d = new Date(v as string | number);
	return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function scalar(f: FieldPlan, v: unknown): unknown {
	if (empty(v)) return undefined;
	switch (f.type) {
		case "string":
		case "text":
		case "select":
			return typeof v === "string" ? v : JSON.stringify(v);
		case "multiSelect":
			return (Array.isArray(v) ? v : [v]).map(String);
		case "datetime":
			return toDatetime(v);
		case "integer":
			return Number.isFinite(Number(v)) ? Math.round(Number(v)) : undefined;
		case "number":
			return Number.isFinite(Number(v)) ? Number(v) : undefined;
		case "boolean":
			return Boolean(v);
		default:
			return v;
	}
}

/** Generic deep conversion for JSON fields: storage keys to names, assets to $media, links to $ref. */
function toJson(v: unknown, shapeName: string | null | undefined, where: string): unknown {
	if (Array.isArray(v)) return v.map((x) => toJson(x, shapeName, where));
	if (!isObj(v)) return v;
	const targetId = str(v.id) ?? str(v._id);
	const targetShape = str(v.shapeId) ?? str(v.contentTypeId);
	if (targetId && targetShape && Object.keys(v).length <= 3) {
		if (targetShape === "ASSET") return mediaFor(targetId) ?? { missingAsset: targetId };
		const p = planOf(targetShape);
		if (p?.kind === "collection" && rowsById.has(targetId)) return { collection: p.slug, id: `$ref:${seedIdOf(targetId)}` };
		return { shape: targetShape, takeshapeId: targetId };
	}
	if (Array.isArray(v.blocks) && isObj(v.entityMap)) return draftPlainText(v);
	const props = (shapeName ? shapeByName.get(shapeName) : undefined)?.schema?.properties ?? {};
	const byKey = new Map(Object.entries(props).map(([n, p]) => [keyOf(n, p), [n, p] as const]));
	const out: JsonObject = {};
	for (const [k, val] of Object.entries(v)) {
		const hit = byKey.get(k);
		const name = hit ? hit[0] : k;
		// Rich text keeps its blocks (and what Portable Text can't hold), so the site can print the HTML TakeShape did
		if (hit?.[1]?.["@tag"] === "draftjs") {
			const rich = draftToPortableText(val, where);
			out[name] = rich ? { _type: "takeshapeRichText", blocks: rich.blocks, ...(Object.keys(rich.sidecar).length ? { sidecar: rich.sidecar } : {}) } : null;
		} else if (/^(mdx|markdown)$/i.test(String(hit?.[1]?.["@tag"] ?? "")) && typeof val === "string") {
			// Markdown and MDX: TakeShape returned the text as stored, or rendered it with format: html
			out[name] = val ? { _type: "takeshapeRichText", blocks: markdownToPT(val, where) ?? [], source: val } : val;
		} else out[name] = toJson(val, hit ? refShapeName(hit[1]) : null, where);
	}
	return out;
}

function convertField(f: FieldPlan, row: TSRow, entry: SeedContentEntry, where: string, sidecar: RichTextSidecar): unknown {
	const v = getPath(row, f.path);
	switch (f.kind) {
		case "scalar":
			return scalar(f, v);
		case "draft": {
			const converted = draftToPortableText(v, where);
			if (converted && Object.keys(converted.sidecar).length) sidecar[f.slug] = converted.sidecar;
			return converted?.blocks;
		}
		case "draftText":
			return draftPlainText(v) || undefined;
		case "markdown":
			return markdownToPT(v, where) ?? undefined;
		case "asset":
			return linkTarget(v) ? mediaFor(linkTarget(v)) ?? undefined : undefined;
		case "assetList":
			return (Array.isArray(v) ? v : [])
				.map((x) => mediaFor(linkTarget(x)))
				.filter(Boolean)
				.map((m) => ({ [f.sub ?? "image"]: m }));
		case "reference": {
			const ids = (Array.isArray(v) ? v : empty(v) ? [] : [v]).map(linkTarget).filter((id): id is string => Boolean(id));
			const refs: string[] = [];
			for (const id of ids) {
				if (rowsById.has(id)) refs.push(`$ref:${seedIdOf(id)}`);
				else report.unresolved.push({ where, target: id });
			}
			if (!refs.length) return undefined;
			return f.multiple ? refs : refs[0];
		}
		case "taxonomy": {
			const ids = (Array.isArray(v) ? v : empty(v) ? [] : [v]).map(linkTarget).filter((id): id is string => Boolean(id));
			const taxonomy = f.taxonomy ?? "";
			for (const id of ids) {
				const term = termSlugByRow.get(id);
				if (!term) continue;
				entry.taxonomies ??= {};
				const terms = (entry.taxonomies[taxonomy] ??= []);
				if (!terms.includes(term)) terms.push(term);
			}
			return undefined;
		}
		case "repeater": {
			// A row that holds nothing still counts: TakeShape returned it, every field null
			const rows = (Array.isArray(v) ? v : []).filter(isObj).map((item) => {
				const rowOut: JsonObject = {};
				for (const sf of f.subPlans ?? []) {
					const sv = sf.kind === "asset" ? mediaFor(linkTarget(getPath(item, sf.path))) : scalar(sf, getPath(item, sf.path));
					if (!empty(sv) && sv !== null) rowOut[sf.slug] = sv;
				}
				return rowOut;
			});
			return rows.length ? rows : undefined;
		}
		case "json":
			return empty(v) ? undefined : toJson(v, f.schemaShape, where);
		default:
			return undefined;
	}
}

function isPublished(row: TSRow) {
	if (typeof row._enabled === "boolean") return row._enabled;
	if (row._status === "enabled") return true;
	if (row._status === "disabled") return false;
	let live = false;
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!isObj(node)) return;
		if ((node.key === row._status || node.name === row._status || node.id === row._status) && typeof node.live === "boolean") live = node.live;
		Object.values(node).forEach(walk);
	};
	walk(schema.workflows);
	return live;
}

// ---------------------------------------------------------------------------
// Taxonomy terms
// ---------------------------------------------------------------------------

const termSlugByRow = new Map<string, string>();
const seedTaxonomies: SeedTaxonomy[] = [];
for (const plan of plans.values()) {
	if (plan.kind !== "taxonomy") continue;
	const labelField = plan.fields.find((f) => f.kind === "scalar" && (f.type === "string" || f.type === "text"));
	const slugField = plan.fields.find((f) => f.slug === "ts_slug" || /^slug$/i.test(f.widget));
	plan.labelProp = labelField?.prop ?? "";
	plan.slugProp = slugField?.prop ?? null;
	const used = new Set<string>();
	const terms: SeedTaxonomyTerm[] = [];
	for (const r of rows) {
		if (rowShapeId(r) !== plan.id) continue;
		const label = String(labelField ? getPath(r, labelField.path) ?? "" : "").trim() || r._id;
		let slug = slugify(slugField ? getPath(r, slugField.path) : label) || slugify(r._id);
		while (used.has(slug)) slug = `${slug}-2`;
		used.add(slug);
		termSlugByRow.set(r._id, slug);
		terms.push({ slug, label });
	}
	const extra = plan.fields.filter((f) => f !== labelField && f !== slugField).map((f) => f.prop);
	if (extra.length) warn(`Taxonomy "${plan.name}" became EmDash taxonomy "${plan.taxonomy}". Its other fields (${extra.join(", ")}) are not migrated; rerun with --taxonomies-as-collections to keep them.`);
	plan.terms = terms;
}

// Taxonomy definitions need the collections that use them
for (const plan of plans.values()) {
	if (plan.kind !== "taxonomy") continue;
	const collections = [...plans.values()]
		.filter((p): p is CollectionPlan => p.kind === "collection" && p.fields.some((f) => f.kind === "taxonomy" && f.taxonomy === plan.taxonomy))
		.map((p) => p.slug);
	seedTaxonomies.push({
		name: plan.taxonomy,
		label: plan.shape.title ?? plan.name,
		labelSingular: singular(plan.shape.title ?? plan.name),
		hierarchical: false,
		collections,
		terms: plan.terms,
	});
	report.taxonomies.push({ shape: plan.name, name: plan.taxonomy, terms: plan.terms.length, collections });
}

// ---------------------------------------------------------------------------
// Collections and fields
// ---------------------------------------------------------------------------

/** A field that becomes a column; taxonomy fields become term assignments instead. */
type ColumnFieldPlan = FieldPlan & { type: FieldType };
const isColumn = (f: FieldPlan): f is ColumnFieldPlan => f.type !== "taxonomy";

function seedField(f: ColumnFieldPlan): SeedField {
	const out: SeedField = { slug: f.slug, label: f.label.slice(0, 120), type: f.type };
	if (f.type === "select" && f.options?.length) out.validation = { options: f.options };
	if (f.type === "reference") out.validation = f.relation ? { relation: f.relation } : { targetCollection: f.target, multiple: Boolean(f.multiple) };
	if (f.type === "repeater") {
		const subs: { slug: string; label: string; type: string; options?: string[] }[] = f.subPlans ?? [{ slug: f.sub ?? "image", label: "Image", type: "image" }];
		out.validation = {
			subFields: subs.map((sf) => {
				const s: Record<string, unknown> = { slug: sf.slug, label: sf.label.slice(0, 120), type: sf.type };
				if (sf.type === "select" && sf.options?.length) s.options = sf.options;
				return s;
			}),
		};
	}
	if (["string", "text", "portableText"].includes(f.type) && f.searchable) out.searchable = true;
	return out;
}

const collectionPlans = [...plans.values()].filter((p): p is CollectionPlan => p.kind === "collection");
for (const plan of collectionPlans) {
	if (plan.titleField) plan.titleField.searchable = true;
	for (const f of plan.fields) if (f.type === "portableText" || f.type === "text") f.searchable = true;
	if (opts.legacyFields) {
		plan.fields.push(
			{ slug: "takeshape_id", label: "TakeShape ID", type: "string", kind: "legacyId", prop: "_id", path: [], widget: "" },
			{ slug: "takeshape_published_at", label: "TakeShape publish date", type: "datetime", kind: "legacyDate", prop: "_enabledAt", path: [], widget: "" },
			{ slug: "takeshape_created_at", label: "TakeShape created date", type: "datetime", kind: "legacyCreated", prop: "_createdAt", path: [], widget: "" },
			{ slug: "takeshape_updated_at", label: "TakeShape updated date", type: "datetime", kind: "legacyUpdated", prop: "_updatedAt", path: [], widget: "" },
		);
	}
	// Last, so the Draft.js fields before it have filled the entry's sidecar
	const draftFields = plan.fields.filter((f) => f.kind === "draft");
	if (draftFields.length) {
		plan.fields.push({
			slug: "takeshape_rich_text",
			label: "TakeShape rich text (used by the migrated site)",
			type: "json",
			kind: "richTextSidecar",
			prop: draftFields.map((f) => f.prop).join(", "),
			path: [],
			widget: "",
			note: "Pullquotes, embeds, image sizes, captions and credits, so the migrated site can print rich text as TakeShape did",
		});
	}
	// After the taxonomy fields, which fill the entry's terms. EmDash keeps no order for an entry's terms.
	const taxonomyFields = plan.fields.filter((f) => f.kind === "taxonomy");
	if (taxonomyFields.length) {
		plan.fields.push({
			slug: "takeshape_term_order",
			label: "TakeShape term order (used by the migrated site)",
			type: "json",
			kind: "termOrder",
			prop: taxonomyFields.map((f) => f.prop).join(", "),
			path: [],
			widget: "",
			note: "Each taxonomy's term slugs in the order TakeShape kept them, so the migrated site lists terms as TakeShape did",
		});
	}
}

// Fields that point at each other (Post.author and Author.authored) become the
// two ends of one EmDash relation, but only when both hold the same links. One
// relation answers both ends with every link, so where TakeShape stored
// different links on each end (or none on one), the fields stay separate.
// Links are declared once, from the parent end.
const seedRelations: SeedRelation[] = [];
// Collection and field slugs both hold underscores, so "<collection>_<field>" can name two relations
// (zz + zz_yy_f and zz_zz + yy_f): a slug another relation took gets a number
const relationSlug = (base: string) => {
	let slug = base;
	for (let n = 2; seedRelations.some((r) => r.slug === slug); n++) slug = `${base}_${n}`;
	return slug;
};
const refFields: RefField[] = collectionPlans.flatMap((p) => p.fields.filter((f) => f.kind === "reference").map((f) => ({ plan: p, f })));
// The links a field stores, each as "<entry id> <target id>", or reversed with `flip`
const storedLinks = (r: RefField, flip: boolean) => {
	const links = new Set<string>();
	for (const row of rows) {
		if (rowShapeId(row) !== r.plan.id) continue;
		const v = getPath(row, r.f.path);
		for (const target of (Array.isArray(v) ? v : empty(v) ? [] : [v]).map(linkTarget)) {
			if (target) links.add(flip ? `${target} ${row._id}` : `${row._id} ${target}`);
		}
	}
	return links;
};
const sameLinks = (a: RefField, b: RefField) => {
	const fromA = storedLinks(a, false);
	const fromB = storedLinks(b, true);
	return fromA.size === fromB.size && [...fromA].every((link) => fromB.has(link));
};
for (const a of refFields) {
	if (a.f.relation) continue;
	const b = refFields.find((x) => x !== a && !x.f.relation && x.plan !== a.plan && x.plan.slug === a.f.target && x.f.target === a.plan.slug && sameLinks(a, x));
	if (!b) continue;
	let [parent, child] = [a, b];
	if (a.f.multiple && !b.f.multiple) [parent, child] = [b, a];
	const slug = relationSlug(`${parent.plan.slug}_${parent.f.slug}`);
	parent.f.relation = slug;
	child.f.relation = slug;
	child.f.inverseOf = parent;
	child.f.note = `Same links as \`${parent.plan.slug}.${parent.f.slug}\`, viewed from this side`;
	seedRelations.push({
		slug,
		parentCollection: parent.plan.slug,
		childCollection: child.plan.slug,
		parentLabel: child.f.label,
		childLabel: parent.f.label,
		maxChildrenPerParent: parent.f.multiple ? null : 1,
		maxParentsPerChild: child.f.multiple ? null : 1,
	});
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const content: Record<string, SeedContentEntry[]> = {};
for (const plan of collectionPlans) {
	const usedSlugs = new Set<string>();
	// The slugs this collection gets without --site, for the report
	const plainSlugs = new Set<string>();
	const entries: SeedContentEntry[] = [];
	let published = 0;
	for (const r of rows) {
		if (rowShapeId(r) !== plan.id) continue;
		const where = `${plan.slug}/${r._id}`;
		// Keys listed up front keep id, slug and status ahead of data in the seed file
		const entry: SeedContentEntry = { id: seedIdOf(r._id), slug: undefined, status: undefined, data: {} };
		if (plan.routable) {
			const fromField = plan.slugFrom ? getPath(r, plan.slugFrom.path) : null;
			const fromTitle = plan.titleField ? getPath(r, plan.titleField.path) : null;
			const siteSlug = siteSlugs.get(r._id);
			let slug = slugify(fromField) || slugify(typeof fromTitle === "string" ? fromTitle : draftPlainText(fromTitle)) || slugify(r._id);
			const baseSlug = slug;
			let plainSlug = baseSlug;
			for (let n = 2; plainSlugs.has(plainSlug); n++) plainSlug = `${baseSlug}-${n}`;
			plainSlugs.add(plainSlug);
			// Slugs taken from the site are kept as they are, so the others step around them
			const reserved = shapesWithPages.has(plan.id) ? reservedSiteSlugs : new Set<string>();
			for (let n = 2; usedSlugs.has(slug) || reserved.has(slug); n++) slug = `${baseSlug}-${n}`;
			if (siteSlug !== undefined) {
				if (siteSlug !== plainSlug) siteSlugChanges.push({ collection: plan.slug, from: plainSlug, to: siteSlug });
				slug = siteSlug;
			} else if (fromField && slug !== fromField) warn(`${where}: slug "${fromField}" changed to "${slug}".`);
			usedSlugs.add(slug);
			entry.slug = slug;
		} else if (plan.slugFrom) {
			// A single entry has no page of its own, but TakeShape returned its slug and templates print it
			const slug = slugify(getPath(r, plan.slugFrom.path));
			if (slug) entry.slug = slug;
		}
		const isLive = isPublished(r);
		entry.status = isLive ? "published" : "draft";
		if (isLive) published++;
		const sidecar: RichTextSidecar = {};
		for (const f of plan.fields) {
			let v: unknown;
			if (f.kind === "legacyId") v = r._id;
			else if (f.kind === "legacyDate") v = toDatetime(r._enabledAt ?? r._createdAt);
			else if (f.kind === "legacyCreated") v = toDatetime(r._createdAt);
			else if (f.kind === "legacyUpdated") v = toDatetime(r._updatedAt);
			else if (f.kind === "richTextSidecar") v = Object.keys(sidecar).length ? sidecar : undefined;
			else if (f.kind === "termOrder") v = entry.taxonomies && Object.keys(entry.taxonomies).length ? structuredClone(entry.taxonomies) : undefined;
			else v = convertField(f, r, entry, where, sidecar);
			if (!empty(v) && v !== null) entry.data[f.slug] = v;
		}
		if (plan.titleField && empty(entry.data[plan.titleField.slug])) entry.data[plan.titleField.slug] = entry.slug ?? r._id;
		entries.push(entry);
	}
	plan.entries = entries;
	plan.published = published;
	content[plan.slug] = entries;
}

// Move links stored on the child end of a relation onto the parent end, which declares them
const entryBySeedId = new Map(collectionPlans.flatMap((p) => p.entries.map((e) => [e.id, e] as const)));
const LINK_ORDER = "takeshape_link_order";
function moveToParentEnd(children: RefField[]) {
	for (const { plan, f } of children) {
		const parent = f.inverseOf;
		if (!parent) continue;
		for (const e of plan.entries) {
			const v = e.data[f.slug];
			delete e.data[f.slug];
			// EmDash keeps a link's order on the parent end only, and the child end reads its links in the order they were
			// declared. TakeShape's order of each multiple field goes into a sidecar, matched by takeshape_id.
			if (f.multiple && opts.legacyFields && Array.isArray(v) && v.length > 1) {
				if (!plan.fields.some((x) => x.kind === "linkOrder")) {
					plan.fields.push({
						slug: LINK_ORDER,
						label: "TakeShape link order (used by the migrated site)",
						type: "json",
						kind: "linkOrder",
						prop: "",
						path: [],
						widget: "",
						note: "The TakeShape ids of each multiple field's links in the order TakeShape kept them, for fields whose links the other collection declares",
					});
				}
				const order = (isObj(e.data[LINK_ORDER]) ? e.data[LINK_ORDER] : (e.data[LINK_ORDER] = {})) as JsonObject;
				order[f.slug] = v.map((ref) => String(ref).replace(/^\$ref:ts-/, ""));
			}
			for (const ref of Array.isArray(v) ? v : v ? [v] : []) {
				const pe = entryBySeedId.get(String(ref).slice(5));
				if (!pe) continue;
				const mine = `$ref:${e.id}`;
				const cur = pe.data[parent.f.slug];
				if (parent.f.multiple) {
					const list = Array.isArray(cur) ? cur : cur ? [cur] : [];
					if (!list.includes(mine)) list.push(mine);
					pe.data[parent.f.slug] = list;
				} else if (!cur) pe.data[parent.f.slug] = mine;
				else if (cur !== mine) warn(`${parent.plan.slug}/${pe.id.slice(3)}: TakeShape had two different values for ${parent.f.slug} (one from ${plan.slug}.${f.slug}); kept the one stored on ${parent.plan.slug}.`);
			}
		}
	}
}
moveToParentEnd(refFields.filter((r) => r.f.inverseOf));

// ---------------------------------------------------------------------------
// Order collections so every $ref target is created first
// ---------------------------------------------------------------------------

const refsIn = (v: unknown, acc: string[] = []): string[] => {
	if (typeof v === "string" && v.startsWith("$ref:")) acc.push(v.slice(5));
	else if (Array.isArray(v)) v.forEach((x) => refsIn(x, acc));
	else if (isObj(v)) Object.values(v).forEach((x) => refsIn(x, acc));
	return acc;
};
const collectionOfSeedId = new Map<string, string>();
for (const [slug, entries] of Object.entries(content)) for (const e of entries) collectionOfSeedId.set(e.id, slug);

/** Collections in the order seed creates them, targets first, and the cycles that order had to break. */
function orderCollections() {
	const deps = new Map(Object.keys(content).map((s) => [s, new Set<string>()] as const));
	for (const [slug, entries] of Object.entries(content)) {
		for (const e of entries) for (const id of refsIn(e.data)) {
			const target = collectionOfSeedId.get(id);
			if (target && target !== slug) deps.get(slug)!.add(target);
		}
	}
	const orderedSlugs: string[] = [];
	const state = new Map<string, number>(); // 1 = visiting, 2 = done
	const cyclic: string[] = [];
	const visit = (s: string, trail: string[]): void => {
		if (state.get(s) === 2) return;
		if (state.get(s) === 1) {
			cyclic.push([...trail, s].join(" -> "));
			return;
		}
		state.set(s, 1);
		for (const d of deps.get(s)!) visit(d, [...trail, s]);
		state.set(s, 2);
		orderedSlugs.push(s);
	};
	for (const s of deps.keys()) visit(s, []);
	return { orderedSlugs, cyclic };
}

// Seed resolves a $ref only to an entry it already created, so in collections
// that point at each other, links into a collection created later would be
// dropped. Each field holding such links becomes the child end of a relation,
// and a new field on the target collection, created later, declares them.
// Every remaining link then points at a collection created earlier.
const firstOrder = new Map(orderCollections().orderedSlugs.map((s, i) => [s, i] as const));
const forward: RefField[] = [];
for (const r of refFields) {
	const { plan, f } = r;
	if (f.relation || !f.target || f.target === plan.slug) continue;
	if ((firstOrder.get(f.target) ?? -1) < (firstOrder.get(plan.slug) ?? -1)) continue;
	if (!plan.entries.some((e) => !empty(e.data[f.slug]))) continue;
	const target = collectionPlans.find((p) => p.slug === f.target);
	if (!target) continue;
	let slug = `${plan.slug}_${f.slug}`;
	for (let n = 2; target.fields.some((x) => x.slug === slug) || RESERVED.has(slug); n++) slug = `${plan.slug}_${f.slug}_${n}`;
	const relation = relationSlug(`${target.slug}_${slug}`);
	const declaring: FieldPlan = {
		prop: `${plan.name}.${f.prop}`,
		path: [],
		slug,
		label: `${plan.shape.title ?? plan.name}: ${f.label}`,
		widget: "",
		kind: "reference",
		type: "reference",
		target: plan.slug,
		multiple: true,
		relation,
		declares: r,
		note: `Declares the links of \`${plan.slug}.${f.slug}\`, since ${target.slug} is created after ${plan.slug}`,
	};
	target.fields.push(declaring);
	f.relation = relation;
	f.inverseOf = { plan: target, f: declaring };
	f.note = `Same links as \`${target.slug}.${slug}\`, which declares them`;
	seedRelations.push({
		slug: relation,
		parentCollection: target.slug,
		childCollection: plan.slug,
		parentLabel: f.label,
		childLabel: declaring.label,
		maxChildrenPerParent: null,
		maxParentsPerChild: f.multiple ? null : 1,
	});
	forward.push(r);
}
moveToParentEnd(forward);

const seedCollections = collectionPlans.map((plan) => {
	const c: SeedCollection = {
		slug: plan.slug,
		label: plan.shape.title ?? plan.name,
		labelSingular: plan.shape.title ?? plan.name,
		supports: plan.routable ? ["drafts", "revisions", "search"] : ["drafts", "revisions"],
		routable: plan.routable,
		fields: plan.fields.filter(isColumn).map(seedField),
	};
	if (plan.routable) {
		if (!/s$/i.test(c.label)) c.label = plural(c.label);
		c.urlPattern = `/${plan.slug.replace(/_/g, "-")}/{slug}`;
	}
	if (plan.shape.description) c.description = String(plan.shape.description).slice(0, 500);
	if (plan.titleField) c.titleField = plan.titleField.slug;
	const date = plan.fields.find((f) => f.type === "datetime" && f.kind === "scalar") ?? (plan.routable ? plan.fields.find((f) => f.kind === "legacyDate") : undefined);
	if (date) c.dateField = date.slug;
	return c;
});

// Only mark fields required when every entry has a value
for (const c of seedCollections) {
	const entries = content[c.slug] ?? [];
	for (const f of c.fields) {
		// Media and rich text stay optional so a failed download never blocks an entry
		if (["reference", "repeater", "image", "file", "portableText", "json"].includes(f.type)) continue;
		if (entries.length && entries.every((e) => !empty(e.data[f.slug]))) {
			const plan = collectionPlans.find((p) => p.slug === c.slug);
			const src = plan?.fields.find((x) => x.slug === f.slug);
			const prop = src?.prop && !src.prop.includes(".") ? plan?.shape.schema?.required?.includes(src.prop) : false;
			if (prop) f.required = true;
		}
	}
}

// ---------------------------------------------------------------------------
// Order entries so every $ref target is created first
// ---------------------------------------------------------------------------

const { orderedSlugs, cyclic } = orderCollections();
for (const c of cyclic) warn(`Collections reference each other (${c}). Links that point forward in this cycle will not be created; re-link them in the EmDash admin.`);

// Within a collection, entries that link to each other in a loop (related
// posts that point at each other) get a stub first: same slug, no links. The
// full entry later updates the stub, which is why the seed is applied with
// --on-conflict update.
const STUB = "~stub";
let stubCount = 0;
const stripRefs = (data: JsonObject) => Object.fromEntries(Object.entries(data).filter(([, v]) => refsIn(v).length === 0));
const retarget = (v: unknown, from: string, to: string): unknown =>
	v === from ? to : Array.isArray(v) ? v.map((x) => retarget(x, from, to)) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, retarget(x, from, to)])) : v;
const orderedContent: Record<string, SeedContentEntry[]> = {};
for (const slug of orderedSlugs) {
	const entries = content[slug];
	const byId = new Map(entries.map((e) => [e.id, e] as const));
	const routable = collectionPlans.find((p) => p.slug === slug)?.routable;
	const done = new Set<string>();
	const visiting = new Set<string>();
	const stubbed = new Set<string>();
	const sorted: SeedContentEntry[] = [];
	const place = (e: SeedContentEntry): void => {
		if (done.has(e.id)) return;
		visiting.add(e.id);
		for (const id of refsIn(e.data)) {
			// A link to the entry itself is the smallest loop, and gets a stub the same way
			if (!byId.has(id)) continue;
			if (!visiting.has(id)) {
				place(byId.get(id)!);
				continue;
			}
			const target = byId.get(id)!;
			if (!routable) {
				warn(id === e.id ? `${slug}: entry ${id.slice(3)} links to itself; re-add that link in the admin.` : `${slug}: entries ${e.id.slice(3)} and ${id.slice(3)} link to each other; re-add that link in the admin.`);
				continue;
			}
			if (!stubbed.has(id)) {
				stubbed.add(id);
				stubCount++;
				sorted.push({ id: `${id}${STUB}`, slug: target.slug, status: target.status, data: stripRefs(target.data) });
			}
			e.data = retarget(e.data, `$ref:${id}`, `$ref:${id}${STUB}`) as JsonObject;
		}
		visiting.delete(e.id);
		done.add(e.id);
		sorted.push(e);
	};
	entries.forEach(place);
	orderedContent[slug] = sorted;
}

// ---------------------------------------------------------------------------
// Write the seed
// ---------------------------------------------------------------------------

const seed: SeedFile = {
	$schema: "https://emdashcms.com/seed.schema.json",
	version: "1",
	meta: {
		name: `${schema.projectName ?? "TakeShape project"} (migrated)`,
		description: `Migrated from TakeShape project ${schema.projectId ?? ""}`.trim(),
		author: "ts2emdash",
	},
	collections: orderedSlugs.map((s) => seedCollections.find((c) => c.slug === s)).filter((c): c is SeedCollection => Boolean(c)),
	relations: seedRelations,
	taxonomies: seedTaxonomies,
	content: orderedContent,
};

// ---------------------------------------------------------------------------
// Media preload (--preload-media local): every image and file the seed uses is
// downloaded once into the uploads folder and recorded in the ledger, so a
// rerun or a clean redo only does what is left.
// ---------------------------------------------------------------------------

const MIME_EXT: Record<string, string> = {
	"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
	"image/avif": ".avif", "image/svg+xml": ".svg", "application/pdf": ".pdf", "video/mp4": ".mp4",
};
// Read width and height from the file header only: an empty placeholder skips EmDash's blurhash decode
const NO_DECODE = { placeholder: { bytes: new Uint8Array(0), contentType: "application/octet-stream" } };
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const baseMime = (m: string) => m.split(";")[0].trim().toLowerCase();
const assetsByUrl = new Map([...assets.values()].map((a) => [a.url, a]));
const assetsByPath = new Map([...assets.values()].map((a) => [a.path, a]));

const preloadModules = opts.preloadMedia
	? {
			Kysely: (await load<typeof import("kysely")>("kysely", "kysely")).Kysely,
			createDialect: (await load<typeof import("emdash/db/sqlite")>("emdash/db/sqlite", "emdash")).createDialect,
			runMigrations: (await load<typeof import("emdash/db")>("emdash/db", "emdash")).runMigrations,
			LocalStorage: (await load<typeof import("emdash/storage/local")>("emdash/storage/local", "emdash")).LocalStorage,
			enrichImageMetadata: (await load<typeof import("emdash/media")>("emdash/media", "emdash")).enrichImageMetadata,
			...(await load<typeof import("emdash")>("emdash", "emdash")),
		}
	: null;

const decodeSegment = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

/** The asset behind a TakeShape URL, matched on either host by its path, or the URL itself when no asset has that path. */
function sourceForUrl(url: string): MediaSource {
	const { pathname } = new URL(url);
	const asset = assetsByUrl.get(url) ?? (TS_HOST.test(url) ? assetsByPath.get(pathname.slice(1).split("/").map(decodeSegment).join("/")) : undefined);
	if (asset) {
		return { key: `asset:${asset.id}`, fetchUrl: asset.url, filename: asset.filename, alt: assetAlt(asset), caption: asset.caption || undefined, exportMimeType: asset.mimeType || undefined };
	}
	return { key: `url:${url}`, fetchUrl: url, filename: decodeSegment(pathname.split("/").pop() ?? "") || "media" };
}

/** A whole value that is a file URL on TakeShape's CDN. */
function isCdnUrl(v: string): boolean {
	return TS_HOST.test(v) && !/\s/.test(v);
}

/**
 * Where a moved file's URL points now: its copy in the media library, and for an images.takeshape.io URL, with its imgix
 * parameters, which the migrated site's middleware sends to its image endpoint, so the image keeps the size the old
 * site showed. The storage key stays in the path: EmDash's site export rewrites it there, and refuses a record that
 * holds one anywhere else (TRANSFER_MEDIA_REF_INVALID), such as percent-encoded in an image endpoint URL.
 */
function movedUrl(url: string, storageKey: string): string {
	const file = `/_emdash/api/media/file/${storageKey}`;
	const { hostname, search } = new URL(url);
	return hostname === "images.takeshape.io" && search.length > 1 ? `${file}${search}` : file;
}

/** Every value in the seed that still names a file on TakeShape's CDN, for the report. */
function noteRemainingCdnUrls(s: SeedFile) {
	const walk = (v: unknown, where: string): void => {
		if (typeof v === "string") {
			if (isCdnUrl(v)) noteTakeShapeLink(v, where);
			return;
		}
		if (Array.isArray(v)) return v.forEach((x) => walk(x, where));
		if (!isObj(v) || isObj(v.$media)) return;
		for (const x of Object.values(v)) walk(x, where);
	};
	for (const [collection, entries] of Object.entries(s.content ?? {})) {
		for (const entry of entries) walk(entry.data, `${collection}/${entry.slug ?? entry.id}`);
	}
}

function collectMediaSources(s: SeedFile): Map<string, SourceUse> {
	const uses = new Map<string, SourceUse>();
	const add = (url: string, where: string) => {
		const source = sourceForUrl(url);
		const use = uses.get(source.key) ?? { source, usedBy: new Set<string>() };
		use.usedBy.add(where);
		uses.set(source.key, use);
	};
	const walk = (v: unknown, where: string) => {
		// A value that is a file on TakeShape's CDN (a rich-text or image link, a URL field): the file goes into the
		// media library with the rest
		if (typeof v === "string") {
			if (isCdnUrl(v)) add(v, where);
			return;
		}
		if (Array.isArray(v)) return v.forEach((x) => walk(x, where));
		if (!isObj(v)) return;
		const media = v.$media;
		if (isObj(media) && typeof media.url === "string") {
			add(media.url, where);
			return;
		}
		for (const x of Object.values(v)) walk(x, where);
	};
	for (const [collection, entries] of Object.entries(s.content ?? {})) {
		for (const entry of entries) walk(entry.data, `${collection}/${entry.slug ?? entry.id}`);
	}
	return uses;
}

function storageKeyFor(source: MediaSource, mimeType: string): string {
	const ext = source.filename.toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] ?? MIME_EXT[baseMime(mimeType)] ?? ".bin";
	if (source.key.startsWith("url:")) return `ts-url-${sha256Hex(source.key.slice(4)).slice(0, 16)}${ext}`;
	const id = source.key.slice("asset:".length);
	const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
	return `ts-${safe}${safe === id ? "" : `-${sha256Hex(id).slice(0, 8)}`}${ext}`;
}

async function openLedger(file: string): Promise<Ledger> {
	const m = preloadModules!;
	await mkdir(dirname(resolve(file)), { recursive: true });
	const db = new m.Kysely<any>({ dialect: m.createDialect({ url: `file:${resolve(file)}` }) });
	await m.runMigrations(db);
	await db.schema
		.createTable("takeshape_media_sources")
		.ifNotExists()
		.addColumn("source_key", "text", (c) => c.primaryKey())
		.addColumn("source_url", "text", (c) => c.notNull())
		.addColumn("source_size", "integer")
		.addColumn("source_etag", "text")
		.addColumn("media_id", "text", (c) => c.notNull())
		.addColumn("storage_key", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.execute();
	return { db, media: new m.MediaRepository(db), close: () => db.destroy() };
}

type Outcome = "downloaded" | "present" | "refreshed";

/** Size of a stored file in the uploads folder (LocalStorage keeps each key at <uploads dir>/<key>), or null if it is missing. */
async function storedSize(key: string): Promise<number | null> {
	try {
		return (await stat(join(resolve(opts.uploadsDir), key))).size;
	} catch {
		return null;
	}
}
const RETRY_WAITS_MS = [500, 1000]; // 3 attempts in all

// Files are held in memory between download and upload, so cap the bytes held at once.
// A file larger than the cap still runs, alone.
const MAX_BYTES_IN_FLIGHT = 256 * 1024 * 1024;
let bytesInFlight = 0;
const waitingForBytes: (() => void)[] = [];
async function reserveBytes(n: number) {
	while (bytesInFlight > 0 && bytesInFlight + n > MAX_BYTES_IN_FLIGHT) await new Promise<void>((r) => waitingForBytes.push(r));
	bytesInFlight += n;
}
function releaseBytes(n: number) {
	bytesInFlight -= n;
	for (const wake of waitingForBytes.splice(0)) wake();
}

/**
 * Fetch a whole file. Network errors and 5xx are retried; any other failed status is final.
 * A body shorter or longer than the Content-Length the CDN sent counts as a network error:
 * over HTTP/2, Node's fetch can end a stream early without raising one.
 * The caller releases `reserved` bytes once it no longer holds the body.
 */
async function download(url: string): Promise<{ headers: Headers; body: Uint8Array; reserved: number }> {
	let lastError = "";
	for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
		if (attempt) await new Promise((r) => setTimeout(r, RETRY_WAITS_MS[attempt - 1]));
		let res: Response;
		let reserved = 0;
		try {
			res = await fetch(url);
			if (res.ok) {
				reserved = Number(res.headers.get("content-length")) || 0;
				await reserveBytes(reserved);
				const body = new Uint8Array(await res.arrayBuffer());
				// fetch decompresses, so a compressed response's length says nothing about the body
				if (reserved && !res.headers.get("content-encoding") && body.length !== reserved) throw new Error(`got ${body.length} of ${reserved} bytes`);
				return { headers: res.headers, body, reserved };
			}
		} catch (e) {
			releaseBytes(reserved);
			lastError = (e as Error).message;
			continue;
		}
		lastError = `HTTP ${res.status}`;
		if (res.status < 500) break;
	}
	throw new Error(lastError);
}

/**
 * Bring one source up to date. A source whose rows exist, whose URL is unchanged and whose file is
 * in storage is done: only changed alt text or caption is written. Anything else is downloaded,
 * stored, then recorded. The rows come last, so a source with rows is complete.
 */
async function preloadOne(source: MediaSource, ledger: Ledger, storage: Storage): Promise<{ entry: LedgerEntry; bytes: number; outcome: Outcome; unusedKey?: string }> {
	const known = await ledger.db
		.selectFrom("takeshape_media_sources as s")
		.innerJoin("media as m", "m.id", "s.media_id")
		.select(["s.source_url", "s.storage_key", "m.id", "m.filename", "m.mime_type", "m.size", "m.width", "m.height", "m.alt", "m.caption", "m.status"])
		.where("s.source_key", "=", source.key)
		.executeTakeFirst();
	// The file must be there in full: a write cut short (killed run, full disk) leaves a smaller file behind
	if (known && known.source_url === source.fetchUrl && known.status === "ready" && (await storedSize(known.storage_key)) === known.size) {
		if ((known.alt ?? undefined) !== source.alt || (known.caption ?? undefined) !== source.caption) {
			await ledger.media.update(known.id, { alt: source.alt ?? null, caption: source.caption ?? null });
		}
		const entry: LedgerEntry = { mediaId: known.id, storageKey: known.storage_key, filename: known.filename, mimeType: known.mime_type, width: known.width ?? undefined, height: known.height ?? undefined, alt: source.alt };
		return { entry, bytes: 0, outcome: "present" };
	}

	const { headers, body, reserved } = await download(source.fetchUrl);
	try {
		return await storeDownload(source, ledger, storage, known, headers, body);
	} finally {
		releaseBytes(reserved);
	}
}

type KnownSource = { source_url: string; storage_key: string; id: string };

async function storeDownload(
	source: MediaSource,
	ledger: Ledger,
	storage: Storage,
	known: KnownSource | undefined,
	headers: Headers,
	body: Uint8Array,
): Promise<{ entry: LedgerEntry; bytes: number; outcome: Outcome; unusedKey?: string }> {
	const m = preloadModules!;
	const header = headers.get("content-type");
	const mimeType = header && baseMime(header) !== "application/octet-stream" ? header : source.exportMimeType || "application/octet-stream";
	const dims = mimeType.startsWith("image/") ? await m.enrichImageMetadata(body, mimeType, NO_DECODE) : {};
	const contentHash = await m.computeContentHash(body);
	const storageKey = storageKeyFor(source, mimeType);
	await storage.upload({ key: storageKey, body, contentType: mimeType });
	// What the CDN reported, as the spec says; download() already checked the body against it
	const reportedSize = Number(headers.get("content-length")) || body.length;
	const sourceRow = { source_url: source.fetchUrl, source_size: reportedSize, source_etag: headers.get("etag"), storage_key: storageKey, updated_at: new Date().toISOString() };
	let mediaId: string;
	if (known) {
		// Same media row, new bytes: the file went missing, or TakeShape now serves it from a new path
		mediaId = known.id;
		await ledger.db
			.updateTable("media")
			.set({ filename: source.filename, mime_type: mimeType, size: body.length, width: dims.width ?? null, height: dims.height ?? null, alt: source.alt ?? null, caption: source.caption ?? null, storage_key: storageKey, content_hash: contentHash, status: "ready" })
			.where("id", "=", known.id)
			.execute();
		await ledger.db.updateTable("takeshape_media_sources").set(sourceRow).where("source_key", "=", source.key).execute();
	} else {
		const item = await ledger.media.create({
			filename: source.filename,
			mimeType,
			size: body.length,
			width: dims.width,
			height: dims.height,
			alt: source.alt,
			caption: source.caption,
			storageKey,
			contentHash,
			status: "ready",
		});
		mediaId = item.id;
		await ledger.db.insertInto("takeshape_media_sources").values({ source_key: source.key, media_id: mediaId, ...sourceRow }).execute();
	}
	return {
		entry: { mediaId, storageKey, filename: source.filename, mimeType, width: dims.width, height: dims.height, alt: source.alt },
		bytes: body.length,
		outcome: known && known.source_url !== source.fetchUrl ? "refreshed" : "downloaded",
		unusedKey: known && known.storage_key !== storageKey ? known.storage_key : undefined,
	};
}

async function preloadMedia(uses: Map<string, SourceUse>, ledger: Ledger, storage: Storage, concurrency: number): Promise<PreloadResult> {
	const result: PreloadResult = { entries: new Map(), downloaded: 0, present: 0, refreshed: 0, bytes: 0, failed: [], unused: [] };
	const queue = [...uses.values()];
	let next = 0;
	let done = 0;
	let lastProgress = Date.now();
	const worker = async () => {
		while (next < queue.length) {
			const use = queue[next++];
			try {
				const { entry, bytes, outcome, unusedKey } = await preloadOne(use.source, ledger, storage);
				result.entries.set(use.source.key, entry);
				result[outcome]++;
				result.bytes += bytes;
				if (unusedKey) result.unused.push(unusedKey);
			} catch (e) {
				result.failed.push({ use, error: (e as Error).message });
			}
			done++;
			if (Date.now() - lastProgress >= 2000) {
				lastProgress = Date.now();
				process.stderr.write(`Preloading media: ${done}/${queue.length}, ${result.failed.length} failed\n`);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
	return result;
}

/**
 * Upsert the media rows this seed uses into the EmDash database, keeping ids and storage keys.
 * Only sources that are complete this run are copied: a source the content no longer uses, or one
 * whose file is missing, stays in the ledger (site export refuses a ready row without its file).
 */
async function copyMediaRows(ledger: Ledger, databaseFile: string, mediaIds: Iterable<string>): Promise<{ copied: number; foreign: number }> {
	const m = preloadModules!;
	await mkdir(dirname(resolve(databaseFile)), { recursive: true });
	const target = new m.Kysely<any>({ dialect: m.createDialect({ url: `file:${resolve(databaseFile)}` }) });
	try {
		await m.runMigrations(target);
		const wanted = new Set(mediaIds);
		// Filtered here rather than with IN (...): tens of thousands of ids would pass SQLite's parameter limit
		const rows = (await ledger.db.selectFrom("media").selectAll().where("status", "=", "ready").execute()).filter((r) => wanted.has(r.id));
		await target.transaction().execute(async (trx) => {
			for (const row of rows) {
				const { id: _id, ...rest } = row;
				await trx.insertInto("media").values(row).onConflict((oc) => oc.column("id").doUpdateSet(rest)).execute();
			}
		});
		const inLedger = new Set((await ledger.db.selectFrom("media").select("id").execute()).map((r) => r.id));
		const all = await target.selectFrom("media").select("id").execute();
		return { copied: rows.length, foreign: all.filter((r) => !inLedger.has(r.id)).length };
	} finally {
		await target.destroy();
	}
}

/**
 * Replace each $media whose source was preloaded with the value EmDash stores for that media row.
 * Media that could not be preloaded is left out: a field loses its value, an image list loses the
 * item, rich text loses the image block, and anything else becomes null.
 */
function rewriteSeedMedia(s: SeedFile, entries: Map<string, LedgerEntry>): { replaced: number; dropped: number; links: Set<string> } {
	let replaced = 0;
	let dropped = 0;
	const links = new Set<string>();
	const DROP = Symbol("drop");
	const walk = (v: unknown, inList = false): unknown => {
		// A value that names a moved file points at its copy in the media library
		if (typeof v === "string") {
			const e = isCdnUrl(v) ? entries.get(sourceForUrl(v).key) : undefined;
			if (!e) return v;
			links.add(v);
			return movedUrl(v, e.storageKey);
		}
		if (Array.isArray(v)) return v.map((x) => walk(x, true)).filter((x) => x !== DROP);
		if (!isObj(v)) return v;
		// A Portable Text image block references its media row instead of holding the value
		const blockMedia = v._type === "image" && isObj(v.asset) ? v.asset.$media : undefined;
		if (isObj(blockMedia) && typeof blockMedia.url === "string") {
			const e = entries.get(sourceForUrl(blockMedia.url).key);
			if (!e) {
				dropped++;
				return DROP;
			}
			replaced++;
			// Only the block's own alt: emdash seed leaves a block without one as it is, and TakeShape printed none
			const alt = str(v.alt) ?? str(blockMedia.alt);
			const caption = str(v.caption);
			// Keys such as alignment, title and link stay, as they do when emdash seed resolves the $media itself; a link to
			// a moved file points at its copy
			const other = Object.fromEntries(
				Object.entries(v)
					.filter(([k]) => !["_type", "_key", "asset", "alt", "caption", "width", "height"].includes(k))
					.map(([k, x]) => [k, walk(x)]),
			);
			return {
				_type: "image",
				...(typeof v._key === "string" ? { _key: v._key } : {}),
				...other,
				asset: { _type: "reference", _ref: e.mediaId, url: `/_emdash/api/media/file/${e.storageKey}`, provider: "local" },
				...(alt ? { alt } : {}),
				...(caption ? { caption } : {}),
				...(e.width !== undefined ? { width: e.width } : {}),
				...(e.height !== undefined ? { height: e.height } : {}),
			};
		}
		const media = v.$media;
		if (isObj(media) && typeof media.url === "string") {
			const e = entries.get(sourceForUrl(media.url).key);
			if (!e) {
				dropped++;
				return DROP;
			}
			replaced++;
			const alt = str(media.alt) ?? e.alt;
			const title = str(media.title);
			return {
				provider: "local",
				id: e.mediaId,
				...(alt ? { alt } : {}),
				...(e.width !== undefined ? { width: e.width } : {}),
				...(e.height !== undefined ? { height: e.height } : {}),
				mimeType: e.mimeType,
				filename: e.filename,
				meta: { storageKey: e.storageKey, ...(title ? { title } : {}) },
			};
		}
		const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		const keys = Object.keys(out);
		// An image list item that only held the media goes with it
		if (inList && keys.length === 1 && out[keys[0]] === DROP) return DROP;
		for (const k of keys) if (out[k] === DROP) out[k] = null;
		return out;
	};
	for (const list of Object.values(s.content ?? {})) {
		for (const entry of list) {
			for (const [field, value] of Object.entries(entry.data)) {
				const w = walk(value);
				if (w === DROP) delete entry.data[field];
				else entry.data[field] = w;
			}
		}
	}
	return { replaced, dropped, links };
}

// Above this many images and files, emdash seed's one-at-a-time downloads get slow and a rerun duplicates them
const PRELOAD_HINT_ABOVE = 1000;
const mediaCount = opts.preloadMedia ? 0 : collectMediaSources(seed).size;
const preloadHint =
	mediaCount > PRELOAD_HINT_ABOVE
		? `This project uses ${mediaCount.toLocaleString("en-US")} images and files. For a faster import that is safe to rerun, add --preload-media local.`
		: null;

let preloaded: { result: PreloadResult; ledgerFile: string; copied: number; foreign: number; movedLinks: number } | null = null;
if (opts.preloadMedia) {
	const ledgerFile = opts.mediaLedger ?? join(dirname(resolve(opts.out)), "takeshape-media.db");
	const ledger = await openLedger(ledgerFile);
	try {
		const storage = new preloadModules!.LocalStorage({ directory: resolve(opts.uploadsDir), baseUrl: "/_emdash/api/media/file" });
		const result = await preloadMedia(collectMediaSources(seed), ledger, storage, opts.mediaConcurrency);
		const { copied, foreign } = await copyMediaRows(ledger, opts.database, [...result.entries.values()].map((e) => e.mediaId));
		const { links } = rewriteSeedMedia(seed, result.entries);
		for (const href of links) report.tsLinks.delete(href);
		preloaded = { result, ledgerFile, copied, foreign, movedLinks: links.size };
		console.log(
			`✔ Preloaded ${result.entries.size} images and files into ${opts.uploadsDir} (${result.downloaded + result.refreshed} downloaded, ${result.present} already there, ${result.failed.length} failed)`,
		);
	} finally {
		await ledger.close();
	}
}

// Values that still name a file on TakeShape's CDN (all of them without the preload) go in the report
noteRemainingCdnUrls(seed);

/** Every object key sorted, so the same export always writes the same bytes. */
function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (!isObj(v)) return v;
	return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
}

function propertyEntry(f: FieldPlan): PropertyMapEntry | null {
	const nameOfSlug = (slug: string) => collectionPlans.find((p) => p.slug === slug)?.name ?? slug;
	switch (f.kind) {
		case "scalar":
			return { kind: "scalar", field: f.slug, type: f.type };
		case "draft":
			return { kind: "richText", field: f.slug, format: "draftjs" };
		case "markdown":
			return { kind: "richText", field: f.slug, format: "markdown" };
		case "draftText":
			return { kind: "richTextPlain", field: f.slug };
		case "asset":
			return { kind: "asset", field: f.slug, multiple: false };
		case "assetList":
			return { kind: "asset", field: f.slug, multiple: true };
		case "reference":
			return { kind: "reference", field: f.slug, target: nameOfSlug(f.target ?? ""), multiple: Boolean(f.multiple), relation: f.relation ?? null };
		case "taxonomy":
			return { kind: "taxonomy", taxonomy: f.taxonomy ?? "", target: plans.get(f.targetShape ?? "")?.name ?? "", multiple: f.multiple ?? true };
		case "repeater": {
			const properties: Record<string, PropertyMapEntry> = {};
			const depth = f.prop.split(".").length;
			for (const sf of f.subPlans ?? []) {
				const e = propertyEntry(sf);
				if (e) placeProperty(properties, sf.prop.split(".").slice(depth).join("."), e);
			}
			return { kind: "repeater", field: f.slug, properties };
		}
		case "json":
			return { kind: "json", field: f.slug };
		case "entrySlug":
			return { kind: "entrySlug" };
		default:
			return null;
	}
}

/** Whether a dotted property path runs through an entry that is a field (JSON, a repeater), not an inline object. */
function insideField(root: Record<string, PropertyMapEntry>, dotted: string): boolean {
	let at = root;
	for (const part of dotted.split(".").slice(0, -1)) {
		const next = at[part];
		if (!next) return false;
		if (next.kind !== "object") return true;
		at = next.properties;
	}
	return false;
}

/** Put an entry at a dotted property path, creating the object entries on the way. */
function placeProperty(root: Record<string, PropertyMapEntry>, dotted: string, entry: PropertyMapEntry) {
	const parts = dotted.split(".");
	let at = root;
	for (const part of parts.slice(0, -1)) {
		let next = at[part];
		if (next?.kind !== "object") next = at[part] = { kind: "object", properties: {} };
		at = next.properties;
	}
	at[parts[parts.length - 1]] = entry;
}

function buildFieldMap(): FieldMap {
	const shapesOut: Record<string, ShapeMapEntry> = {};
	for (const s of report.skippedShapes) {
		const shape = shapes[s.shape];
		shapesOut[s.shape] = { kind: "skipped", shapeId: shape?.id ?? s.shape, reason: s.reason };
	}
	const reverse = new Map<string, Record<string, { shape: string; property: string }>>();
	for (const plan of collectionPlans) {
		for (const f of plan.fields) {
			if (f.kind !== "reference" || !f.relatedName) continue;
			const target = collectionPlans.find((p) => p.slug === f.target);
			if (!target) continue;
			const rev = reverse.get(target.id) ?? {};
			rev[f.relatedName] = { shape: plan.name, property: f.prop };
			reverse.set(target.id, rev);
		}
	}
	for (const plan of plans.values()) {
		if (plan.kind === "taxonomy") {
			shapesOut[plan.name] = { kind: "taxonomy", shapeId: plan.id, taxonomy: plan.taxonomy, labelProperty: plan.labelProp ?? "", slugProperty: plan.slugProp ?? null };
			continue;
		}
		const properties: Record<string, PropertyMapEntry> = {};
		const all = plan.slugFrom ? [plan.slugFrom, ...plan.fields] : plan.fields;
		for (const f of all) {
			if (f.declares) continue;
			const e = propertyEntry(f);
			if (e) placeProperty(properties, f.prop, e);
		}
		// A skipped field inside a field the converter kept whole (a JSON list of objects) is part of that field's value
		for (const s of report.skippedFields) if (s.shape === plan.name && !insideField(properties, s.prop)) placeProperty(properties, s.prop, { kind: "skipped", reason: s.reason });
		shapesOut[plan.name] = {
			kind: "collection",
			shapeId: plan.id,
			collection: plan.slug,
			single: !plan.routable,
			legacy: opts.legacyFields ? { id: "takeshape_id", publishedAt: "takeshape_published_at", createdAt: "takeshape_created_at", updatedAt: "takeshape_updated_at" } : null,
			richTextSidecar: plan.fields.some((f) => f.kind === "richTextSidecar") ? "takeshape_rich_text" : null,
			termOrder: plan.fields.some((f) => f.kind === "termOrder") ? "takeshape_term_order" : null,
			linkOrder: plan.fields.some((f) => f.kind === "linkOrder") ? LINK_ORDER : null,
			properties,
			reverse: reverse.get(plan.id) ?? {},
		};
	}
	return { version: 1, shapes: shapesOut };
}

await mkdir(dirname(resolve(opts.out)), { recursive: true });
await writeFile(opts.out, `${JSON.stringify(seed, null, 2)}\n`);
const fieldMapFile = opts.fieldMap ?? join(dirname(resolve(opts.out)), "takeshape-field-map.json");
await mkdir(dirname(resolve(fieldMapFile)), { recursive: true });
await writeFile(fieldMapFile, `${JSON.stringify(sortKeys(buildFieldMap()), null, 2)}\n`);

// ---------------------------------------------------------------------------
// Optional asset backup
// ---------------------------------------------------------------------------

let downloaded: { ok: number; failed: string[] } | null = null;
const backupDir = opts.downloadAssets;
if (backupDir) {
	const backup = { ok: 0, failed: [] as string[] };
	downloaded = backup;
	const list = [...assets.values()];
	let next = 0;
	const worker = async () => {
		while (next < list.length) {
			const a = list[next++];
			const dest = join(backupDir, a.path);
			if (existsSync(dest)) {
				backup.ok++;
				continue;
			}
			// Write next to the final path and rename once complete, so a download
			// that dies mid-stream never sits where a rerun counts it as done
			const part = `${dest}.part`;
			try {
				await mkdir(dirname(dest), { recursive: true });
				const res = await fetch(`${ASSET_BASE}/${escapePath(a.path)}`).then((r) => (r.ok ? r : fetch(a.url)));
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(part));
				// Over HTTP/2 a stream can end early without an error, so check the size before keeping it
				const expected = Number(res.headers.get("content-length"));
				const written = (await stat(part)).size;
				if (expected && !res.headers.get("content-encoding") && written !== expected) throw new Error(`got ${written} of ${expected} bytes`);
				await rename(part, dest);
				backup.ok++;
			} catch (e) {
				await rm(part, { force: true });
				backup.failed.push(`${a.url} (${(e as Error).message})`);
			}
		}
	};
	await Promise.all(Array.from({ length: 6 }, worker));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

// Drafts that published entries link to. TakeShape returned a relationship's targets whatever their status, so the old
// site could show an unpublished entry wherever a published one linked to it; EmDash's public pages show published
// entries only. The report lists each, for the owner to publish the ones that should be public.
const rowById = new Map(rows.map((r) => [r._id, r] as const));
const entryOfSeedId = new Map(collectionPlans.flatMap((p) => p.entries.map((e) => [e.id, { plan: p, entry: e }] as const)));
const linkedDrafts = new Map<string, Set<string>>(); // draft's seed id → each published entry linking to it, "<collection>/<slug>"
for (const r of rows) {
	const from = entryOfSeedId.get(seedIdOf(r._id));
	if (!from || !isPublished(r)) continue;
	const walk = (v: unknown): void => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (!isObj(v)) return;
		if ((typeof v.shapeId === "string" || typeof v.contentTypeId === "string") && typeof v.id === "string") {
			const target = rowById.get(v.id);
			const to = entryOfSeedId.get(seedIdOf(v.id));
			if (target && to && target !== r && !isPublished(target)) {
				const referrers = linkedDrafts.get(to.entry.id) ?? new Set<string>();
				// A single entry is its collection; a routable one adds its slug
				referrers.add(from.plan.routable ? `${from.plan.slug}/${from.entry.slug ?? from.entry.id.slice(3)}` : from.plan.slug);
				linkedDrafts.set(to.entry.id, referrers);
			}
			return;
		}
		for (const x of Object.values(v)) walk(x);
	};
	for (const [k, v] of Object.entries(r)) if (!k.startsWith("_")) walk(v);
}

const lines: string[] = [];
const L = (s = "") => lines.push(s);
const totalEntries = collectionPlans.reduce((n, p) => n + p.entries.length, 0);
L("# TakeShape to EmDash migration report");
L();
L(`Generated ${new Date().toISOString()} from \`${schemaPath}\`.`);
L();
L("## Summary");
L();
L(`- **${collectionPlans.length}** collections, **${totalEntries}** entries`);
L(`- **${seedTaxonomies.length}** taxonomies, **${seedTaxonomies.reduce((n, t) => n + (t.terms?.length ?? 0), 0)}** terms`);
L(
	preloaded
		? `- **${report.assets.referenced.size}** of ${report.assets.total} assets are used by content and were preloaded into \`${opts.uploadsDir}\``
		: `- **${report.assets.referenced.size}** of ${report.assets.total} assets are used by content and will be copied into EmDash when the seed is applied`,
);
if (downloaded) L(`- Asset backup: ${downloaded.ok} downloaded to \`${opts.downloadAssets}\`, ${downloaded.failed.length} failed`);
L(`- Seed file: \`${opts.out}\``);
L(`- Field map: \`${fieldMapFile}\``);
if (preloadHint) L(`- ${preloadHint}`);
if (linkedDrafts.size) L(`- **${linkedDrafts.size}** ${linkedDrafts.size === 1 ? "draft is" : "drafts are"} linked from published entries: see "Drafts that published entries link to"`);
if (preloaded) {
	const r = preloaded.result;
	const sources = r.entries.size + r.failed.length;
	L();
	L("## Media preload");
	L();
	L("- Mode: local");
	L(`- Ledger: \`${preloaded.ledgerFile}\``);
	L(`- Database: \`${opts.database}\`, files in \`${opts.uploadsDir}\``);
	L(`- ${sources} sources: ${r.downloaded} downloaded this run, ${r.present} already present, ${r.refreshed} refreshed, ${r.failed.length} failed (${r.bytes} bytes)`);
	if (r.unused.length) L(`- No longer used (their TakeShape files changed type), safe to delete from \`${opts.uploadsDir}\`: ${r.unused.map((k) => `\`${k}\``).join(", ")}`);
	if (preloaded.movedLinks) L(`- ${preloaded.movedLinks} rich-text links to files on TakeShape's CDN now point at their copies in the media library`);
	for (const f of r.failed) L(`- Failed: ${f.use.source.fetchUrl} (${f.error})`);
}
if (opts.site) {
	L();
	L("## Slugs taken from your site's URLs");
	L();
	L(`Read from \`${opts.site}\`. ${siteSlugs.size === 1 ? "1 entry has the slug its page" : `${siteSlugs.size} entries have the slugs their pages`} had on the old site, so those pages keep their URLs. ${siteSlugChanges.length} differ from the slug the converter gives without --site.`);
	if (siteSlugChanges.length) L();
	for (const c of siteSlugChanges.slice(0, 100)) L(`- \`${c.collection}\`: \`${c.from}\` is now \`${c.to}\``);
	if (siteSlugChanges.length > 100) L(`- ...and ${siteSlugChanges.length - 100} more`);
	if (siteSlugNotes.length) {
		L();
		for (const n of siteSlugNotes) L(`- ${n}`);
	}
}
L();
L("## Collections");
for (const plan of collectionPlans) {
	L();
	L(`### ${plan.name} → \`${plan.slug}\`${plan.routable ? "" : " (single entry)"}`);
	L();
	const slugNote = !plan.routable ? "" : plan.slugFrom ? ` Entry slugs come from \`${plan.slugFrom.prop}\`.` : " Entry slugs are generated from the title.";
	L(`${plan.entries.length} ${plan.entries.length === 1 ? "entry" : "entries"} (${plan.published} published, ${plan.entries.length - plan.published} drafts).${slugNote}`);
	L();
	L("| TakeShape property | EmDash field | Type | Notes |");
	L("| --- | --- | --- | --- |");
	for (const f of plan.fields) {
		const type = f.kind === "taxonomy" ? `taxonomy \`${f.taxonomy}\`` : f.type === "reference" ? `reference → \`${f.target}\`${f.multiple ? " (many)" : ""}` : f.type;
		L(`| \`${f.prop}\` | ${f.kind === "taxonomy" ? "(taxonomy terms)" : `\`${f.slug}\``} | ${type} | ${f.note ?? (f.kind === "draft" ? "Draft.js rich text converted" : f.kind?.startsWith("legacy") ? "Added for reference during cutover" : "")} |`);
	}
}
if (seedTaxonomies.length) {
	L();
	L("## Taxonomies");
	L();
	for (const t of report.taxonomies) L(`- ${t.shape} → \`${t.name}\`: ${t.terms} terms, used by ${t.collections.map((c) => `\`${c}\``).join(", ") || "no collections"}`);
}
if (report.skippedShapes.length || report.skippedFields.length) {
	L();
	L("## Not migrated");
	L();
	for (const s of report.skippedShapes) L(`- Shape **${s.shape}**: ${s.reason}`);
	for (const s of report.skippedFields) L(`- \`${s.shape}.${s.prop}\`: ${s.reason}`);
}
const attention = [];
for (const w of report.warnings) attention.push(w);
const one = (n: number, singular: string, plural: string) => (n === 1 ? singular : plural);
for (const [type, n] of report.inlineEntities) {
	attention.push(
		/^image$/i.test(type)
			? `${n} ${one(n, "image", "images")} inside rich text paragraphs (entity "${type}") ${one(n, "was", "were")} not converted. ${one(n, "Its", "Their")} paragraph text was kept as plain text.`
			: `${n} rich text ${one(n, "range", "ranges")} with a "${type}" entity ${one(n, "was", "were")} kept as plain text. The ${one(n, "entity was", "entities were")} not converted.`,
	);
}
if (report.missingImages) {
	const n = report.missingImages;
	attention.push(`${n} rich text ${one(n, "image points at an asset", "images point at assets")} missing from the export. ${one(n, "It was", "They were")} kept as TakeShape's fallback HTML, an empty figure.`);
}
for (const [type, n] of report.fallbackBlocks) {
	attention.push(`${n} rich text ${one(n, "block", "blocks")} of type "${type}" ${one(n, "was", "were")} not converted. ${one(n, "It was", "They were")} kept as TakeShape's fallback HTML, a figure holding the block's text.`);
}
if (report.nestedBlocks) {
	const n = report.nestedBlocks;
	attention.push(`${n} rich text ${one(n, "block", "blocks")} that TakeShape nested under a list item (usually a paragraph indented in the list) now ${one(n, "renders", "render")} at the top level, after the list.`);
}
for (const [style, n] of report.droppedStyles) attention.push(`${n} rich text range(s) styled ${style} kept their text but lost the style, because EmDash's editor has no matching mark.`);
if (report.unresolved.length) attention.push(`${report.unresolved.length} relationship(s) point at entries missing from the export and were dropped (first: ${report.unresolved[0].where} → ${report.unresolved[0].target}).`);
if (downloaded?.failed.length) attention.push(`${downloaded.failed.length} asset download(s) failed, for example ${downloaded.failed[0]}.`);
for (const f of preloaded?.result.failed ?? []) {
	attention.push(
		`${f.use.source.fetchUrl} could not be preloaded (${f.error}) and was left out of the seed. Used by ${[...f.use.usedBy].slice(0, 3).join(", ")}. Run the converter again to retry.`,
	);
}
if (preloaded?.foreign) {
	attention.push(
		`\`${opts.database}\` already holds ${preloaded.foreign} media row(s) that this preload did not create, probably from an earlier import without --preload-media. For a clean result, delete \`${opts.database}\` and run the converter again.`,
	);
}
if (attention.length) {
	L();
	L("## Needs your attention");
	L();
	for (const a of attention) L(`- ${a}`);
}
if (linkedDrafts.size) {
	const n = linkedDrafts.size;
	L();
	L("## Drafts that published entries link to");
	L();
	L(
		`TakeShape returned an unpublished entry wherever a published one linked to it, so your old site may have shown ${n === 1 ? "this draft" : "these drafts"}. EmDash's public pages show published entries only, so ${n === 1 ? "it stays" : "each one stays"} hidden until you publish it in EmDash's admin. Publish the ones that should be public; the rest can stay drafts.`,
	);
	L();
	L("| Draft | Collection | Slug | Linked from | Published entries that link to it |");
	L("| --- | --- | --- | --- | --- |");
	const cell = (t: unknown) => String(t ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ");
	const drafts = [...linkedDrafts].map(([id, referrers]) => ({ ...entryOfSeedId.get(id)!, referrers: [...referrers].sort() }));
	drafts.sort((a, b) => b.referrers.length - a.referrers.length || a.plan.slug.localeCompare(b.plan.slug) || String(a.entry.slug).localeCompare(String(b.entry.slug)));
	for (const { plan, entry, referrers } of drafts) {
		const title = plan.titleField ? entry.data[plan.titleField.slug] : undefined;
		const shown = referrers.slice(0, 5).map((x) => `\`${x}\``).join(", ");
		L(`| ${cell(typeof title === "string" && title ? title : (entry.slug ?? entry.id.slice(3)))} | \`${plan.slug}\` | \`${entry.slug ?? ""}\` | ${referrers.length} | ${shown}${referrers.length > 5 ? ", ..." : ""} |`);
	}
}
if (report.tsLinks.size) {
	L();
	L("## Links to TakeShape-hosted files");
	L();
	L("These links inside rich text point at TakeShape's CDN and will stop working after January 15, 2027. Upload the files to the EmDash media library and update the links.");
	L();
	for (const [url, where] of report.tsLinks) L(`- ${url} (in ${[...where].slice(0, 3).join(", ")}${where.size > 3 ? "…" : ""})`);
}
L();
L("## Next steps");
L();
if (stubCount) L(`> Some entries link to each other in a loop (for example, related posts that point at each other). The seed creates ${stubCount} placeholder entr${stubCount === 1 ? "y" : "ies"} first and fills ${stubCount === 1 ? "it" : "them"} in later, so always apply it with \`--on-conflict update\`.\n`);
L(`1. Validate: \`npx emdash seed ${opts.out} --validate\``);
L(
	preloaded
		? `2. Apply to the database the media went into: \`npx emdash seed ${opts.out} --database ${opts.database} --uploads-dir ${opts.uploadsDir} --on-conflict update\``
		: `2. Apply to a fresh local database: \`npx emdash seed ${opts.out} --database ./data.db --on-conflict update\``,
);
L("3. Start the dev server, open /_emdash/admin, and spot-check entries, images, and rich text.");
await writeFile(opts.report, `${lines.join("\n")}\n`);

console.log(`✔ Wrote ${opts.out}: ${collectionPlans.length} collections, ${totalEntries} entries, ${seedTaxonomies.length} taxonomies, ${report.assets.referenced.size} assets to copy`);
console.log(`✔ Wrote ${opts.report}${attention.length ? ` (${attention.length} item(s) need your attention)` : ""}`);
if (preloadHint) console.log(preloadHint);
