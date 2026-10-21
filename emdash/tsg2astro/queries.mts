/**
 * Plans a takeshape-ssg GraphQL query file: for each field it selects, where EmDash keeps that data, using
 * TakeShape's schema (schema.mts) for what the query means and ts2emdash's field map for EmDash's names.
 * emit-loader.mts turns a plan into a loader module. Anything a loader cannot reproduce exactly goes in the
 * report with the file and line, and fields the loader cannot fill are left out of the plan.
 *
 * TakeShape's list rules (published only without `where` or `filter`, 20 entries without `size`) are in
 * runtime/query.ts, which the loaders call.
 */
import type { ArgumentNode, DocumentNode, FieldNode, OperationDefinitionNode, SelectionNode, ValueNode } from "graphql";
import type { FieldMap, PropertyMapEntry, ShapeMapEntry } from "../ts2emdash.mts";
import { imageParamProblem } from "./runtime/imgix.ts";
import { listStatus, statusArgs } from "./list-status.mts";
import { load } from "./load.mts";
import type { Report } from "./report.mts";
import type { ListOptions, QueryArgs, SortKey } from "./runtime/query.ts";
import type { TSProperty, TSSchemaModel } from "./schema.mts";

export type { QueryArgs } from "./runtime/query.ts";

/**
 * Where a selected field's value comes from. Field names are EmDash's. `reference` and `reverse` also carry the
 * TakeShape shape (for `_contentTypeName` inside them) and the EmDash collection the loader reads. `object`
 * lists every EmDash field stored under the inline object, which decide whether it was stored at all.
 */
export type FieldSource =
	/** `default`: what TakeShape answered when the entry stored no value. */
	| { kind: "scalar"; field: string; default?: unknown }
	| { kind: "meta"; name: "_id" | "_enabled" | "_enabledAt" | "_createdAt" | "_updatedAt" | "_contentTypeName" | "_shapeName" | "__typename" }
	| { kind: "richTextHtml"; field: string; sidecar: string | null; args: Record<string, unknown>; markdown?: true }
	/** A Draft.js field without Html: the Draft.js TakeShape returned, rebuilt from the Portable Text (runtime/draft-raw.ts). */
	| { kind: "draftJson"; field: string; sidecar: string | null }
	| { kind: "asset"; field: string; multiple: boolean }
	| { kind: "assetField"; name: "path" | "title" | "description" | "caption" | "credit" | "filename" | "mimeType" }
	/** `order`: the entry's takeshape_link_order field, TakeShape's order of links EmDash keeps in another (ts2emdash). */
	| { kind: "reference"; field: string; target: string; collection: string; multiple: boolean; order?: string }
	/** `also`: the other fields an unnamed reverse field reads through (schema.mts ReverseField `others`). */
	| { kind: "reverse"; shape: string; property: string; collection: string; field: string; also?: string[]; args?: QueryArgs }
	| { kind: "taxonomy"; taxonomy: string; multiple: boolean }
	/** `fields` are the columns under an inline object, `references` its reference fields (not columns in EmDash). */
	| { kind: "object"; fields: string[]; references: string[] }
	/** An EmDash repeater: its rows hold text and images under the field names the selection reads. */
	| { kind: "repeater"; field: string }
	/**
	 * A field the converter kept as JSON (lists of objects holding links or nested objects). Its value has TakeShape's
	 * property names, images as EmDash media values and links as `{ collection, id }`; the json* sources read it.
	 */
	| { kind: "json"; field: string; multiple: boolean }
	| { kind: "jsonValue"; key: string; default?: unknown }
	/** A relationship to several shapes, which the converter kept as a JSON list of links: each target, built per shape. */
	| { kind: "links"; field: string; multiple: boolean; targets: Array<{ shape: string; collection: string; selection: SelectionPlan[] }> }
	| { kind: "jsonAsset"; key: string; multiple: boolean }
	| { kind: "jsonObject"; key: string; multiple: boolean }
	/** Rich text inside JSON: its HTML (xHtml, x(format: html)) or its text (x). */
	| { kind: "jsonRichText"; key: string; html: boolean; args: Record<string, unknown> }
	/** A link inside JSON, with the selection for each shape it may point at. */
	| { kind: "jsonLink"; key: string; multiple: boolean; targets: Array<{ shape: string; collection: string; selection: SelectionPlan[] }> }
	| { kind: "listTotal" }
	| { kind: "listItems" };
export type SelectionPlan = { alias: string; source: FieldSource; selection: SelectionPlan[] };
export type TopFieldPlan = {
	alias: string;
	query: string;
	shape: string;
	collection: string;
	op: "get" | "list" | "single";
	args: QueryArgs;
	/** An old-format `getXList { fields }`: takeshape-ssg wrapped it and returned the bare items array. */
	legacyListShape: boolean;
	selection: SelectionPlan[];
};
/**
 * `paginatedAlias` is the one list takeshape-ssg would page through if a route used this file as `paginate.data`.
 * `legacyFields` is false when the field map has no TakeShape ids and dates (--no-legacy-fields). `outName` is where
 * the loader goes under src/loaders/ when that is not `file`: a query file outside the templates folder
 * (siteFileName in scope.mts).
 */
/** `variableDefaults`: the operation's defaults ($kind: String = "board"), which apply where the route passes none. */
export type QueryPlan = {
	file: string;
	variables: string[];
	fields: TopFieldPlan[];
	paginatedAlias: string | null;
	legacyFields: boolean;
	outName?: string;
	variableDefaults?: Record<string, unknown>;
};

type CollectionEntry = Extract<ShapeMapEntry, { kind: "collection" }>;
type Flat = { key: string; node: FieldNode; selections: SelectionNode[] };

const { parse } = await load<typeof import("graphql")>("graphql");
const camelCase = (await load<{ default: (s: string | string[]) => string }>("lodash/camelCase.js", "lodash")).default;

