/**
 * Content rows with only the columns a read needs. EmDash's public list read, getEmDashCollection, selects every
 * column of every row and parses each one, and it has no way to choose columns: a page that lists hundreds of
 * entries for their titles read megabytes of rich text. This file reads a collection's table (`ec_<collection>`)
 * with the columns a loader names and maps each row as EmDash does, so a loader sees the same entries with fewer
 * fields in `data`.
 *
 * Written against EmDash 1.3.0's loader (loader.ts: loadCollection, mapRowToData, normalizeLocalMediaValue,
 * entryIdForRow, buildFieldConditions) and checked against it in test/tsg/rows.test.mts:
 *   - the rows a public list read returns: not deleted, one status, equality conditions bound as EmDash binds them
 *     (booleans as 1 and 0, more than 50 list values as one JSON parameter compared as text), EmDash's default
 *     order (created_at, then id, newest first), an optional limit;
 *   - each row as an entry: `id` the slug (else the id), system columns in `data` by their camelCase names with
 *     dates as Date objects, boolean fields as booleans, text that starts with `{` or `[` parsed as JSON and local
 *     media values normalized, anything else as stored;
 *   - revision ids left out, as a public read strips them.
 * Left out, as translated sites need none of it: locale prefixes in ids (one locale), the terms and bylines EmDash
 * hydrates into `data` (loaders read terms with getTermsForEntries), draft revisions (pages that serve drafts use
 * EmDash's read, see emdash-api.ts).
 *
 * Which columns a table has and which fields are booleans comes from `_emdash_fields`, read once a request for
 * every collection (fieldRows, which references.ts reads its bindings from too). The first read of a request goes
 * out in the same turn as that query, so a coalescing D1 driver sends both in one batch: it names the columns the
 * loader asks for, and only if one is missing (a field deleted in the admin) is it made again with those the table
 * has. A reference field has no column here: EmDash keeps its links in `_emdash_content_references`. `readRows`
 * answers null for a read it cannot make the way EmDash would (a condition on a taxonomy or on a column the table
 * lacks, a collection without a table), and the caller uses EmDash's.
 */
import type { getDb } from "emdash/runtime";
import type { Entry } from "./query.ts";

type Db = Awaited<ReturnType<typeof getDb>>;

/** What the reader needs from EmDash: its database for this request, and a map that lives as long as the request. */
export type RowDeps = { db(): Promise<Db>; store(): Map<string, unknown> };

/** One row of `_emdash_fields`, with its collection and, for a reference field, its validation and relation. */
export type FieldRow = { collection: string; field: string; type: string; validation: string | null; relationId: string | null };

/** A content table as this file reads it. */
type Table = { columns: Set<string>; booleans: Set<string> };

/** A public list read: one status, equality conditions, an optional limit. */
export type RowFilter = { status: string; where?: Record<string, unknown>; limit?: number };

// loader.ts INCLUDE_IN_DATA, less the revision ids a public read strips (query.ts stripRevisionMetadata)
const SYSTEM: Record<string, string> = {
	id: "id",
	status: "status",
	author_id: "authorId",
	primary_byline_id: "primaryBylineId",
	created_at: "createdAt",
	updated_at: "updatedAt",
	published_at: "publishedAt",
	scheduled_at: "scheduledAt",
	locale: "locale",
	translation_group: "translationGroup",
};
const DATE_COLUMNS = new Set(["created_at", "updated_at", "published_at", "scheduled_at"]);
// Columns every read selects: the system columns and the slug, which EmDash keeps in `data` under its own name
const ALWAYS = [...Object.keys(SYSTEM), "slug"];
// Names a loader may ask for that every read has anyway: the system columns, and `data`'s names for them
const ALWAYS_READ = new Set([...ALWAYS, ...Object.values(SYSTEM)]);
const MISSING_COLUMN = /no such column/i;
const MISSING_TABLE = /no such table/i;
// Columns a condition may name besides a table's fields
const CONDITION_COLUMNS = new Set([...ALWAYS, "deleted_at"]);
const FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// utils/chunks.ts SQL_BATCH_SIZE: more list values than this go in as JSON
const SQL_BATCH_SIZE = 50;
const LOCAL_MEDIA_FILE_PREFIX = "/_emdash/api/media/file/";
const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;
const FIELDS = "takeshape:fields";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The value a request's store holds under `key`, made by `make` the first time. */
function shared<T>(store: Map<string, unknown>, key: string, make: () => Promise<T>): Promise<T> {
	let found = store.get(key) as Promise<T> | undefined;
	if (!found) {
		found = make();
		store.set(key, found);
	}
	return found;
}

