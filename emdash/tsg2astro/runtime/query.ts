/**
 * What the generated loaders in src/loaders call. Each loader asks EmDash for the data one GraphQL query file
 * asked TakeShape for, and builds an object shaped like TakeShape's response, so the templates keep their
 * expressions. These helpers carry TakeShape's rules, read from its API source:
 *
 * - A list query without `where` or `filter` returns published entries only. Either one turns that off, so
 *   drafts come back unless the clause filters on `_enabled` itself.
 * - A list query without `size` returns at most 20 entries, and `total` still counts every match. A list that
 *   takeshape-ssg paginated got every entry.
 * - The default order is newest `_createdAt` first. TakeShape broke ties by search score, which cannot be
 *   reproduced, so `takeshape_id` breaks them here, ascending. An explicit sort gets the same last key. A site
 *   converted with --no-legacy-fields has neither field, and lists come in EmDash's own order instead.
 * - An entry made in EmDash after the move has no TakeShape id or dates: `_id`, `_createdAt`, `_updatedAt`,
 *   `_enabledAt` and the sorts on them read EmDash's own values (fieldValue).
 * - Terms of an entry come in the order TakeShape kept them (`takeshape_term_order`), which EmDash does not hold.
 * - Relationship fields return their targets in stored order. EmDash keeps every reference field in its relation
 *   table, never in `data`, and its public reads return published entries only: a draft target reads as empty,
 *   and so does any reference of a draft entry. TakeShape resolved a relationship whatever its target's status.
 * - Reverse fields (`Author.authored`) are lists with the same rules as list queries.
 *
 * Every read names the columns its loader builds entries from (`select`; null reads every column), so a page that
 * lists entries for their titles reads no rich text (rows.ts). A list that is cut, by `size` and `from` or by a
 * route's pick (an item or listing page needs only its own entries), and that builds from rich text or JSON
 * (`heavy`), reads in two steps: first the columns that decide the list and the light ones for every entry, then
 * `select`'s columns for the entries it keeps.
 *
 * Every EmDash call goes through an EmDashApi, so tests can pass a stub. emdash-api.ts holds the real one.
 * Migrated sites get this file as source. It imports only files in this folder.
 */
import { draftRaw } from "./draft-raw.ts";
import type { DraftRawValue } from "./draft-raw.ts";
import { imageEndpointUrl } from "./imgix.ts";
import type { PTBlock, RichTextSidecar } from "./portable-text.ts";
import { absoluteUrl } from "./public-origin.ts";
import { renderRichText, withoutBlockBreaks } from "./richtext.ts";
import type { ImageParams, RichTextOptions } from "./richtext.ts";

/** An EmDash entry: `id` is its slug, `data.id` its EmDash id, and the rest of `data` its fields. */
export type Entry = { id: string; data: Record<string, unknown> };
/** Entries in order, with `total` counting every entry that matched before `from` and `size` applied. */
export type EntryList = Entry[] & { total: number };
export type Term = { slug: string; label: string };

/** The columns a read needs, or null for every column. */
export type Select = readonly string[] | null;

/** The EmDash reads the loaders need. */
export interface EmDashApi {
	/**
	 * getEmDashCollection: `filter` takes `status`, `where` and `limit`, and `select`, the columns the loader reads
	 * (rows.ts), which a read may exceed. Reference fields are not in `data`.
	 */
	collection(type: string, filter: Record<string, unknown>): Promise<{ entries: Entry[]; nextCursor?: string }>;
	/** getEmDashEntry: a published entry by slug or EmDash id. */
	entry(type: string, slugOrId: string): Promise<Entry | null>;
	/** getTermsForEntries: each entry's terms of one taxonomy, by EmDash entry id, in label order. */
	terms(collection: string, entryIds: string[], taxonomy: string): Promise<Map<string, Array<{ slug: string; label: string }>>>;
	/**
	 * getEmDashReferences for many entries at once: for each entry (by EmDash id), the entries one reference field
	 * points at, in stored order. Published entries only, whatever the entry's own status (references.ts).
	 */
	references(collection: string, entries: readonly Entry[], field: string, select?: Select): Promise<Map<string, Entry[]>>;
	/**
	 * The other way round: for each target entry (by EmDash id), the published entries of `collection` whose
	 * reference `field` points at it, in no set order, whatever the target's own status.
	 */
	referrers(collection: string, field: string, targets: readonly Entry[], select?: Select): Promise<Map<string, Entry[]>>;
	/** The published entries of a collection with these EmDash ids, which the links inside JSON fields hold. */
	byIds(collection: string, ids: string[], select?: Select): Promise<Entry[]>;
}

