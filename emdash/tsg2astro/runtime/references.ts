/**
 * Reference fields for many entries at once. EmDash keeps every reference field in a relation: its links live in
 * `_emdash_content_references`, keyed by translation group, and its public read, getEmDashReferences, takes one
 * entry at a time at three queries each (the entry, its links, the entries they point at). A loader that lists 4,000
 * entries would make 12,000 reads, one after another. This file reads the links of a whole list in one query per
 * field, then the entries they point at with EmDash's public collection read, in one more.
 *
 * With rows.ts, it is the generated code that reads EmDash's internal tables, and it reads only these:
 *   - `_emdash_fields`, `_emdash_collections` and `_emdash_relations`: which relation each reference field is bound
 *     to, which end of it the field's collection is on, and the collection at the other end. One query a request,
 *     for every collection at once (EmDash's own getReferenceFieldMap reads the same rows per collection), shared
 *     with rows.ts (fieldRows).
 *   - `_emdash_content_references`: the links.
 * Written against EmDash 1.3.0 (references/field-map.ts, references/resolve.ts, database/repositories/relation.ts)
 * and checked against it in test/tsg/references.test.mts. It answers what getEmDashReferences answers on a page that
 * serves no drafts:
 *   - links in stored order: by sort_order then id from the parent end of the relation, by id from the child end;
 *   - published entries only;
 *   - nothing for a field that is not bound to a relation.
 * Unlike getEmDashReferences, an entry that is not published gets its links too. Loaders hand it only entries they
 * render, and TakeShape returned a draft's links where it returned the draft (single entries, apiVersion 1 lists).
 * EmDash's fallback to another locale's variant of a target is left out: translated sites have one locale, as
 * ts2emdash migrates only the default one, and getEmDashCollection reads that locale's entries.
 * Pages that serve drafts (edit mode, preview links) call getEmDashReferences instead: see emdash-api.ts.
 * `json_extract` and `json_each` are SQLite's, which D1 runs too.
 *
 * The loaders of one request share what this reads: bindings once, links per relation and group, entries per
 * collection and group, and a collection's whole published list once any loader has read it (PUBLISHED_LIST). Target
 * entries are read with the columns the loader names (`select`, null for every column), and an entry read with more
 * columns stands in for one read with fewer.
 */
import type { getDb } from "emdash/runtime";
import { entryId } from "./query.ts";
import type { Entry } from "./query.ts";
import { fieldRows } from "./rows.ts";

type Db = Awaited<ReturnType<typeof getDb>>;
/** The columns a read needs, or null for every column. */
export type Select = readonly string[] | null;

/** How a reference field is stored, as EmDash binds it (references/field-map.ts). */
export type Binding = {
	relationId: string;
	/** Which end of the relation the field's own collection is on. */
	side: "parent" | "child";
	/** The collection at the other end. */
	targetCollection: string;
};

/** What the reader needs from EmDash. */
export type ReaderDeps = {
	/** EmDash's database for this request (getDb from emdash/runtime). */
	db(): Promise<Db>;
	/** The published entries of a collection whose translation group is one of `groups`, with `select`'s columns. */
	published(collection: string, groups: string[], select: Select): Promise<Entry[]>;
	/** The published entries of a collection whose id is one of `ids`, with `select`'s columns. */
	publishedByIds(collection: string, ids: string[], select: Select): Promise<Entry[]>;
	/** A map that lives as long as the request. */
	store(): Map<string, unknown>;
};

/**
 * The store key under which emdash-api.ts lists a collection's whole published lists, by translation group, each
 * with the columns it was read with, when a loader reads one. Entries of that collection are then found there instead
 * of read again, when a list has the columns a read needs.
 */
export const PUBLISHED_LIST = (collection: string): string => `takeshape:published:${collection}`;
export type PublishedList = { select: Select; byGroup: Promise<Map<string, Entry>> };

/** Whether entries read with `have`'s columns hold `need`'s. */
export function covers(have: Select, need: Select): boolean {
	if (have === null) return true;
	if (need === null) return false;
	const set = new Set(have);
	return need.every((c) => set.has(c));
}

/** Reads of one entry in a request, each with the columns it was read with. */
type Held = Array<{ select: Select; entry: Promise<Entry | null> }>;