/**
 * Every field of every collection, once a request. Only a reference field's validation and relation are read: the
 * rest is the field's slug and type.
 */
export function fieldRows(deps: RowDeps): Promise<FieldRow[]> {
	return shared(deps.store(), FIELDS, async () => {
		const db = await deps.db();
		const rows = await db
			.selectFrom("_emdash_fields as f")
			.innerJoin("_emdash_collections as c", "c.id", "f.collection_id")
			.leftJoin("_emdash_relations as r", (join) => join.on((eb) => eb.and([eb("f.type", "=", "reference"), eb("r.slug", "=", eb.fn<string>("json_extract", ["f.validation", eb.val("$.relation")]))])))
			.select((eb) => ["c.slug as collection", "f.slug as field", "f.type as type", eb.case().when("f.type", "=", "reference").then(eb.ref("f.validation")).end().as("validation"), "r.id as relationId"])
			.execute();
		return rows.map((row) => ({ collection: String(row.collection), field: String(row.field), type: String(row.type), validation: (row.validation as string | null) ?? null, relationId: row.relationId ?? null }));
	});
}

const TABLES = "takeshape:tables";

/** Each collection's columns and boolean fields. */
function tables(deps: RowDeps): Promise<Map<string, Table>> {
	return shared(deps.store(), TABLES, async () => {
		const found = new Map<string, Table>();
		for (const row of await fieldRows(deps)) {
			let table = found.get(row.collection);
			if (!table) {
				table = { columns: new Set(), booleans: new Set() };
				found.set(row.collection, table);
			}
			if (row.type === "reference") continue;
			table.columns.add(row.field);
			if (row.type === "boolean") table.booleans.add(row.field);
		}
		return found;
	});
}

/** loader.ts normalizeLocalMediaValue: a local media value names its file by `/_emdash/api/media/file/<key>`. */
function normalizeLocalMedia(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeLocalMedia);
	if (!isObj(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) out[key] = normalizeLocalMedia(child);
	if (out.provider === "local" && typeof out.src === "string" && out.src.length > 0) {
		const src = out.src;
		if (src.startsWith(LOCAL_MEDIA_FILE_PREFIX)) {
			const id = src.slice(LOCAL_MEDIA_FILE_PREFIX.length);
			if (!out.id && id) out.id = id;
		} else if (!src.startsWith("/") && !URL_SCHEME.test(src)) {
			if (!out.id) out.id = src;
			out.src = `${LOCAL_MEDIA_FILE_PREFIX}${src}`;
		}
	}
	return out;
}

/** loader.ts mapRowToData and entryIdForRow, for the columns read. */
export function entryOf(row: Record<string, unknown>, booleans: ReadonlySet<string>): Entry {
	const data: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		const system = SYSTEM[key];
		if (system) {
			data[system] = DATE_COLUMNS.has(key) ? (typeof value === "string" ? new Date(value) : null) : value;
			continue;
		}
		if (booleans.has(key) && (typeof value === "boolean" || value === 0 || value === 1)) {
			data[key] = Boolean(value);
			continue;
		}
		if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
			try {
				data[key] = normalizeLocalMedia(JSON.parse(value));
			} catch {
				data[key] = value;
			}
			continue;
		}
		data[key] = value;
	}
	const slug = typeof row.slug === "string" ? row.slug : "";
	return { id: slug || (typeof row.id === "string" ? row.id : ""), data };
}

