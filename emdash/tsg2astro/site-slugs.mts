/**
 * Works out which EmDash slug each routed entry needs so its page keeps the URL the old
 * takeshape-ssg site gave it. Path variables follow takeshape-ssg's rules: `:name` or `{name}`,
 * and the value goes through slugg.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FieldNode } from "graphql";
import { loadTsgConfig, tsgConfigPath } from "./config.mts";
import type { TsgRoute } from "./config.mts";
import { listStatus, onlyEnabledFilters, statusArgs } from "./list-status.mts";
import { load } from "./load.mts";

type Obj = Record<string, unknown>;
type Shape = { id?: string; schema?: { properties?: Record<string, Prop>; $ref?: string } };
type Prop = { "@mapping"?: string; "@resolver"?: unknown; $ref?: string; items?: Prop; type?: string };

const VARIABLE = /:([a-zA-Z][a-zA-Z0-9.]*)|\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** The variable names in a route path, in order. */
export function pathVariables(path: string): string[] {
	return [...path.matchAll(VARIABLE)].map((m) => (m[1] ?? m[2]) as string);
}

type Sel = { key: string; name: string; selection?: Sel[] };
/** `defaults`: the operation's variable defaults ($kind: String = "board"), which apply when tsg.yml passes none. */
type QueryField = { name: string; args: string[]; items?: Sel[]; node: FieldNode; defaults: Record<string, unknown> };

class Unselected extends Error {
	segment: string;
	constructor(segment: string) {
		super(`the query does not select "${segment}"`);
		this.segment = segment;
	}
}

/** The root fields of a GraphQL document: real name, argument names and the selection under `items`. */
async function queryFields(source: string): Promise<QueryField[]> {
	const { parse, valueFromASTUntyped } = await load<typeof import("graphql")>("graphql");
	type SetNode = { selections: ReadonlyArray<any> };
	const doc = parse(source);
	const fragments = new Map<string, SetNode>();
	for (const def of doc.definitions) if (def.kind === "FragmentDefinition") fragments.set(def.name.value, def.selectionSet);
	// Fields of a selection set, with inline fragments and fragment spreads flattened in
	const fieldsOf = (set: SetNode | undefined, seen: string[] = []): Sel[] => {
		const out: Sel[] = [];
		for (const sel of set?.selections ?? []) {
			if (sel.kind === "Field") {
				out.push({ key: sel.alias?.value ?? sel.name.value, name: sel.name.value, selection: sel.selectionSet ? fieldsOf(sel.selectionSet, seen) : undefined });
			} else if (sel.kind === "InlineFragment") out.push(...fieldsOf(sel.selectionSet, seen));
			else if (sel.kind === "FragmentSpread" && !seen.includes(sel.name.value)) out.push(...fieldsOf(fragments.get(sel.name.value), [...seen, sel.name.value]));
		}
		return out;
	};
	const result: QueryField[] = [];
	for (const def of doc.definitions) {
		if (def.kind !== "OperationDefinition") continue;
		const defaults: Record<string, unknown> = {};
		for (const v of def.variableDefinitions ?? []) if (v.defaultValue) defaults[v.variable.name.value] = valueFromASTUntyped(v.defaultValue);
		for (const sel of def.selectionSet.selections) {
			if (sel.kind !== "Field") continue;
			const inner = fieldsOf(sel.selectionSet);
			result.push({ name: sel.name.value, args: (sel.arguments ?? []).map((x) => x.name.value), items: inner.find((f) => f.key === "items")?.selection, node: sel, defaults });
		}
	}
	return result;
}

const FILTER_ARGS = ["where", "filter", "terms"];