/**
 * The entries a request holds under `key(name)` with `select`'s columns, for each of `names` (translation groups
 * or ids): those read before with those columns or more, and the rest in one read with `read`.
 */
async function held(store: Map<string, unknown>, key: (name: string) => string, names: readonly string[], select: Select, read: (missing: string[]) => Promise<Map<string, Entry>>): Promise<Map<string, Entry>> {
	const known = (name: string) => ((store.get(key(name)) as Held | undefined) ?? []).find((h) => covers(h.select, select))?.entry;
	const missing = names.filter((n) => known(n) === undefined);
	if (missing.length) {
		const found = read(missing);
		for (const n of missing) store.set(key(n), [...((store.get(key(n)) as Held | undefined) ?? []), { select, entry: found.then((m) => m.get(n) ?? null) }]);
	}
	const entries = await Promise.all(names.map(async (n) => [n, await (known(n) as Promise<Entry | null>)] as const));
	return new Map(entries.filter((pair): pair is readonly [string, Entry] => pair[1] !== null));
}

/** The whole published list of a collection that has `select`'s columns, if a loader has read one. */
function publishedList(store: Map<string, unknown>, collection: string, select: Select): Promise<Map<string, Entry>> | undefined {
	const lists = (store.get(PUBLISHED_LIST(collection)) as PublishedList[] | undefined) ?? [];
	return lists.find((l) => covers(l.select, select))?.byGroup;
}

const BINDINGS = "takeshape:bindings";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];
const fieldKey = (collection: string, field: string): string => `${collection}\u0000${field}`;

/** The translation group that links name an entry by. Without one (a stub), its id. */
export function groupOf(entry: Entry): string {
	return typeof entry.data.translationGroup === "string" ? entry.data.translationGroup : entryId(entry);
}

/** Entries by translation group. */
export function byGroup(entries: readonly Entry[]): Map<string, Entry> {
	return new Map(entries.map((e) => [groupOf(e), e]));
}

/** The value a request's store holds under `key`, made by `make` the first time. */
function shared<T>(store: Map<string, unknown>, key: string, make: () => Promise<T>): Promise<T> {
	let found = store.get(key) as Promise<T> | undefined;
	if (!found) {
		found = make();
		store.set(key, found);
	}
	return found;
}

/** Every bound reference field of every collection, by collection and field. */
function bindings(deps: ReaderDeps): Promise<Map<string, Binding>> {
	return shared(deps.store(), BINDINGS, async () => {
		const found = new Map<string, Binding>();
		for (const row of await fieldRows(deps)) {
			if (row.type !== "reference") continue;
			let validation: unknown;
			try {
				validation = JSON.parse(row.validation ?? "");
			} catch {
				continue;
			}
			// As EmDash reads it: a field without a relation and a target keeps its value in `data`
			if (!isObj(validation) || typeof validation.relation !== "string" || typeof validation.targetCollection !== "string" || !row.relationId) continue;
			found.set(fieldKey(row.collection, row.field), {
				relationId: row.relationId,
				side: validation.relationSide === "child" ? "child" : "parent",
				targetCollection: validation.targetCollection,
			});
		}
		return found;
	});
}

/**
 * For each group, the groups it links to through one relation, read from the `from` end, in stored order. One query
 * for every group not read earlier in the request. The groups go in as one JSON parameter, since D1 allows 100.
 */
async function links(deps: ReaderDeps, relationId: string, from: "parent" | "child", groups: readonly string[]): Promise<Map<string, string[]>> {
	const store = deps.store();
	const key = (group: string) => `takeshape:links:${relationId}:${from}:${group}`;
	const missing = groups.filter((g) => !store.has(key(g)));
	if (missing.length) {
		const read = (async () => {
			const db = await deps.db();
			const own = from === "parent" ? "parent_group" : "child_group";
			const other = from === "parent" ? "child_group" : "parent_group";
			let query = db
				.selectFrom("_emdash_content_references")
				.select([`${own} as from`, `${other} as to`])
				.where("relation_id", "=", relationId)
				.where(own, "in", (eb) => eb.selectFrom(eb.fn<{ value: string }>("json_each", [eb.val(JSON.stringify(missing))]).as("j")).select("j.value"));
			// relation.ts: getChildrenPageById orders by sort_order then id, getParentsPageById by id
			query = from === "parent" ? query.orderBy("sort_order", "asc").orderBy("id", "asc") : query.orderBy("id", "asc");
			const found = new Map<string, string[]>();
			for (const row of await query.execute()) {
				const list = found.get(row.from) ?? [];
				list.push(row.to);
				found.set(row.from, list);
			}
			return found;
		})();
		for (const g of missing) store.set(key(g), read.then((found) => found.get(g) ?? []));
	}
	return new Map(await Promise.all(groups.map(async (g) => [g, await (store.get(key(g)) as Promise<string[]>)] as const)));
}