// The part of Kysely's query builder this file uses on a table EmDash's Database type does not list
type RowQuery = {
	select(columns: readonly string[]): RowQuery;
	where(column: string, op: string, value: unknown): RowQuery;
	orderBy(column: string, direction: "asc" | "desc"): RowQuery;
	limit(n: number): RowQuery;
	execute(): Promise<Array<Record<string, unknown>>>;
};
type JsonEach = { selectFrom(from: unknown): { select(column: string): unknown }; fn(name: string, args: unknown[]): { as(alias: string): unknown }; val(value: unknown): unknown };

/** loader.ts bindableFilterValue */
const bindable = (v: unknown): unknown => (typeof v === "boolean" ? (v ? 1 : 0) : v);

/**
 * The entries of a public list read of `collection` with `select`'s columns (those the table has) and the system
 * columns, or null when EmDash's read would apply a condition this one cannot.
 */
export async function readRows(deps: RowDeps, collection: string, filter: RowFilter, select: readonly string[]): Promise<Entry[] | null> {
	if (!FIELD_NAME.test(collection)) return null;
	const where = Object.entries(filter.where ?? {}).filter(([, v]) => v !== null && v !== undefined);
	// EmDash reads ranges as ranges: those stay EmDash's
	if (where.some(([f, v]) => !FIELD_NAME.test(f) || (isObj(v) && !(v instanceof Date)))) return null;
	const wanted = [...new Set(select.filter((c) => FIELD_NAME.test(c) && !ALWAYS_READ.has(c)))];
	const attempt = (columns: string[]) => queryRows(deps, collection, filter, where, columns).then((rows) => ({ rows }), (error: unknown) => ({ error }));
	// The fields and the rows in the same turn, so a coalescing driver sends them together
	const [table, first] = await Promise.all([tables(deps).then((t) => t.get(collection)), attempt(wanted)]);
	// EmDash reads a condition on a taxonomy through its terms; a collection without fields has no table yet
	if (!table || where.some(([f]) => !(CONDITION_COLUMNS.has(f) || table.columns.has(f)))) return null;
	let result = first;
	if ("error" in result) {
		const message = result.error instanceof Error ? result.error.message : String(result.error);
		if (MISSING_TABLE.test(message)) return null;
		const known = wanted.filter((c) => table.columns.has(c));
		if (!MISSING_COLUMN.test(message) || known.length === wanted.length) throw result.error;
		result = await attempt(known);
		if ("error" in result) throw result.error;
	}
	return result.rows.map((row) => entryOf(row, table.booleans));
}

/** The rows of a public list read with `columns` and the system columns. */
async function queryRows(deps: RowDeps, collection: string, filter: RowFilter, where: Array<[string, unknown]>, select: string[]): Promise<Array<Record<string, unknown>>> {
	const columns = [...ALWAYS, ...select];
	const db = (await deps.db()) as unknown as { selectFrom(table: string): RowQuery };
	let query = db.selectFrom(`ec_${collection}`).select(columns).where("deleted_at", "is", null).where("status", "=", filter.status);
	// buildFieldConditions: when the lists hold more than SQL_BATCH_SIZE values between them, the longest go in as JSON
	const lists = where.filter((e): e is [string, unknown[]] => Array.isArray(e[1])).sort((a, b) => b[1].length - a[1].length);
	let inline = lists.reduce((n, [, v]) => n + v.length, 0);
	const asJson = new Set<string>();
	for (const [f, v] of lists) {
		if (inline <= SQL_BATCH_SIZE) break;
		asJson.add(f);
		inline -= v.length;
	}
	for (const [field, value] of where) {
		if (!Array.isArray(value)) query = query.where(field, "=", bindable(value));
		else if (!value.length) continue;
		else if (asJson.has(field)) {
			const text = JSON.stringify(value.map((v) => String(bindable(v))));
			query = query.where(field, "in", (eb: JsonEach) => eb.selectFrom(eb.fn("json_each", [eb.val(text)]).as("j")).select("j.value"));
		} else query = query.where(field, "in", value.map(bindable));
	}
	query = query.orderBy("created_at", "desc").orderBy("id", "desc");
	if (filter.limit !== undefined && filter.limit > 0) query = query.limit(filter.limit);
	return query.execute();
}