export async function computeSiteSlugs(
	siteDir: string,
	exp: { schema: unknown; rows: Array<Record<string, unknown>> },
): Promise<{ slugs: Map<string, string>; notes: string[] }> {
	const slugg = ((await load<{ default: (s: string) => string }>("slugg")).default);
	const configFile = await tsgConfigPath(siteDir);
	const config = await loadTsgConfig(configFile);
	const base = dirname(configFile);
	const schema = (isObj(exp.schema) ? exp.schema : {}) as { shapes?: Record<string, Shape>; queries?: Record<string, { shape?: string }> };
	const shapes = schema.shapes ?? {};
	const queries = schema.queries ?? {};
	const shapeById = new Map<string, Shape>();
	for (const s of Object.values(shapes)) if (s.id) shapeById.set(s.id, s);
	const rowShape = (r: Obj) => (r._shapeId ?? r._contentTypeId) as string | undefined;
	const rowById = new Map<string, Obj>();
	for (const r of exp.rows) if (typeof r._id === "string") rowById.set(r._id, r);

	const storageKey = (p: Prop | undefined) => {
		const m = typeof p?.["@mapping"] === "string" && p["@mapping"].match(/\.([^.]+)$/);
		return m ? m[1] : null;
	};
	const refShape = (p: Prop | undefined): Shape | undefined => {
		const r = p?.$ref ?? p?.items?.$ref;
		const m = typeof r === "string" && r.match(/^#\/shapes\/([^/]+)\/schema$/);
		return m ? shapes[m[1] as string] : undefined;
	};

	/**
	 * The value a path variable has in the query result, which is what takeshape-ssg reads. Each
	 * segment is a response key (an alias or a field name) in the query's selection; the value
	 * comes from the export row under the field's real property name.
	 */
	function readField(row: Obj, shape: Shape | undefined, sel: Sel[] | undefined, segs: string[]): unknown {
		const seg = segs[0] as string;
		const field = sel?.find((f) => f.key === seg);
		if (!field) throw new Unselected(seg);
		let v: unknown;
		let prop: Prop | undefined;
		if (field.name.startsWith("_")) v = row[field.name];
		else {
			prop = shape?.schema?.properties?.[field.name];
			// Without @mapping, TakeShape stored a property under its name, unless a service resolves it
			const key = storageKey(prop) ?? (prop && !prop["@resolver"] ? field.name : null);
			if (!prop || !key) return undefined;
			v = row[key];
		}
		return descend(v, prop, field.selection, segs.slice(1));
	}
	function descend(v: unknown, prop: Prop | undefined, sel: Sel[] | undefined, segs: string[]): unknown {
		if (!segs.length) return v;
		if (Array.isArray(v)) return /^\d+$/.test(segs[0] as string) ? descend(v[Number(segs[0])], prop, sel, segs.slice(1)) : undefined;
		if (!isObj(v)) return undefined;
		if (typeof v.id === "string" && (v.shapeId ?? v.contentTypeId)) {
			const target = rowById.get(v.id);
			return target ? readField(target, shapeById.get(rowShape(target) ?? ""), sel, segs) : undefined;
		}
		return readField(v, refShape(prop), sel, segs);
	}

	const slugs = new Map<string, string>();
	const notes: string[] = [];
	const taken = new Map<string, Set<string>>(); // shape id -> slugs in use
	const { valueFromASTUntyped } = await load<typeof import("graphql")>("graphql");

	/**
	 * A route query's where as a test on export rows: eq and in on the shape's own stored fields, as Elasticsearch
	 * matched them (a list matches when it holds the value), _enabled and _status left to the status rule. Null when it
	 * holds anything else, and the route then lists every row as before.
	 */
	const whereTest = (node: FieldNode, shape: Shape, variables: Record<string, unknown>): ((row: Obj) => boolean) | null => {
		const arg = node.arguments?.find((a) => a.name.value === "where");
		if (!arg) return () => true;
		const where = valueFromASTUntyped(arg.value, variables);
		if (!isObj(where)) return null;
		const tests: Array<(row: Obj) => boolean> = [];
		for (const [name, cond] of Object.entries(where)) {
			if (name === "_enabled" || name === "_status") continue;
			const prop = shape.schema?.properties?.[name];
			const key = storageKey(prop) ?? (prop && !prop["@resolver"] ? name : null);
			if (!key || !isObj(cond) || Object.keys(cond).length !== 1) return null;
			const [op, value] = Object.entries(cond)[0]!;
			const values = op === "eq" ? [value] : op === "in" && Array.isArray(value) ? value : null;
			// A variable nothing fills in can't be read: the route keeps every row, with its note
			if (!values || values.some((v) => v === undefined || isObj(v) || Array.isArray(v))) return null;
			tests.push((row) => ([] as unknown[]).concat(row[key] ?? []).some((have) => values.includes(have)));
		}
		return (row) => tests.every((t) => t(row));
	};

	for (const [routeName, route] of Object.entries(config.routes) as [string, TsgRoute][]) {
		const data = route.paginate?.data;
		if (!data) {
			if (route.paginate?.property) {
				notes.push(`Route "${routeName}" pages through the "${route.paginate.property}" property of its context, so its URLs could not be matched to entries. Those entries keep the slugs the converter picks.`);
			}
			continue;
		}
		if (!route.path) continue;
		const dataFile = typeof data === "string" ? data : data.query;
		const vars = pathVariables(route.path);
		if (!vars.length) continue;
		let source: string;
		try {
			source = await readFile(join(base, config.templatePath, dataFile), "utf8");
		} catch {
			notes.push(`Route "${routeName}": could not read its query file ${dataFile}, so its entries keep the slugs the converter picks.`);
			continue;
		}
		let shapeName: string | undefined;
		let field: QueryField | undefined;
		for (const f of await queryFields(source)) {
			const m = queries[f.name]?.shape?.match(/^PaginatedList<(.+)>$/);
			if (m) {
				shapeName = m[1];
				field = f;
				break;
			}
		}
		const shape = shapeName ? shapes[shapeName] : undefined;
		if (!shape?.id || !field) {
			notes.push(`Route "${routeName}": its query does not list a shape from this export, so its entries keep the slugs the converter picks.`);
			continue;
		}
		// The entries TakeShape listed by status, decided as the loaders decide it (list-status.mts)
		const variables = typeof data === "string" ? {} : (data.variables ?? {});
		// The query's variable defaults, under tsg.yml's, for the status rule and the where alike
		const filled = { ...field.defaults, ...variables };
		// and by the where the route's query gives, when it can be read whole
		const passes = field.args.includes("filter") || field.args.includes("terms") ? null : whereTest(field.node, shape, filled);
		// tsg.yml variables named like a filter may reach the query in ways this does not read
		const filters = [...new Set([...(passes ? [] : field.args), ...Object.keys(variables)].filter((a) => FILTER_ARGS.includes(a)))];
		const { status, guessed } = listStatus(statusArgs(field.node, filled), { onlyEnabledFilters: onlyEnabledFilters(exp.schema, shapeName as string) });
		const variable = vars[vars.length - 1] as string;
		const used = taken.get(shape.id) ?? new Set<string>();
		const found = new Map<string, string>(); // this route's slugs, kept only if the whole route resolves
		const routeNotes: string[] = [];
		let unselected: string | null = null;
		for (const row of exp.rows) {
			if (rowShape(row) !== shape.id || typeof row._id !== "string") continue;
			const listed = row._enabled === false ? status === "drafts" || status === "all" : status === "published" || status === "all";
			if (!listed || (passes && !passes(row))) continue;
			const label = `${shapeName} ${row._id}`;
			const earlier = slugs.get(row._id);
			if (earlier !== undefined) {
				routeNotes.push(`${label} is reached by more than one route. It keeps "${earlier}" from the first route, not the slug "${routeName}" would give it.`);
				continue;
			}
			let raw: unknown;
			try {
				raw = readField(row, shape, field.items, variable.split("."));
			} catch (e) {
				if (e instanceof Unselected) {
					unselected = variable;
					break;
				}
				throw e;
			}
			// The same coercion as takeshape-ssg's formatPath: String(get(item, path) || '')
			const slug = slugg(String(raw || ""));
			if (!slug) {
				routeNotes.push(`${label} has no value for "${variable}" (route "${routeName}"), so the old site had no page for it and it keeps the slug the converter picks.`);
				continue;
			}
			let final = slug;
			for (let n = 2; used.has(final); n++) final = `${slug}-${n}`;
			if (final !== slug) {
				routeNotes.push(`${label} shares the URL slug "${slug}" with another ${shapeName}. The old site never had a page for it, so it gets "${final}".`);
			}
			used.add(final);
			found.set(row._id, final);
		}
		if (unselected) {
			// Give back the slugs this route reserved while it was being tried
			for (const slug of found.values()) used.delete(slug);
			notes.push(`Route "${routeName}": its path uses "${variable}", which its query does not select, so its entries keep the slugs the converter picks.`);
			continue;
		}
		taken.set(shape.id, used);
		for (const [id, slug] of found) slugs.set(id, slug);
		notes.push(...routeNotes);
		if (guessed) notes.push(`Route "${routeName}": its query's status condition could not be read exactly, so unpublished entries got URL slugs too.`);
		if (filters.length) {
			notes.push(`Route "${routeName}" filters its list (${filters.join(", ")}), so entries outside that filter also got URL slugs from its path, though the old site had no page for them.`);
		}
	}
	return { slugs, notes };
}