/** runtime/query.ts TAKESHAPE_LIST_SIZE: what TakeShape returned from a list without `size`. */
const TAKESHAPE_LIST_SIZE = 20;
/** What literal() returns for a value that holds a variable. */
const VARIABLE = Symbol("variable");
const META = new Set(["_id", "_enabled", "_enabledAt", "_createdAt", "_updatedAt", "_contentTypeName", "_shapeName", "__typename"]);
/** Meta fields read from the converter's takeshape_* fields. */
const LEGACY_META = new Set(["_id", "_enabledAt", "_createdAt", "_updatedAt"]);
const STATUS_FIELDS = new Set(["_enabled", "_status"]);
/** Field types a filter's `match` compares exactly: TakeShape matched words in text, which no equality reproduces. */
const EXACT_MATCH_TYPES = new Set(["boolean", "integer", "number"]);
const ASSET_FIELDS = new Set(["path", "url", "title", "description", "caption", "credit", "filename", "mimeType"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const NO_ARGS = (): QueryArgs => ({ sort: [], where: null, filter: null, size: null, from: null, id: null });

/** Drafts and the default size for a list field, as TakeShape decided them. */
export function listOptions(field: TopFieldPlan): ListOptions {
	const clauses = [field.args.where, field.args.filter];
	// TakeShape's published-only default (onlyEnabled) applies when the query has neither where nor filter.
	// A clause on _enabled decides the status itself.
	const replaced = clauses.some((c) => c !== null);
	const onEnabled = clauses.some((c) => isObj(c) && "_enabled" in c);
	return { includeDrafts: replaced && !onEnabled, defaultSize: TAKESHAPE_LIST_SIZE };
}

/** A GraphQL value as JSON, or VARIABLE when it holds a variable anywhere. */
function literal(node: ValueNode): unknown {
	switch (node.kind) {
		case "Variable":
			return VARIABLE;
		case "IntValue":
			return Number.parseInt(node.value, 10);
		case "FloatValue":
			return Number.parseFloat(node.value);
		case "StringValue":
		case "EnumValue":
			return node.value;
		case "BooleanValue":
			return node.value;
		case "NullValue":
			return null;
		case "ListValue": {
			const items = node.values.map(literal);
			return items.includes(VARIABLE) ? VARIABLE : items;
		}
		case "ObjectValue": {
			const out: Record<string, unknown> = {};
			for (const f of node.fields) {
				const v = literal(f.value);
				if (v === VARIABLE) return VARIABLE;
				out[f.name.value] = v;
			}
			return out;
		}
	}
}

/**
 * A GraphQL value as JSON with each variable as `{ $variable: name }`, which emit-loader.mts writes as the variable the
 * route passes (`_variables[name]`). Conditions in where and filter take them.
 */
function literalVars(node: ValueNode): unknown {
	switch (node.kind) {
		case "Variable":
			return { $variable: node.name.value };
		case "ListValue":
			return node.values.map(literalVars);
		case "ObjectValue":
			return Object.fromEntries(node.fields.map((f) => [f.name.value, literalVars(f.value)]));
		default:
			return literal(node);
	}
}
const isVariableRef = (v: unknown): boolean => isObj(v) && Object.keys(v).length === 1 && typeof v.$variable === "string";
/** A condition's value: a literal that is no object or list, or a variable. */
const isPlainValue = (v: unknown): boolean => isVariableRef(v) || (!isObj(v) && !Array.isArray(v));

const lineOf = (node: { loc?: { startToken: { line: number } } }): number | undefined => node.loc?.startToken.line;

class Planner {
	readonly file: string;
	readonly schema: TSSchemaModel;
	readonly fieldMap: FieldMap;
	readonly report: Report;
	readonly fragments = new Map<string, readonly SelectionNode[]>();
	/** Each fragment's type condition, for the fields a link reads on each shape it may point at. */
	readonly fragmentTypes = new Map<string, string>();
	/** The tsg.yml variables the route passes, over the query's own defaults; they decide which statuses a list returns. */
	variables: Record<string, unknown>;

	constructor(file: string, schema: TSSchemaModel, fieldMap: FieldMap, report: Report, variables: Record<string, unknown>) {
		this.file = file;
		this.schema = schema;
		this.fieldMap = fieldMap;
		this.report = report;
		this.variables = variables;
		this.legacyFields = Object.values(fieldMap.shapes).every((s) => s.kind !== "collection" || s.legacy !== null);
	}

	readonly legacyFields: boolean;
	legacyReported = false;

	/** Something the loader does differently from TakeShape, worth knowing. */
	note(node: { loc?: { startToken: { line: number } } }, construct: string, message: string): void {
		this.report.add({ kind: "query", file: this.file, line: lineOf(node), construct, message });
	}

	/** Something the loader leaves out, so the page can show other data than before until it is rewritten. */
	notTranslated(node: { loc?: { startToken: { line: number } } }, construct: string, message: string): void {
		this.report.add({ kind: "not-translated", file: this.file, line: lineOf(node), construct, message });
	}

	/** The fields of a selection set, fragments spread in, one per response key (GraphQL merges repeats). */
	flatten(selections: readonly SelectionNode[] | undefined, seen: string[] = []): Flat[] {
		const out: Flat[] = [];
		const add = (sel: readonly SelectionNode[], seenHere: string[]) => {
			for (const s of sel) {
				if (s.kind === "Field") {
					const key = s.alias?.value ?? s.name.value;
					const earlier = out.find((f) => f.key === key);
					if (earlier) earlier.selections.push(...(s.selectionSet?.selections ?? []));
					else out.push({ key, node: s, selections: [...(s.selectionSet?.selections ?? [])] });
					if (s.directives?.length) this.notTranslated(s, `@${s.directives[0]!.name.value}`, `The directive on "${key}" is ignored; the loader always fills the field.`);
				} else if (s.kind === "InlineFragment") add(s.selectionSet.selections, seenHere);
				else if (s.kind === "FragmentSpread" && !seenHere.includes(s.name.value)) add(this.fragments.get(s.name.value) ?? [], [...seenHere, s.name.value]);
			}
		};
		add(selections ?? [], seen);
		return out;
	}

	/** Like flatten, for one shape a link may point at: fragments on other shapes are left out. */
	flattenFor(selections: readonly SelectionNode[] | undefined, shape: string): Flat[] {
		const keep = (sel: readonly SelectionNode[], seen: string[]): SelectionNode[] =>
			sel.flatMap((s): SelectionNode[] => {
				if (s.kind === "InlineFragment") return !s.typeCondition || s.typeCondition.name.value === shape ? keep(s.selectionSet.selections, seen) : [];
				if (s.kind === "FragmentSpread") {
					const type = this.fragmentTypes.get(s.name.value);
					return seen.includes(s.name.value) || (type && type !== shape) ? [] : keep(this.fragments.get(s.name.value) ?? [], [...seen, s.name.value]);
				}
				return [s];
			});
		return this.flatten(keep(selections ?? [], []));
	}

	/** The selection under a JSON field, against the TakeShape properties of what it holds. */
	jsonFields(selections: readonly SelectionNode[], props: Record<string, TSProperty>): SelectionPlan[] {
		const out: SelectionPlan[] = [];
		for (const c of this.flatten(selections)) {
			const name = c.node.name.value;
			const p = props[name];
			const alias = c.key;
			// Rich text: xHtml and x(format: html) render it, x gives its text
			const base = p ? null : this.htmlOf(name, props);
			if (base || p?.kind === "draftjs" || p?.kind === "markdown") {
				const args: Record<string, unknown> = {};
				let formatHtml = false;
				for (const arg of c.node.arguments ?? []) {
					const value = literal(arg.value);
					if (arg.name.value === "format") formatHtml = value === "html";
					else if (value !== VARIABLE) args[arg.name.value] = value;
				}
				out.push({ alias, source: { kind: "jsonRichText", key: base ?? name, html: Boolean(base) || formatHtml, args }, selection: [] });
				continue;
			}
			if (p?.kind === "asset") {
				out.push({ alias, source: { kind: "jsonAsset", key: name, multiple: p.multiple }, selection: this.asset(this.flatten(c.selections)) });
			} else if ((p?.kind === "object" || p?.kind === "array") && p.properties && c.selections.length) {
				out.push({ alias, source: { kind: "jsonObject", key: name, multiple: p.kind === "array" || p.multiple }, selection: this.jsonFields(c.selections, p.properties) });
			} else if (p?.kind === "relationship") {
				const targets: Array<{ shape: string; collection: string; selection: SelectionPlan[] }> = [];
				for (const shape of p.targets) {
					const entry = this.collectionOf(shape);
					if (entry) targets.push({ shape, collection: entry.collection, selection: this.entry(this.flattenFor(c.selections, shape), shape, entry) });
				}
				out.push({ alias, source: { kind: "jsonLink", key: name, multiple: p.multiple, targets }, selection: [] });
			} else {
				out.push({ alias, source: { kind: "jsonValue", key: name, ...(p?.default !== undefined ? { default: p.default } : {}) }, selection: [] });
			}
		}
		return out;
	}

	collectionOf(shape: string): CollectionEntry | null {
		const entry = this.fieldMap.shapes[shape];
		return entry?.kind === "collection" ? entry : null;
	}

	// -------------------------------------------------------------------------
	// Top-level fields
	// -------------------------------------------------------------------------

	top(f: Flat): TopFieldPlan | null {
		const name = f.node.name.value;
		const query = this.schema.queries.get(name);
		if (!query) {
			this.notTranslated(f.node, name, `"${name}" is not one of this project's content queries (getX, getXList), so the loader leaves it out.`);
			return null;
		}
		const entry = this.fieldMap.shapes[query.shape];
		if (entry?.kind !== "collection") {
			const why =
				entry?.kind === "taxonomy"
					? `${query.shape} became the EmDash taxonomy "${entry.taxonomy}", and loaders do not list taxonomy terms yet`
					: entry?.kind === "skipped"
						? `the converter skipped ${query.shape} (${entry.reason})`
						: `${query.shape} is not in the field map`;
			this.notTranslated(f.node, name, `"${name}" is left out: ${why}.`);
			return null;
		}
		if (!entry.legacy && !this.legacyReported) {
			this.legacyReported = true;
			this.report.add({
				kind: "query",
				file: this.file,
				construct: "--no-legacy-fields",
				message: "The field map has no TakeShape ids and dates (the site was converted with --no-legacy-fields), so lists come in EmDash's order instead of TakeShape's, and lookups by TakeShape id are unavailable.",
			});
		}
		const args = this.args(f.node, query.op, entry, query.shape);
		if (query.op === "get" && args.id === null && !(f.node.arguments ?? []).some((a) => a.name.value === "_id" || a.name.value === "id")) {
			this.notTranslated(f.node, name, `"${name}" has no literal _id, so the loader has no entry to read and the field will be null.`);
		}
		const children = this.flatten(f.selections);
		const legacyListShape = query.op === "list" && /^get.+List$/.test(name) && !children.some((c) => c.node.name.value === "items" || c.node.name.value === "total");
		const selection = query.op === "list" && !legacyListShape ? this.list(children, query.shape, entry) : this.entry(children, query.shape, entry);
		return { alias: f.key, query: name, shape: query.shape, collection: entry.collection, op: query.op, args, legacyListShape, selection };
	}

	/** `total` and `items` of a list (a list query or a reverse field). */
	list(children: Flat[], shape: string, entry: CollectionEntry): SelectionPlan[] {
		const out: SelectionPlan[] = [];
		for (const c of children) {
			const name = c.node.name.value;
			if (name === "total") out.push({ alias: c.key, source: { kind: "listTotal" }, selection: [] });
			else if (name === "items") out.push({ alias: c.key, source: { kind: "listItems" }, selection: this.entry(this.flatten(c.selections), shape, entry) });
			else this.notTranslated(c.node, name, `A list has only "items" and "total", so "${name}" is left out.`);
		}
		return out;
	}

	// -------------------------------------------------------------------------
	// Arguments
	// -------------------------------------------------------------------------

	args(node: FieldNode, op: "get" | "list" | "single", entry: CollectionEntry, shape: string): QueryArgs {
		const out = NO_ARGS();
		let where: Record<string, unknown> | null = null;
		let filter: Record<string, unknown> | null = null;
		const exclude: Record<string, unknown> = {};
		const through: Array<{ field: string; where: Record<string, unknown> }> = [];
		for (const arg of node.arguments ?? []) {
			const name = arg.name.value;
			const value = literal(arg.value);
			const isId = op === "get" && (name === "_id" || name === "id");
			// where and filter take variables in their conditions (literalVars); other arguments don't yet
			const conditionsWithVariables = value === VARIABLE && op === "list" && (name === "where" || name === "filter") && arg.value.kind === "ObjectValue";
			if (value === VARIABLE && !conditionsWithVariables) {
				const result = isId ? "the field will be null" : "it is left out";
				this.notTranslated(arg, name, `"${name}" takes a variable, which loaders do not fill in yet, so ${result}.`);
				continue;
			}
			// A null argument is the same as none
			if (value === null) continue;
			if (isId && typeof value === "string") {
				if (entry.legacy) out.id = value;
				else this.notTranslated(arg, name, `Lookups by TakeShape id need the converter's legacy fields, which this field map lacks, so the field will be null.`);
			} else if (op === "list" && name === "sort") out.sort = this.sort(arg, value, entry);
			else if (op === "list" && name === "where" && arg.value.kind === "ObjectValue") where = this.where(arg.value, entry, {}, through);
			else if (op === "list" && name === "filter" && arg.value.kind === "ObjectValue") filter = this.filter(arg.value, entry, {}, exclude);
			else if (op === "list" && (name === "size" || name === "from") && typeof value === "number") out[name] = value;
			// onlyEnabled counts in the status below
			else if (op === "list" && name === "onlyEnabled" && typeof value === "boolean") continue;
			else if (name === "terms") this.notTranslated(arg, name, `Full-text search ("terms") has no EmDash loader yet, so it is left out and the list is not narrowed by it.`);
			else if (name === "locale" || name === "enableLocaleFallback") this.notTranslated(arg, name, `Loaders read the site's one locale, so "${name}" is left out.`);
			else this.notTranslated(arg, name, `The argument "${name}" is left out; loaders do not apply it.`);
		}
		if (op !== "list") return out;
		// The statuses TakeShape listed (list-status.mts), the same rule site-slugs.mts follows, with the tsg.yml
		// variables filled in and the shape's workflow (none in apiVersion 1). runtime/query.ts reads them back from
		// `_enabled` and from where or filter being present.
		const { status, guessed } = listStatus(statusArgs(node, this.variables), { onlyEnabledFilters: this.schema.shapes.get(shape)?.onlyEnabledFilters ?? true });
		if (guessed) this.notTranslated(node, node.name.value, `The status condition of "${node.name.value}" could not be read exactly, so the loader lists every entry it could allow, published or not.`);
		const mark = (enabled: boolean) => {
			if (where) where._enabled = enabled;
			else if (filter) filter._enabled = enabled;
			else where = { _enabled: enabled };
		};
		if (status === "published" && (where || filter)) mark(true);
		else if (status === "drafts") mark(false);
		else if (status === "all" && !where && !filter) where = {};
		else if (status === "none") {
			where = { ...where, _enabled: true };
			filter = { ...filter, _enabled: false };
		}
		out.where = where;
		out.filter = filter;
		if (Object.keys(exclude).length) out.exclude = exclude;
		if (through.length) out.through = through;
		// Multi-select fields hold lists, which a condition matched when the list held the value
		const lists = new Set<string>();
		const collect = (props: Record<string, PropertyMapEntry>) => {
			for (const p of Object.values(props)) {
				if (p.kind === "scalar" && p.type === "multiSelect") lists.add(p.field);
				else if (p.kind === "object") collect(p.properties);
			}
		};
		collect(entry.properties);
		const arrayFields = [...new Set(Object.keys({ ...(isObj(where) ? where : {}), ...(isObj(filter) ? filter : {}) }))].filter((c) => lists.has(c));
		if (arrayFields.length) out.arrayFields = arrayFields;
		return out;
	}

	/** The EmDash column for a TakeShape field name in a sort or a filter, or null. */
	column(name: string, entry: CollectionEntry): string | null {
		const legacy = entry.legacy;
		if (name === "_id") return legacy?.id ?? null;
		if (name === "_createdAt") return legacy?.createdAt ?? null;
		if (name === "_updatedAt") return legacy?.updatedAt ?? null;
		if (name === "_enabledAt") return legacy?.publishedAt ?? null;
		const prop = entry.properties[name];
		if (prop?.kind === "scalar") return prop.field;
		if (prop?.kind === "entrySlug") return "slug";
		return null;
	}

	sort(arg: { loc?: { startToken: { line: number } } }, value: unknown, entry: CollectionEntry): SortKey[] {
		const out: SortKey[] = [];
		for (const key of Array.isArray(value) ? value : [value]) {
			const field = isObj(key) && typeof key.field === "string" ? key.field : "";
			const order = isObj(key) && typeof key.order === "string" ? key.order.toLowerCase() : "";
			const column = this.column(field, entry);
			if (!column || (order !== "asc" && order !== "desc")) {
				const why = !entry.legacy && field.startsWith("_") ? "this field map has no TakeShape ids and dates" : `loaders sort only by stored fields and _id, _createdAt, _updatedAt and _enabledAt, "asc" or "desc"`;
				this.notTranslated(arg, field || "sort", `The sort on "${field}" is left out: ${why}.`);
				continue;
			}
			out.push({ field: column, order });
		}
		return out;
	}

	/** Adds one equality condition to `where`, or reports a field that has no column. */
	condition(field: string, values: unknown, node: { loc?: { startToken: { line: number } } }, entry: CollectionEntry, where: Record<string, unknown>): void {
		const column = this.column(field, entry);
		if (!column) {
			this.notTranslated(node, field, `The condition on "${field}" is left out: loaders carry over only equality on stored fields and _enabled, so this list may hold entries TakeShape left out.`);
			return;
		}
		where[column] = values;
	}

	/** TakeShape's `where`: `field: {eq}` and `field: {in}`, `_enabled: {eq}`, and AND of those. */
	where(
		node: Extract<ValueNode, { kind: "ObjectValue" }>,
		entry: CollectionEntry,
		out: Record<string, unknown> = {},
		through?: Array<{ field: string; where: Record<string, unknown> }>,
	): Record<string, unknown> {
		for (const f of node.fields) {
			const key = f.name.value;
			if (key === "AND" && f.value.kind === "ListValue") {
				for (const item of f.value.values) if (item.kind === "ObjectValue") this.where(item, entry, out, through);
				continue;
			}
			// _enabled and _status decide the statuses the list returns (args, list-status.mts)
			if (STATUS_FIELDS.has(key)) continue;
			const cond = literalVars(f.value);
			const ops = isObj(cond) ? Object.keys(cond) : [];
			const prop = entry.properties[key];
			// A condition on an inline object's fields reads the fields it was flattened into
			if (prop?.kind === "object" && f.value.kind === "ObjectValue" && !ops.includes("eq") && !ops.includes("in")) {
				this.where(f.value, { ...entry, properties: prop.properties }, out, through);
				continue;
			}
			// A condition on the entries a reference field points at: one of them must match
			const target = prop?.kind === "reference" ? this.fieldMap.shapes[prop.target] : undefined;
			if (through && prop?.kind === "reference" && target?.kind === "collection" && f.value.kind === "ObjectValue" && !ops.includes("eq") && !ops.includes("in")) {
				const onTarget: Record<string, unknown> = {};
				let plain = f.value.fields.length > 0;
				for (const t of f.value.fields) {
					const tc = literalVars(t.value);
					const column = this.column(t.name.value, target);
					const tops = isObj(tc) ? Object.keys(tc) : [];
					if (column && tops.length === 1 && tops[0] === "eq" && isObj(tc) && isPlainValue(tc.eq)) onTarget[column] = tc.eq;
					else if (column && tops.length === 1 && tops[0] === "in" && isObj(tc) && (Array.isArray(tc.in) || isVariableRef(tc.in))) onTarget[column] = tc.in;
					else plain = false;
				}
				if (plain) {
					through.push({ field: prop.field, where: onTarget });
					continue;
				}
			}
			if (ops.length === 1 && ops[0] === "eq" && isObj(cond) && isPlainValue(cond.eq)) this.condition(key, cond.eq, f, entry, out);
			else if (ops.length === 1 && ops[0] === "in" && isObj(cond) && (Array.isArray(cond.in) || isVariableRef(cond.in))) this.condition(key, cond.in, f, entry, out);
			else this.notTranslated(f, key, `The condition on "${key}" is left out: loaders carry over only eq and in on stored fields and _enabled, so this list may hold entries TakeShape left out.`);
		}
		return out;
	}

	/** An Elasticsearch-style `filter`: `term`, `match` and `terms` on single fields, inside `bool.must` or `bool.filter`. */
	filter(node: ValueNode, entry: CollectionEntry, out: Record<string, unknown> = {}, exclude?: Record<string, unknown>): Record<string, unknown> {
		if (node.kind === "ListValue") {
			for (const item of node.values) this.filter(item, entry, out, exclude);
			return out;
		}
		if (node.kind !== "ObjectValue") return out;
		for (const f of node.fields) {
			const key = f.name.value;
			if (key === "bool" && f.value.kind === "ObjectValue") {
				for (const b of f.value.fields) {
					const part = b.name.value;
					if (part === "must" || part === "filter") this.filter(b.value, entry, out, exclude);
					// must_not on _enabled or _status counts in the statuses the list returns (list-status.mts)
					else if (part === "must_not" && this.statusOnly(b.value)) continue;
					// Plain clauses leave out the entries that match any of them
					else if (part === "must_not" && exclude && this.plainClauses(b.value)) {
						for (const clause of b.value.kind === "ListValue" ? b.value.values : [b.value]) {
							for (const [column, v] of Object.entries(this.filter(clause, entry, {}))) {
								const had = exclude[column] === undefined ? [] : ([] as unknown[]).concat(exclude[column]);
								exclude[column] = [...new Set([...had, ...([] as unknown[]).concat(v)])];
							}
						}
					}
					else this.notTranslated(b, part, `"${part}" in the filter is left out: loaders carry over only term, match and terms inside must or filter, so this list may hold entries TakeShape left out.`);
				}
				continue;
			}
			const body = literalVars(f.value);
			const pairs = isObj(body) ? Object.entries(body) : [];
			if ((key === "term" || key === "match" || key === "terms") && pairs.length === 1) {
				const [field, raw] = pairs[0]!;
				if (STATUS_FIELDS.has(field)) continue;
				const value = isObj(raw) && !isVariableRef(raw) && "query" in raw ? raw.query : isObj(raw) && !isVariableRef(raw) && "value" in raw ? raw.value : raw;
				const prop = entry.properties[field];
				if (key === "match" && !(prop?.kind === "scalar" && EXACT_MATCH_TYPES.has(prop.type))) {
					this.notTranslated(f, field, `The "match" on "${field}" is left out: TakeShape matched it against the words of the text, which an EmDash equality cannot do, so this list may hold entries TakeShape left out.`);
					continue;
				}
				if (key === "terms" ? Array.isArray(value) || isVariableRef(value) : isPlainValue(value)) {
					this.condition(field, value, f, entry, out);
					continue;
				}
			}
			this.notTranslated(f, key, `"${key}" in the filter is left out: loaders carry over only term, match and terms inside must or filter, so this list may hold entries TakeShape left out.`);
		}
		return out;
	}

	/** A filter clause, or list of them, that is only term, match and terms on one field each, none on the status. */
	plainClauses(node: ValueNode): boolean {
		const clauses = node.kind === "ListValue" ? node.values : [node];
		return clauses.every((c) => {
			const body = literalVars(c);
			if (!isObj(body) || Object.keys(body).length !== 1) return false;
			const [kind, test] = Object.entries(body)[0]!;
			return (kind === "term" || kind === "match" || kind === "terms") && isObj(test) && Object.keys(test).length === 1 && !STATUS_FIELDS.has(Object.keys(test)[0]!);
		});
	}

	/** A filter clause, or list of them, that only tests `_enabled` or `_status`. */
	statusOnly(node: ValueNode): boolean {
		const clauses = node.kind === "ListValue" ? node.values : [node];
		return clauses.every((c) => {
			const body = literal(c);
			if (!isObj(body) || Object.keys(body).length !== 1) return false;
			const [kind, test] = Object.entries(body)[0]!;
			return (kind === "term" || kind === "match" || kind === "terms") && isObj(test) && Object.keys(test).length === 1 && STATUS_FIELDS.has(Object.keys(test)[0]!);
		});
	}

	// -------------------------------------------------------------------------
	// Entry fields
	// -------------------------------------------------------------------------

	/** The fields of one entry of `shape`. */
	entry(children: Flat[], shape: string, entry: CollectionEntry): SelectionPlan[] {
		const ts = this.schema.shapes.get(shape);
		const out: SelectionPlan[] = [];
		for (const c of children) {
			const name = c.node.name.value;
			if (META.has(name)) {
				if (LEGACY_META.has(name) && !entry.legacy) {
					this.notTranslated(c.node, name, `"${name}" is left out: it needs the TakeShape ids and dates the converter keeps by default, and this field map was written with --no-legacy-fields.`);
					continue;
				}
				out.push({ alias: c.key, source: { kind: "meta", name: name as Extract<FieldSource, { kind: "meta" }>["name"] }, selection: [] });
				continue;
			}
			const reverse = this.schema.reverse.get(shape)?.get(name);
			if (reverse && !entry.properties[name]) {
				const plan = this.reverse(c, reverse);
				if (plan) out.push(plan);
				continue;
			}
			const plan = this.property(c, shape, entry, entry.properties, ts?.properties ?? {});
			if (plan) out.push(plan);
		}
		return out;
	}

	/** The draftjs property an `xHtml` field renders, among `props`. */
	htmlOf(name: string, tsProps: Record<string, TSProperty>): string | null {
		for (const [prop, p] of Object.entries(tsProps)) if (p.kind === "draftjs" && camelCase([prop, "html"]) === name) return prop;
		return null;
	}

	/** Reports the image parameters of a rich-text `xHtml` argument (imageConfig, images) that the image endpoint can't honor. */
	imageParams(arg: ArgumentNode, field: string, value: unknown): void {
		const name = arg.name.value;
		const sets: Array<[string, unknown]> = name === "imageConfig" ? [["imageConfig", value]] : name === "images" && isObj(value) ? Object.entries(value).map(([size, p]) => [`images.${size}`, p]) : [];
		for (const [where, params] of sets) {
			if (!isObj(params)) continue;
			for (const [key, v] of Object.entries(params)) {
				const problem = imageParamProblem(key, v);
				if (!problem) continue;
				this.report.add({
					kind: "image-param",
					file: this.file,
					line: lineOf(arg),
					construct: key,
					message: `"${field}" passes "${key}" in ${where}: the image endpoint ${problem}.`,
				});
			}
		}
	}

	/** A property of an entry or of an inline object in it. */
	property(c: Flat, shape: string, entry: CollectionEntry, props: Record<string, PropertyMapEntry>, tsProps: Record<string, TSProperty>): SelectionPlan | null {
		const name = c.node.name.value;
		const alias = c.key;
		// TakeShape answered `xHtml`, and `x(format: html)`, with a rich-text field's HTML
		const formatHtml = (c.node.arguments ?? []).some((a) => a.name.value === "format" && literal(a.value) === "html");
		const html = props[name] ? (formatHtml && props[name]?.kind === "richText" ? name : null) : this.htmlOf(name, tsProps);
		if (html) {
			const rich = props[html];
			if (rich?.kind !== "richText") {
				this.notTranslated(c.node, name, `"${name}" is left out: the converter did not keep ${html} as rich text.`);
				return null;
			}
			const args: Record<string, unknown> = {};
			for (const arg of c.node.arguments ?? []) {
				if (arg.name.value === "format") continue;
				const value = literal(arg.value);
				if (value === VARIABLE) this.notTranslated(arg, arg.name.value, `"${arg.name.value}" takes a variable, which loaders do not fill in yet, so it is left out.`);
				else {
					args[arg.name.value] = value;
					this.imageParams(arg, name, value);
				}
			}
			const markdown = rich.format === "markdown" ? { markdown: true as const } : {};
			return { alias, source: { kind: "richTextHtml", field: rich.field, sidecar: entry.richTextSidecar, args, ...markdown }, selection: [] };
		}
		const mapped = props[name];
		const ts = tsProps[name];
		if (!mapped) {
			const why = ts?.kind === "service" ? "it comes from a connected service, not from stored content" : ts ? "the converter did not keep it" : "it is not a field of this shape";
			this.notTranslated(c.node, name, `"${name}" is left out: ${why}.`);
			return null;
		}
		switch (mapped.kind) {
			case "json":
				// A relationship to several shapes, kept as links: each link's target, built for its shape
				if (c.selections.length && ts?.kind === "relationship") {
					const targets: Array<{ shape: string; collection: string; selection: SelectionPlan[] }> = [];
					for (const target of ts.targets) {
						const e = this.collectionOf(target);
						if (e) targets.push({ shape: target, collection: e.collection, selection: this.entry(this.flattenFor(c.selections, target), target, e) });
					}
					return { alias, source: { kind: "links", field: mapped.field, multiple: ts.multiple, targets }, selection: [] };
				}
				// With the TakeShape properties of what it holds, the loader builds what the query selects under it
				if (c.selections.length && ts?.properties) {
					return { alias, source: { kind: "json", field: mapped.field, multiple: ts.kind === "array" || ts.multiple }, selection: this.jsonFields(c.selections, ts.properties) };
				}
				if (c.selections.length) this.note(c.node, name, `"${name}" is kept as JSON, so the loader returns the stored value whole instead of the fields selected under it.`);
				return { alias, source: { kind: "scalar", field: mapped.field }, selection: [] };
			case "scalar":
				if (c.selections.length) this.note(c.node, name, `"${name}" is kept as JSON, so the loader returns the stored value whole instead of the fields selected under it.`);
				return { alias, source: { kind: "scalar", field: mapped.field, ...(ts?.default !== undefined ? { default: ts.default } : {}) }, selection: [] };
			case "entrySlug":
				return { alias, source: { kind: "scalar", field: "slug" }, selection: [] };
			case "richText":
				if (mapped.format === "draftjs") {
					this.note(
						c.node,
						name,
						`"${name}" returns Draft.js JSON rebuilt from the field's Portable Text, as TakeShape returned the stored Draft.js here: keys, text, block types, list depth, styles with an EmDash mark, links, image asset ids and oEmbed HTML. Other styles, images inside a paragraph, and the depth of blocks other than list items are not kept.`,
					);
					return { alias, source: { kind: "draftJson", field: mapped.field, sidecar: entry.richTextSidecar }, selection: [] };
				}
				this.note(c.node, name, `"${name}" returns the field's Portable Text from EmDash. TakeShape returned the Markdown text here, so code that reads it needs a rewrite.`);
				return { alias, source: { kind: "scalar", field: mapped.field }, selection: [] };
			case "richTextPlain":
				this.note(c.node, name, `"${name}" returns plain text: the converter kept this single-line rich text field as text. TakeShape returned Draft.js JSON here.`);
				return { alias, source: { kind: "scalar", field: mapped.field }, selection: [] };
			case "asset":
				return { alias, source: { kind: "asset", field: mapped.field, multiple: mapped.multiple }, selection: this.asset(this.flatten(c.selections)) };
			case "reference": {
				const target = this.fieldMap.shapes[mapped.target];
				if (target?.kind !== "collection") {
					this.notTranslated(c.node, name, `"${name}" is left out: ${mapped.target} is not an EmDash collection.`);
					return null;
				}
				return {
					alias,
					source: {
						kind: "reference",
						field: mapped.field,
						target: mapped.target,
						collection: target.collection,
						multiple: mapped.multiple,
						...(mapped.multiple && entry.linkOrder ? { order: entry.linkOrder } : {}),
					},
					selection: this.entry(this.flatten(c.selections), mapped.target, target),
				};
			}
			case "taxonomy": {
				const multiple = ts ? ts.multiple : mapped.multiple;
				// The converter keeps TakeShape's order of each entry's terms; a field map written before it did has no slot
				if (multiple && !(entry.termOrder ?? null)) {
					this.note(c.node, name, `"${name}" lists terms in label order: this field map has no TakeShape term order (convert the site again with the current ts2emdash to keep it), so a page that prints them may show another order.`);
				}
				return { alias, source: { kind: "taxonomy", taxonomy: mapped.taxonomy, multiple }, selection: this.terms(this.flatten(c.selections), mapped.target) };
			}
			case "object": {
				const selection: SelectionPlan[] = [];
				for (const sub of this.flatten(c.selections)) {
					const plan = this.property(sub, shape, entry, mapped.properties, ts?.properties ?? {});
					if (plan) selection.push(plan);
				}
				return { alias, source: { kind: "object", ...storedFields(mapped.properties) }, selection };
			}
			case "repeater": {
				// Each row reads like an entry: its text and images sit under the row field names the map gives
				const selection: SelectionPlan[] = [];
				for (const sub of this.flatten(c.selections)) {
					const plan = this.property(sub, shape, entry, mapped.properties, ts?.properties ?? {});
					if (plan) selection.push(plan);
				}
				return { alias, source: { kind: "repeater", field: mapped.field }, selection };
			}
			case "skipped":
				this.notTranslated(c.node, name, `"${name}" is left out: the converter skipped it (${mapped.reason}).`);
				return null;
		}
	}

	asset(children: Flat[]): SelectionPlan[] {
		const out: SelectionPlan[] = [];
		for (const c of children) {
			const name = c.node.name.value;
			// TakeShape's s3Key was the asset's path, which the image and asset filters take; here it is the storage key
			if (name === "s3Key") {
				out.push({ alias: c.key, source: { kind: "assetField", name: "path" }, selection: [] });
				continue;
			}
			if (!ASSET_FIELDS.has(name)) {
				this.notTranslated(c.node, name, `"${name}" of an asset is left out: EmDash image and file fields keep the file, its name, type and alt text.`);
				continue;
			}
			if (name === "description") {
				this.note(c.node, name, `"description" comes from the image's alt text, which the converter filled from the asset's description, or its title or caption when it had none.`);
			} else if (name === "title") {
				this.note(c.node, name, `"title" comes from the asset's title, which the converter keeps in the image's meta when it preloads media (--preload-media). Without the preload, and for images chosen in EmDash later, it comes back empty.`);
			} else if (name === "caption" || name === "credit") {
				this.notTranslated(c.node, name, `"${name}" of an asset comes back empty: EmDash keeps no ${name} on an image or file field.`);
			}
			out.push({ alias: c.key, source: { kind: "assetField", name: name as Extract<FieldSource, { kind: "assetField" }>["name"] }, selection: [] });
		}
		return out;
	}

	/** The fields of a taxonomy term: its label and slug properties. */
	terms(children: Flat[], taxonomyShape: string): SelectionPlan[] {
		const tax = this.fieldMap.shapes[taxonomyShape];
		const out: SelectionPlan[] = [];
		for (const c of children) {
			const name = c.node.name.value;
			if (tax?.kind === "taxonomy" && name === tax.labelProperty) out.push({ alias: c.key, source: { kind: "scalar", field: "label" }, selection: [] });
			else if (tax?.kind === "taxonomy" && name === tax.slugProperty) out.push({ alias: c.key, source: { kind: "scalar", field: "slug" }, selection: [] });
			else this.notTranslated(c.node, name, `"${name}" of a ${taxonomyShape} is left out: an EmDash term keeps only its label and slug.`);
		}
		return out;
	}

	reverse(c: Flat, rev: { shape: string; property: string; others?: Array<{ property: string }> }): SelectionPlan | null {
		const name = c.node.name.value;
		const from = this.collectionOf(rev.shape);
		const mappedAt = (property: string): PropertyMapEntry | undefined => {
			let found: PropertyMapEntry | undefined;
			let props = from?.properties;
			for (const part of property.split(".")) {
				found = props?.[part];
				props = found?.kind === "object" ? found.properties : undefined;
			}
			return found;
		};
		const mapped = mappedAt(rev.property);
		// The other fields an unnamed reverse field reads through, where the converter kept them as references
		const also = (rev.others ?? []).map((o) => mappedAt(o.property)).flatMap((m) => (m?.kind === "reference" ? [m.field] : []));
		// A relation-bound field reads like any other: runtime/references.ts takes the relation and its end from EmDash
		if (!from || mapped?.kind !== "reference") {
			this.notTranslated(c.node, name, `"${name}" is left out: ${rev.shape}.${rev.property} is not a reference field the converter kept on ${rev.shape}.`);
			return null;
		}
		// A reverse field is TakeShape's list resolver with the link as its base condition, so it takes a list's arguments
		const args = c.node.arguments?.length ? this.args(c.node, "list", from, rev.shape) : null;
		if (this.schema.shapes.get(rev.shape)?.onlyEnabledFilters === false) {
			this.note(c.node, name, `"${name}" lists published ${rev.shape} entries only. ${rev.shape} has no workflow (apiVersion 1), so TakeShape listed drafts here too, and EmDash's reference reads return published entries only.`);
		}
		return {
			alias: c.key,
			source: { kind: "reverse", shape: rev.shape, property: rev.property, collection: from.collection, field: mapped.field, ...(also.length ? { also } : {}), ...(args ? { args } : {}) },
			selection: this.list(this.flatten(c.selections), rev.shape, from),
		};
	}

	// -------------------------------------------------------------------------
	// The document
	// -------------------------------------------------------------------------

	plan(file: string, doc: DocumentNode): QueryPlan {
		for (const def of doc.definitions) {
			if (def.kind !== "FragmentDefinition") continue;
			this.fragments.set(def.name.value, def.selectionSet.selections);
			this.fragmentTypes.set(def.name.value, def.typeCondition.name.value);
		}
		const operations = doc.definitions.filter((d): d is OperationDefinitionNode => d.kind === "OperationDefinition");
		const op = operations.find((o) => o.operation === "query");
		for (const other of operations) {
			if (other !== op) this.notTranslated(other, other.operation, `Only the first query in a file is translated, as takeshape-ssg could run only one.`);
		}
		if (!op) return { file, variables: [], fields: [], paginatedAlias: null, legacyFields: this.legacyFields };
		const variables = (op.variableDefinitions ?? []).map((v) => v.variable.name.value);
		const defaults: Record<string, unknown> = {};
		for (const v of op.variableDefinitions ?? []) if (v.defaultValue) defaults[v.variable.name.value] = literal(v.defaultValue);
		// A variable tsg.yml leaves out takes its default, as the loader fills it in (emit-loader.mts)
		this.variables = { ...defaults, ...this.variables };
		const fields: TopFieldPlan[] = [];
		for (const f of this.flatten(op.selectionSet.selections)) {
			const plan = this.top(f);
			if (plan) fields.push(plan);
		}
		return { file, variables, fields, paginatedAlias: this.paginated(fields), legacyFields: this.legacyFields, ...(Object.keys(defaults).length ? { variableDefaults: defaults } : {}) };
	}

	/**
	 * takeshape-ssg's findPaginatedFields: the fields whose arguments include `from` and `size` (lists and reverse
	 * fields), not counting those inside another. It pages a route's data only when there is exactly one.
	 */
	paginated(fields: TopFieldPlan[]): string | null {
		const inside = (selection: SelectionPlan[]): number =>
			selection.reduce((n, s) => n + (s.source.kind === "reverse" ? 1 : inside(s.selection)), 0);
		let count = 0;
		let alias: string | null = null;
		for (const f of fields) {
			if (f.op === "list") {
				count++;
				alias = f.legacyListShape ? null : f.alias;
			} else count += inside(f.selection);
		}
		return count === 1 ? alias : null;
	}
}

/** Every EmDash field stored under an inline object, depth first: the columns, and the reference fields apart. */
function storedFields(props: Record<string, PropertyMapEntry>): { fields: string[]; references: string[] } {
	const out = { fields: [] as string[], references: [] as string[] };
	for (const p of Object.values(props)) {
		if (p.kind === "object") {
			const inner = storedFields(p.properties);
			out.fields.push(...inner.fields);
			out.references.push(...inner.references);
		} else if (p.kind === "reference") out.references.push(p.field);
		else if ("field" in p) out.fields.push(p.field);
	}
	return out;
}

/**
 * `variables` are the ones tsg.yml passes with the query (`{query, variables}`). Only the status rule reads them:
 * other clauses that hold a variable are reported and left out.
 */
export function planQuery(file: string, source: string, schema: TSSchemaModel, fieldMap: FieldMap, report: Report, variables: Record<string, unknown> = {}): QueryPlan {
	let doc: DocumentNode;
	try {
		doc = parse(source);
	} catch (e) {
		report.add({ kind: "not-translated", file, message: `The query could not be parsed, so it has no loader: ${e instanceof Error ? e.message : String(e)}` });
		return { file, variables: [], fields: [], paginatedAlias: null, legacyFields: true };
	}
	return new Planner(file, schema, fieldMap, report, variables).plan(file, doc);
}