export type SortKey = { field: string; order: "asc" | "desc" };
/**
 * A query field's arguments with EmDash names. `where` and `filter` hold the equality clauses that could be
 * carried over, as `{ field: value }` or `{ field: [values] }`, plus `_enabled: true | false` when the query
 * filtered on it. An empty object means the query had the argument but nothing in it could be carried over.
 */
/**
 * `exclude`: a filter's must_not, the entries to leave out when a field holds any of the values. `through`: conditions
 * on the entries a reference field points at, one of which must match.
 */
export type QueryArgs = {
	sort: SortKey[];
	where: unknown | null;
	filter: unknown | null;
	size: number | null;
	from: number | null;
	id: string | null;
	exclude?: Record<string, unknown>;
	through?: Array<{ field: string; where: Record<string, unknown> }>;
	/** Conditioned fields that hold lists (multi-select): matched in memory, a list matching when it holds the value. */
	arrayFields?: string[];
};
/**
 * What a route needs from the list it pages through (context.ts itemPick, listingPick): the columns its paths read,
 * and, from the whole list in order, the entries its page shows. Only those are read in full and built.
 */
export type Pick = { columns: readonly string[]; entries(list: Entry[]): Entry[] };
/**
 * `legacyFields: false` for a site converted with --no-legacy-fields: EmDash's order replaces TakeShape's.
 * `select`: the columns the loader builds the entries from, and of those `heavy`, the ones that can hold a lot (rich
 * text, JSON), read only for the entries a cut list keeps; without it, all of `select`. `pick`: a route's pick,
 * after `from` and `size`.
 */
export type ListOptions = { includeDrafts: boolean; defaultSize: number | null; legacyFields?: boolean; select?: Select; heavy?: readonly string[]; pick?: Pick };
export type Variables = Record<string, unknown>;
/**
 * `paginate` loads the list takeshape-ssg paginated in full, as it did for a route's `paginate.data`; `pick`
 * keeps the entries of it one page needs.
 */
export type LoadOptions = { paginate?: boolean; pick?: Pick };
export type AssetValue = {
	path: string;
	/** TakeShape answered https://images.takeshape.io/<path>; here the stored file, as the asset filter gives it. */
	url: string;
	title: string | null;
	description: string | null;
	caption: string | null;
	credit: string | null;
	filename: string | null;
	mimeType: string | null;
};
/** The entries a reference field points at, for each entry, and every one of them once. */
export type ReferenceLookup = { of(entry: Entry): Entry[]; entries: Entry[] };
/** The entries of a reverse field, for each parent entry. */
export type ReverseLookup = { of(parent: Entry): EntryList; entries: Entry[] };
/** The terms of one taxonomy, for each entry. */
export type TermLookup = { of(entry: Entry): Term[] };
/** The entries links inside JSON fields name: one per link, and every one read in a collection. */
export type LinkLookup = { of(link: unknown): Entry | null; entries(collection: string): Entry[] };

/** How many entries TakeShape returned from a list without `size`. */
export const TAKESHAPE_LIST_SIZE = 20;
const MEDIA_FILE_PATH = "/_emdash/api/media/file";
const DEFAULT_ORDER: SortKey[] = [{ field: "takeshape_created_at", order: "desc" }];
const TIE_BREAK: SortKey = { field: "takeshape_id", order: "asc" };
// EmDash's own order (getEmDashCollection without orderBy): created_at, then id, both descending
const EMDASH_ORDER: SortKey[] = [{ field: "createdAt", order: "desc" }];
const EMDASH_TIE_BREAK: SortKey = { field: "id", order: "desc" };
const TERM_ORDER_FIELD = "takeshape_term_order";
const NO_ARGS: QueryArgs = { sort: [], where: null, filter: null, size: null, from: null, id: null };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The converter's TakeShape id and dates, and EmDash's own value for each. An entry made in EmDash after the move
 * has no TakeShape values, so it reads EmDash's instead and lists where TakeShape would have listed it. An entry
 * edited in EmDash keeps TakeShape's `takeshape_updated_at` until someone changes or clears that field.
 */