/**
 * The published entries of a collection by translation group, for the groups given, with `select`'s columns: from
 * the collection's whole published list when a loader has read one with those columns, otherwise in one read of the
 * groups not read earlier in the request with them (or with every column).
 */
async function entriesByGroup(deps: ReaderDeps, collection: string, groups: readonly string[], select: Select): Promise<Map<string, Entry>> {
	if (!groups.length) return new Map();
	const store = deps.store();
	const whole = publishedList(store, collection, select);
	if (whole) {
		const all = await whole;
		return new Map(groups.flatMap((g) => (all.has(g) ? [[g, all.get(g) as Entry] as const] : [])));
	}
	return held(store, (group) => `takeshape:entry:${collection}:${group}`, groups, select, async (missing) => byGroup(await deps.published(collection, missing, select)));
}

/**
 * The published entries of a collection with the given EmDash ids, which JSON fields hold: from the collection's whole
 * published list when a loader has read it, otherwise in one read of the ids not read earlier in the request. An id
 * names its entry where its translation group may not (an entry made in another locale first).
 */
export async function readByIds(deps: ReaderDeps, collection: string, ids: readonly string[], select: Select = null): Promise<Entry[]> {
	const wanted = unique(ids);
	if (!wanted.length) return [];
	const store = deps.store();
	const whole = publishedList(store, collection, select);
	if (whole) {
		const byId = new Map([...(await whole).values()].map((e) => [entryId(e), e] as const));
		return wanted.flatMap((id) => (byId.has(id) ? [byId.get(id) as Entry] : []));
	}
	const found = await held(store, (id) => `takeshape:entry-id:${collection}:${id}`, wanted, select, async (missing) => new Map((await deps.publishedByIds(collection, missing, select)).map((e) => [entryId(e), e] as const)));
	return wanted.flatMap((id) => (found.has(id) ? [found.get(id) as Entry] : []));
}

/**
 * getEmDashReferences for many entries: for each entry (by EmDash id), the published entries one of its reference
 * fields points at, in stored order, whatever the entry's own status, with `select`'s columns.
 */
export async function readReferences(deps: ReaderDeps, collection: string, entries: readonly Entry[], field: string, select: Select = null): Promise<Map<string, Entry[]>> {
	const found = new Map<string, Entry[]>(entries.map((e) => [entryId(e), []]));
	const binding = entries.length ? (await bindings(deps)).get(fieldKey(collection, field)) : undefined;
	if (!binding) return found;
	const linked = await links(deps, binding.relationId, binding.side, unique(entries.map(groupOf)));
	const targets = await entriesByGroup(deps, binding.targetCollection, unique([...linked.values()].flat()), select);
	for (const e of entries) found.set(entryId(e), (linked.get(groupOf(e)) ?? []).flatMap((g) => targets.get(g) ?? []));
	return found;
}

/**
 * The other way round: for each target entry (by EmDash id), the published entries of `collection` whose reference
 * `field` points at it, in no set order, whatever the target's own status (TakeShape answered a reverse field on any
 * entry it returned), with `select`'s columns.
 */
export async function readReferrers(deps: ReaderDeps, collection: string, field: string, targets: readonly Entry[], select: Select = null): Promise<Map<string, Entry[]>> {
	const found = new Map<string, Entry[]>(targets.map((t) => [entryId(t), []]));
	const binding = targets.length ? (await bindings(deps)).get(fieldKey(collection, field)) : undefined;
	if (!binding) return found;
	const linked = await links(deps, binding.relationId, binding.side === "parent" ? "child" : "parent", unique(targets.map(groupOf)));
	const referring = await entriesByGroup(deps, collection, unique([...linked.values()].flat()), select);
	for (const t of targets) found.set(entryId(t), unique((linked.get(groupOf(t)) ?? []).flatMap((g) => referring.get(g) ?? [])));
	return found;
}
