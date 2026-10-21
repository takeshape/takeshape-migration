/**
 * The EmDashApi a migrated site's pages pass to its loaders, built on EmDash's getEmDashCollection,
 * getEmDashEntry and getTermsForEntries, and on references.ts for reference fields. This file and references.ts are
 * the only ones in this folder that use emdash, so the rest runs in Node tests against a stub. A failed read throws
 * instead of rendering an empty page.
 *
 * Every query is a round trip to D1. EmDash's D1 driver runs a request's queries one at a time, except SELECTs
 * issued in the same turn, which it sends as one batch (`coalesce` in astro.config.mjs). So reads are shared across
 * the loaders of a request: getEmDashCollection keeps its own per-request cache, and references.ts keeps what it
 * reads in a map tied to EmDash's request context (requestStore). Reference fields are read for a whole list at
 * once, except on a page that serves drafts (edit mode or a preview link), which reads them one entry at a time
 * with getEmDashReferences, as EmDash shows editors pending links and unpublished targets.
 *
 * Loaders name the columns each read needs (`select`). Such a read goes to rows.ts, which reads only those columns,
 * except on a page that serves drafts and for a condition rows.ts leaves to EmDash: those use getEmDashCollection
 * and get every column.
 */
import { getEmDashCollection, getEmDashEntry, getEmDashReferences, getRequestContext, getTermsForEntries } from "emdash";
import type { CollectionFilter } from "emdash";
import { getDb } from "emdash/runtime";
import { entryId } from "./query.ts";
import type { EmDashApi, Entry } from "./query.ts";
import { byGroup, covers, PUBLISHED_LIST, readByIds, readReferences, readReferrers } from "./references.ts";
import type { PublishedList, ReaderDeps, Select } from "./references.ts";
import { readRows } from "./rows.ts";

function toEntry(entry: { id: string; data: unknown }): Entry {
	return { id: entry.id, data: entry.data as Record<string, unknown> };
}

// One map per request, keyed by EmDash's request context. On globalThis, so a module copied into two chunks still
// shares it (EmDash's own request cache does the same).
const STORES = Symbol.for("takeshape:request-stores");
const shared = globalThis as Record<symbol, unknown>;
const stores = (shared[STORES] ??= new WeakMap<object, Map<string, unknown>>()) as WeakMap<object, Map<string, unknown>>;

/** A map that lives as long as the request. Outside a request, a new one each time, so nothing is shared. */
function requestStore(): Map<string, unknown> {
	const context = getRequestContext();
	if (!context) return new Map();
	let store = stores.get(context);
	if (!store) {
		store = new Map();
		stores.set(context, store);
	}
	return store;
}

/** Whether this request sees drafts: EmDash's edit mode, or a preview link. */
function servesDrafts(): boolean {
	const context = getRequestContext();
	return context?.editMode === true || context?.preview !== undefined;
}

/**
 * A list read with `select`'s columns through rows.ts, or null where it can't. Shared across the loaders of a
 * request: an earlier read of the same list with those columns or more answers for it.
 */
function readSelected(type: string, filter: Record<string, unknown>, select: readonly string[]): Promise<Entry[] | null> {
	const store = requestStore();
	const key = `takeshape:rows:${type}:${JSON.stringify(filter)}`;
	const reads = (store.get(key) as Array<{ select: Select; entries: Promise<Entry[] | null> }> | undefined) ?? [];
	const earlier = reads.find((r) => covers(r.select, select));
	if (earlier) return earlier.entries;
	const { status, where, limit } = filter as { status?: string; where?: Record<string, unknown>; limit?: number };
	const entries = readRows(rowDeps, type, { status: status ?? "published", ...(where ? { where } : {}), ...(limit !== undefined ? { limit } : {}) }, select);
	store.set(key, [...reads, { select, entries }]);
	return entries;
}

async function readCollection(type: string, filter: Record<string, unknown>, select: Select = null): Promise<{ entries: Entry[]; nextCursor?: string }> {
	if (select && !servesDrafts()) {
		const entries = await readSelected(type, filter, select);
		if (entries) return { entries };
	}
	const result = await getEmDashCollection(type, filter as CollectionFilter);
	if (result.error) throw result.error;
	const entries = result.entries.map(toEntry);
	return result.nextCursor ? { entries, nextCursor: result.nextCursor } : { entries };
}

/** getEmDashReferences for one entry, every page of it. */
async function referencesOfOne(collection: string, id: string, field: string): Promise<Entry[]> {
	const entries: Entry[] = [];
	let cursor: string | undefined;
	do {
		// 100 is the most EmDash returns in one page
		const page = await getEmDashReferences(collection, id, field, { limit: 100, cursor });
		if (page.error) throw page.error;
		entries.push(...page.entries.map(toEntry));
		cursor = page.nextCursor;
	} while (cursor);
	return entries;
}

const rowDeps = { db: getDb, store: requestStore };

const reader: ReaderDeps = {
	db: getDb,
	async published(collection, groups, select) {
		return (await readCollection(collection, { status: "published", where: { translation_group: groups } }, select)).entries;
	},
	async publishedByIds(collection, ids, select) {
		return (await readCollection(collection, { status: "published", where: { id: ids } }, select)).entries;
	},
	store: requestStore,
};

export const emdashApi: EmDashApi = {
	collection(type, { select = null, ...filter }) {
		const read = readCollection(type, filter, select as Select);
		// A collection's whole published list: references.ts finds that collection's entries in it
		const keys = Object.keys(filter);
		if (keys.length === 1 && filter.status === "published" && !servesDrafts()) {
			const byGroupOf = read.then((result) => byGroup(result.entries));
			byGroupOf.catch(() => undefined);
			const store = requestStore();
			const lists = (store.get(PUBLISHED_LIST(type)) as PublishedList[] | undefined) ?? [];
			store.set(PUBLISHED_LIST(type), [...lists, { select: select as Select, byGroup: byGroupOf }]);
		}
		return read;
	},
	async entry(type, slugOrId) {
		const result = await getEmDashEntry(type, slugOrId);
		if (result.error) throw result.error;
		return result.entry ? toEntry(result.entry) : null;
	},
	async terms(collection, entryIds, taxonomy) {
		const found = await getTermsForEntries(collection, entryIds, taxonomy);
		return new Map([...found].map(([id, terms]) => [id, terms.map((term) => ({ slug: term.slug, label: term.label }))]));
	},
	byIds(collection, ids, select = null) {
		return readByIds(reader, collection, ids, select);
	},
	async references(collection, entries, field, select = null) {
		if (!servesDrafts()) return readReferences(reader, collection, entries, field, select);
		return new Map(await Promise.all(entries.map(async (e) => [entryId(e), await referencesOfOne(collection, entryId(e), field)] as const)));
	},
	async referrers(collection, field, targets, select = null) {
		if (!servesDrafts()) return readReferrers(reader, collection, field, targets, select);
		// Every published entry of the collection, and what each one points at
		const referring = (await emdashApi.collection(collection, { status: "published" })).entries;
		const pointsAt = await emdashApi.references(collection, referring, field);
		const found = new Map<string, Entry[]>(targets.map((t) => [entryId(t), []]));
		for (const e of referring) {
			for (const id of new Set((pointsAt.get(entryId(e)) ?? []).map(entryId))) found.get(id)?.push(e);
		}
		return found;
	},
};