const OWN_VALUES = new Map([
	["takeshape_id", "id"],
	["takeshape_published_at", "publishedAt"],
	["takeshape_created_at", "createdAt"],
	["takeshape_updated_at", "updatedAt"],
]);

/**
 * An entry's field. For an empty TakeShape id or date, EmDash's own: the entry's id, or the date as an ISO string
 * like the converter's (`2020-10-22T20:23:35.708Z`). EmDash reads its dates as Date objects.
 */
export function fieldValue(entry: Entry, field: string): unknown {
	const value = entry.data[field];
	const own = OWN_VALUES.get(field);
	if (!own || !(value === null || value === undefined || value === "")) return value;
	if (own === "id") return entryId(entry);
	const date = entry.data[own];
	const time = date instanceof Date ? date.getTime() : typeof date === "string" && date ? Date.parse(date) : Number.NaN;
	return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function entryList(entries: Entry[], total: number): EntryList {
	return Object.assign(entries, { total });
}

// ---------------------------------------------------------------------------
// Reading entries
// ---------------------------------------------------------------------------

/**
 * The `where` and `filter` clauses as one EmDash `where`, and the status they ask for. `impossible` is set when
 * the two ask for different values of one field, which no entry matches.
 */
function conditions(args: QueryArgs): { where: Record<string, unknown>; enabled: boolean | null; impossible: boolean } {
	const allowed = new Map<string, unknown[]>();
	let enabled: boolean | null = null;
	let impossible = false;
	for (const clause of [args.where, args.filter]) {
		if (!isObj(clause)) continue;
		for (const [field, value] of Object.entries(clause)) {
			if (field === "_enabled") {
				if (enabled !== null && enabled !== value) impossible = true;
				enabled = value === true;
				continue;
			}
			const values = Array.isArray(value) ? value : [value];
			const earlier = allowed.get(field);
			const both = earlier ? earlier.filter((v) => values.includes(v)) : values;
			if (!both.length) impossible = true;
			allowed.set(field, both);
		}
	}
	const where: Record<string, unknown> = {};
	for (const [field, values] of allowed) where[field] = values.length === 1 ? values[0] : values;
	return { where, enabled, impossible };
}

/** A field of an entry as conditions read it: the slug is the entry's own. */
function storedValue(e: Entry, field: string): unknown {
	return field === "slug" ? (e.data.slug ?? e.id) : e.data[field];
}

/** Whether a stored value equals a condition's value; SQLite keeps booleans as 0 and 1. */
function sameValue(stored: unknown, value: unknown): boolean {
	// A list matches when it holds the value, as Elasticsearch matched a term against a list field
	if (Array.isArray(stored)) return stored.some((s) => sameValue(s, value));
	if (typeof value === "boolean" && (stored === 0 || stored === 1)) return Boolean(stored) === value;
	return stored === value;
}

/** Whether an entry stays in a list after the filter's must_not (QueryArgs `exclude`). */
function kept(args: QueryArgs): (e: Entry) => boolean {
	const exclude = Object.entries(args.exclude ?? {});
	if (!exclude.length) return () => true;
	return (e) => !exclude.some(([f, v]) => (Array.isArray(v) ? v : [v]).some((x) => sameValue(storedValue(e, f), x)));
}

/** A value as Elasticsearch sorted it: numbers and dates by value, text by code unit, and null for no value. */
function sortValue(v: unknown): number | string | null {
	if (v === null || v === undefined) return null;
	if (typeof v === "number") return v;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (v instanceof Date) return v.getTime();
	if (typeof v === "string") {
		const time = ISO_DATE.test(v) ? Date.parse(v) : Number.NaN;
		return Number.isNaN(time) ? v : time;
	}
	return JSON.stringify(v);
}

function compareBy(keys: SortKey[]): (a: Entry, b: Entry) => number {
	return (a, b) => {
		for (const { field, order } of keys) {
			const x = sortValue(fieldValue(a, field));
			const y = sortValue(fieldValue(b, field));
			if (x === y) continue;
			// Elasticsearch puts entries without a value last in both directions
			if (x === null) return 1;
			if (y === null) return -1;
			const c = x < y ? -1 : 1;
			return order === "desc" ? -c : c;
		}
		return 0;
	};
}

/** The sort keys of a list: `sort`, or the default order without one, then the tie break. */
function sortKeys(sort: SortKey[], legacy: boolean): SortKey[] {
	return [...(sort.length ? sort : legacy ? DEFAULT_ORDER : EMDASH_ORDER), legacy ? TIE_BREAK : EMDASH_TIE_BREAK];
}

/** Entries in TakeShape's order for `sort`, or its default order without one. Sorts in place. */
function sortEntries(entries: Entry[], sort: SortKey[], legacy: boolean): Entry[] {
	return entries.sort(compareBy(sortKeys(sort, legacy)));
}

/** A filter with the columns to read, when the loader names them. */
function withSelect(filter: Record<string, unknown>, select: Select): Record<string, unknown> {
	return select === null ? filter : { ...filter, select };
}

/** The columns a list's own rules read, besides what the loader builds from: its conditions, its must_not, its sort. */
function decidingColumns(args: QueryArgs, legacy: boolean): string[] {
	const { where } = conditions(args);
	return [...Object.keys(where), ...Object.keys(args.exclude ?? {}), ...sortKeys(args.sort, legacy).map((k) => k.field)];
}

/** Two column choices as one, null when either reads every column. */
function both(a: Select, b: readonly string[]): Select {
	return a === null ? null : [...new Set([...a, ...b])];
}

/** `entries` read again with `select`'s columns, in their order, one read per status. An entry gone since is left out. */
async function reread(api: EmDashApi, collection: string, entries: readonly Entry[], select: readonly string[]): Promise<Entry[]> {
	if (!entries.length) return [];
	const byStatus = new Map<string, string[]>();
	for (const e of entries) {
		const status = typeof e.data.status === "string" ? e.data.status : "published";
		byStatus.set(status, [...(byStatus.get(status) ?? []), entryId(e)]);
	}
	const reads = await Promise.all([...byStatus].map(([status, ids]) => api.collection(collection, { status, where: { id: ids }, select })));
	const found = new Map(reads.flatMap((r) => r.entries).map((e) => [entryId(e), e] as const));
	return entries.flatMap((e) => (found.has(entryId(e)) ? [found.get(entryId(e)) as Entry] : []));
}

/**
 * A list query: the matching entries in TakeShape's order, cut to `from` and `size`, and to what a route's pick
 * keeps. A list that is cut and builds from heavy columns reads the others first, then `select`'s for the entries
 * it keeps.
 */
export async function listEntries(api: EmDashApi, collection: string, args: QueryArgs, options: ListOptions): Promise<EntryList> {
	const { where, enabled, impossible } = conditions(args);
	if (impossible) return entryList([], 0);
	const statuses = enabled === true ? ["published"] : enabled === false ? ["draft"] : options.includeDrafts ? ["published", "draft"] : ["published"];
	const legacy = options.legacyFields !== false;
	const from = args.from ?? 0;
	const size = args.size ?? options.defaultSize;
	const select = options.select ?? null;
	const deciding = [...decidingColumns(args, legacy), ...(options.pick?.columns ?? [])];
	const heavy = new Set(options.heavy ?? select ?? []);
	const twoSteps = select !== null && heavy.size > 0 && (size !== null || from > 0 || options.pick !== undefined);
	const first: Select = twoSteps ? [...deciding, ...(select ?? []).filter((c) => !heavy.has(c))] : both(select, deciding);
	// One read per status, at the same time
	// EmDash's where is an equality, which a list never meets: those conditions are checked here
	const lists = new Set(args.arrayFields ?? []);
	const stored = Object.fromEntries(Object.entries(where).filter(([f]) => !lists.has(f)));
	const inLists = Object.entries(where).filter(([f]) => lists.has(f));
	const reads = await Promise.all(statuses.map((status) => api.collection(collection, withSelect(Object.keys(stored).length ? { status, where: stored } : { status }, first))));
	let entries = reads
		.flatMap((read) => read.entries)
		.filter(kept(args))
		.filter((e) => inLists.every(([f, v]) => ([] as unknown[]).concat(v).some((x) => sameValue(storedValue(e, f), x))));
	for (const t of args.through ?? []) {
		const targets = await api.references(collection, entries, t.field, Object.keys(t.where));
		const matches = (target: Entry) => Object.entries(t.where).every(([f, v]) => ([] as unknown[]).concat(v).some((x) => sameValue(storedValue(target, f), x)));
		entries = entries.filter((e) => (targets.get(entryId(e)) ?? []).some(matches));
	}
	const found = sortEntries(entries, args.sort, legacy);
	let keep = size === null ? found.slice(from) : found.slice(from, from + size);
	if (options.pick) keep = options.pick.entries(keep);
	return entryList(twoSteps ? await reread(api, collection, keep, both(select, deciding) as string[]) : keep, found.length);
}

/** The entry of a single shape (getHomepage), whatever its status, as TakeShape returned it. */
export async function getSingle(api: EmDashApi, collection: string, select: Select = null): Promise<Entry | null> {
	for (const status of ["published", "draft"]) {
		const { entries } = await api.collection(collection, withSelect({ status, limit: 1 }, select));
		if (entries[0]) return entries[0];
	}
	return null;
}

/** An entry by its TakeShape id (getBook(_id: ...)), whatever its status. Null without an id. */
export async function getEntry(api: EmDashApi, collection: string, id: string | null, select: Select = null): Promise<Entry | null> {
	if (!id) return null;
	for (const status of ["published", "draft"]) {
		const { entries } = await api.collection(collection, withSelect({ status, where: { takeshape_id: id }, limit: 1 }, select));
		if (entries[0]) return entries[0];
	}
	return null;
}

/** Each entry once, by EmDash id, leaving out empty values. */
function distinct(entries: ReadonlyArray<Entry | null | undefined>): Entry[] {
	const found = new Map<string, Entry>();
	for (const e of entries) if (e && !found.has(entryId(e))) found.set(entryId(e), e);
	return [...found.values()];
}

/**
 * A reference field of many entries: the entries each one points at, in stored order, read for all of them at once
 * with `select`'s columns. An entry whose target is gone or a draft gets fewer.
 */
export async function references(api: EmDashApi, collection: string, entries: ReadonlyArray<Entry | null | undefined>, field: string, select: Select = null, order?: string): Promise<ReferenceLookup> {
	const list = distinct(entries);
	// TakeShape's order names the targets by their TakeShape id
	const found = list.length ? await api.references(collection, list, field, order ? both(select, ["takeshape_id"]) : select) : new Map<string, Entry[]>();
	if (order) for (const e of list) found.set(entryId(e), inLinkOrder(found.get(entryId(e)) ?? [], e.data[order], field));
	return { of: (entry) => found.get(entryId(entry)) ?? [], entries: distinct([...found.values()].flat()) };
}

/**
 * Links in TakeShape's order, from the entry's takeshape_link_order (ts2emdash writes it for fields whose links the
 * other end of the relation declares, which EmDash returns in that end's order): the links it names first, by
 * takeshape_id, then any made in EmDash since, in EmDash's order.
 */
function inLinkOrder(linked: Entry[], sidecar: unknown, field: string): Entry[] {
	const ids = isObj(sidecar) && Array.isArray(sidecar[field]) ? (sidecar[field] as unknown[]).map(String) : [];
	if (!ids.length) return linked;
	const rank = (e: Entry) => {
		const i = ids.indexOf(String(e.data.takeshape_id ?? ""));
		return i < 0 ? ids.length : i;
	};
	return linked.map((e, i) => ({ e, i, r: rank(e) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.e);
}

/**
 * A reverse field for many parents at once: the published entries of `shapeCollection` whose `field` points at
 * each parent, in the default order, at most 20 per parent. Only the entries that point at a parent are read.
 */
export async function reverseReferencesOf(
	api: EmDashApi,
	shapeCollection: string,
	field: string | readonly string[],
	parents: ReadonlyArray<Entry | null | undefined>,
	options: { legacyFields?: boolean; args?: QueryArgs; select?: Select } = {},
): Promise<ReverseLookup> {
	const list = distinct(parents);
	const legacy = options.legacyFields !== false;
	// The field's arguments, as a list's: its conditions and must_not, its sort, from and size
	const args = options.args ?? NO_ARGS;
	const select = both(options.select ?? null, decidingColumns(args, legacy));
	// An unnamed reverse field reads through every field that points at the parent's shape, each referrer once
	const fields = typeof field === "string" ? [field] : field;
	const reads = list.length ? await Promise.all(fields.map((f) => api.referrers(shapeCollection, f, list, select))) : [];
	const found = new Map<string, Entry[]>();
	for (const read of reads) {
		for (const [id, entries] of read) {
			const had = found.get(id) ?? [];
			const seen = new Set(had.map(entryId));
			found.set(id, [...had, ...entries.filter((e) => !seen.has(entryId(e)))]);
		}
	}
	const { where, enabled, impossible } = conditions(args);
	const matches = (e: Entry): boolean =>
		!impossible &&
		(enabled === null || (e.data.status === "published") === enabled) &&
		Object.entries(where).every(([f, v]) => (Array.isArray(v) ? v : [v]).some((x) => sameValue(storedValue(e, f), x)));
	// Conditions on the entries a referrer's reference field points at (args.through), read once for every referrer
	const passing = new Set<string>();
	if (args.through?.length) {
		let referrers = distinct([...found.values()].flat());
		for (const t of args.through) {
			const targets = await api.references(shapeCollection, referrers, t.field, Object.keys(t.where));
			const hit = (target: Entry) => Object.entries(t.where).every(([f, v]) => ([] as unknown[]).concat(v).some((x) => sameValue(storedValue(target, f), x)));
			referrers = referrers.filter((e) => (targets.get(entryId(e)) ?? []).some(hit));
		}
		for (const e of referrers) passing.add(entryId(e));
	}
	const through = (e: Entry) => !args.through?.length || passing.has(entryId(e));
	const from = args.from ?? 0;
	const size = args.size ?? TAKESHAPE_LIST_SIZE;
	const lists = new Map(
		list.map((parent) => {
			const all = sortEntries([...(found.get(entryId(parent)) ?? [])].filter((e) => matches(e) && kept(args)(e) && through(e)), args.sort.length ? args.sort : NO_ARGS.sort, legacy);
			return [entryId(parent), entryList(all.slice(from, from + size), all.length)] as const;
		}),
	);
	return {
		of: (parent) => lists.get(entryId(parent)) ?? entryList([], 0),
		entries: [...new Set([...lists.values()].flat())],
	};
}

/** A reverse field for one parent. */
export async function reverseReferences(api: EmDashApi, shapeCollection: string, field: string, parent: Entry): Promise<EntryList> {
	return (await reverseReferencesOf(api, shapeCollection, field, [parent])).of(parent);
}

// ---------------------------------------------------------------------------
// Building the response
// ---------------------------------------------------------------------------

/**
 * The terms of one taxonomy for many entries, in one read. Each entry's terms come in the order TakeShape kept
 * them (the entry's `takeshape_term_order`), and terms TakeShape never had follow in EmDash's label order.
 */
export async function termsOf(api: EmDashApi, collection: string, entries: ReadonlyArray<Entry | null | undefined>, taxonomy: string): Promise<TermLookup> {
	const ids = entryIds(entries);
	const found = ids.length ? await api.terms(collection, ids, taxonomy) : new Map<string, Term[]>();
	return {
		of(entry) {
			const terms = found.get(entryId(entry)) ?? [];
			const kept = entry.data[TERM_ORDER_FIELD];
			const order = isObj(kept) && Array.isArray(kept[taxonomy]) ? (kept[taxonomy] as unknown[]) : [];
			const rank = (t: Term) => {
				const i = order.indexOf(t.slug);
				return i === -1 ? order.length : i;
			};
			// A stable sort, so terms outside the stored order keep EmDash's label order
			return [...terms].sort((a, b) => rank(a) - rank(b));
		},
	};
}

/**
 * Whether any of an entry's fields holds a value, or any of its reference fields (`links`, read with
 * `references`) points at an entry: an inline object with none was never stored.
 */
export function hasAny(entry: Entry, fields: readonly string[], links: readonly ReferenceLookup[] = []): boolean {
	const filled = fields.some((field) => {
		const v = entry.data[field];
		return !(v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0));
	});
	return filled || links.some((found) => found.of(entry).length > 0);
}

/** The EmDash id that terms and reverse fields are keyed by. */
export function entryId(entry: Entry): string {
	return typeof entry.data.id === "string" ? entry.data.id : entry.id;
}

export function entryIds(entries: ReadonlyArray<Entry | null | undefined>): string[] {
	return entries.filter((e): e is Entry => e !== null && e !== undefined).map(entryId);
}

/** `build(value)`, or null when there is no value: what TakeShape returned for an empty single field. */
export function one<T, R>(value: T | null | undefined, build: (value: T) => R): R | null {
	return value === null || value === undefined ? null : build(value);
}

/**
 * For a getter on a response object: computes the value once, then keeps it on the object as a plain property, so
 * later reads, spreads and JSON see the value.
 */
export function settle<T>(target: object, key: string, compute: () => T): T {
	const value = compute();
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
	return value;
}

/**
 * A repeater's rows, each as an entry's `data`, so the loader builds a row's text and images as it builds an
 * entry's. The converter stores no empty list, and TakeShape answered an unset one with null.
 */
export function rows(value: unknown): Array<{ data: Record<string, unknown> }> | null {
	return Array.isArray(value) && value.length ? value.filter(isObj).map((row) => ({ data: row })) : null;
}

/** A link the converter stored inside a JSON field: the target's collection and its EmDash id. */
function isLink(value: unknown): value is { collection: string; id: string } {
	return isObj(value) && typeof value.collection === "string" && typeof value.id === "string";
}

/**
 * The links under `path` inside each entry's JSON `field` (arrays stepped through at any depth), read for every
 * entry at once, one read per collection, with the columns `selects` names for it. Published targets only, as
 * reference reads give.
 */
export async function jsonLinks(api: EmDashApi, entries: ReadonlyArray<Entry | null | undefined>, field: string, path: readonly string[], selects: Record<string, readonly string[]> = {}): Promise<LinkLookup> {
	const ids = new Map<string, Set<string>>();
	const visit = (value: unknown, rest: readonly string[]): void => {
		if (Array.isArray(value)) return value.forEach((v) => visit(v, rest));
		if (!isObj(value)) return;
		if (!rest.length) {
			if (isLink(value)) (ids.get(value.collection) ?? ids.set(value.collection, new Set()).get(value.collection)!).add(value.id);
			return;
		}
		visit(value[rest[0]!], rest.slice(1));
	};
	for (const e of distinct(entries)) visit(e.data[field], path);
	const found = new Map<string, Entry>();
	await Promise.all(
		[...ids].map(async ([collection, set]) => {
			for (const e of await api.byIds(collection, [...set], selects[collection] ?? null)) found.set(`${collection}\u0000${entryId(e)}`, e);
		}),
	);
	return {
		of: (link) => (isLink(link) ? found.get(`${link.collection}\u0000${link.id}`) ?? null : null),
		entries: (collection) => [...found].filter(([k]) => k.startsWith(`${collection}\u0000`)).map(([, e]) => e),
	};
}

/** One link's target, built by the builder for its collection, or null when it is gone, a draft or of no known shape. */
export function linkTo<R>(lookup: LinkLookup, link: unknown, builders: Record<string, (entry: Entry) => R>): R | null {
	const target = lookup.of(link);
	const build = target && isLink(link) ? builders[link.collection] : undefined;
	return target && build ? build(target) : null;
}

/** A list of links' targets, built, without the ones that are gone (TakeShape dropped them from a multiple relationship). */
export function linksTo<R>(lookup: LinkLookup, links: unknown, builders: Record<string, (entry: Entry) => R>): R[] {
	return (Array.isArray(links) ? links : []).map((l) => linkTo(lookup, l, builders)).filter((r): r is R => r !== null);
}

/**
 * Rich text the converter kept inside a JSON field ({ _type: "takeshapeRichText", blocks, sidecar }): its HTML, as
 * richTextHtml renders an entry's, or its text, one line per block. A plain string (an older conversion) comes back
 * as it is. Null when there is none.
 */
export function jsonRichText(value: unknown, html: boolean, args: Record<string, unknown>): string | null {
	if (typeof value === "string") return value;
	if (!isObj(value) || !Array.isArray(value.blocks)) return null;
	const blocks = value.blocks as PTBlock[];
	// Markdown keeps the text TakeShape stored, which the field returned as it was
	const markdown = typeof value.source === "string";
	if (html) {
		const out = renderRichText(blocks, isObj(value.sidecar) ? (value.sidecar as RichTextSidecar[string]) : undefined, richTextOptions(args));
		return markdown ? withoutBlockBreaks(out) : out;
	}
	if (markdown) return value.source as string;
	return blocks.map((b) => (Array.isArray(b.children) ? b.children.map((c) => (isObj(c) && typeof c.text === "string" ? c.text : "")).join("") : "")).join("\n");
}

/** A JSON value as a list of objects, or null when it is none. */
export function jsonList(value: unknown): Array<Record<string, unknown>> | null {
	return Array.isArray(value) ? value.filter(isObj) : null;
}

/** A JSON value as an object, or null when it is none. */
export function jsonObject(value: unknown): Record<string, unknown> | null {
	return isObj(value) ? value : null;
}

/** Each value built, or an empty list when there are none. */
export function many<T, R>(values: readonly T[] | null | undefined, build: (value: T) => R): R[] {
	return (values ?? []).map((value) => build(value));
}

/**
 * An image or file field as TakeShape's asset. `path` is the EmDash storage key, which the `image` and `asset`
 * filters take. EmDash keeps no title, caption or credit on the field; the converter put the asset's description
 * (or, without one, its title or caption) in `alt`, which is what `description` returns here. Null when the field
 * is empty or holds media that EmDash does not store itself.
 */
export function assetValue(media: unknown): AssetValue | null {
	if (!isObj(media)) return null;
	const meta = isObj(media.meta) ? media.meta : {};
	const src = str(media.src);
	const path = str(meta.storageKey) || (src.startsWith(`${MEDIA_FILE_PATH}/`) ? src.slice(MEDIA_FILE_PATH.length + 1) : "");
	if (!path) return null;
	return {
		path,
		url: `${MEDIA_FILE_PATH}/${path.split("/").map(encodeURIComponent).join("/")}`,
		// The converter keeps TakeShape's title in the value's meta when it preloads media
		title: str(meta.title) || null,
		description: str(media.alt) || null,
		caption: null,
		credit: null,
		filename: str(media.filename) || null,
		mimeType: str(media.mimeType) || null,
	};
}

/**
 * A list of images, leaving out empty ones as TakeShape left out missing assets. The converter stores an image
 * list as a repeater whose rows hold the image under `image`.
 */
export function assetValues(media: unknown): AssetValue[] {
	return (Array.isArray(media) ? media : [])
		.map((row) => assetValue(isObj(row) && !("meta" in row) && "image" in row ? row.image : row))
		.filter((a): a is AssetValue => a !== null);
}

function richTextOptions(args: Record<string, unknown>): RichTextOptions {
	// TakeShape's normalizeArgs: imageConfig stands in for images.default
	const images: Record<string, ImageParams> = isObj(args.images) ? ({ ...args.images } as Record<string, ImageParams>) : {};
	if (isObj(args.imageConfig) && !isObj(images.default)) images.default = args.imageConfig as ImageParams;
	const options: RichTextOptions = {
		classPrefix: str(args.classPrefix),
		headerIdPrefix: str(args.headerIdPrefix),
		imageUrl: (src, params) => {
			const href = src.storageKey ? `${MEDIA_FILE_PATH}/${src.storageKey}` : src.url;
			return absoluteUrl(params ? imageEndpointUrl(href, params) : href);
		},
	};
	if (Object.keys(images).length) options.images = images;
	return options;
}

/** A Draft.js field read without Html: the Draft.js TakeShape returned, rebuilt from the Portable Text. Null when empty. */
export function draftJson(entry: Entry, field: string, sidecarField: string | null): DraftRawValue | null {
	const sidecar = sidecarField ? entry.data[sidecarField] : undefined;
	const forField = isObj(sidecar) ? (sidecar as RichTextSidecar)[field] : undefined;
	return draftRaw(entry.data[field], forField);
}

/**
 * A rich text field's `*Html`, as TakeShape printed it. `args` are the query's arguments to the field
 * (imageConfig, images, classPrefix, headerIdPrefix). An empty field gives "".
 */
export function richTextHtml(entry: Entry, field: string, sidecarField: string | null, args: Record<string, unknown>, markdown = false): string {
	const blocks = entry.data[field];
	const sidecar = sidecarField ? entry.data[sidecarField] : undefined;
	const forField = isObj(sidecar) ? (sidecar as RichTextSidecar)[field] : undefined;
	const html = renderRichText(Array.isArray(blocks) ? blocks : null, forField, richTextOptions(args));
	return markdown ? withoutBlockBreaks(html) : html;
}
