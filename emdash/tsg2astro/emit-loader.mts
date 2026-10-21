/**
 * Writes the loader module for a query plan. `load(api, variables, { paginate })` reads EmDash through the
 * helpers in runtime/query.ts, one read per list, reference, taxonomy and reverse field, each for every entry of its
 * level at once, and returns an object shaped like the response the query got from TakeShape. The first half of
 * `load` reads, the second builds the response, field by field in query order, so a developer can read the query
 * and the loader side by side. Reads that need nothing read before them go out together, in one Promise.all per
 * depth: the top fields first, then what each top field's entries point at, and so on. Each read names the columns
 * its entries are built from (`select`), so EmDash's rows come back without the fields the query never asked for.
 */
import type { EmittedFile } from "./emit-astro.mts";
import { load } from "./load.mts";
import { listOptions } from "./queries.mts";
import type { QueryPlan, SelectionPlan, TopFieldPlan } from "./queries.mts";
import { importPath, RUNTIME_DIR } from "./scope.mts";

export const LOADERS_DIR = "src/loaders";

/** `data/books.graphql` becomes `src/loaders/data/books.ts`. `name` is the plan's outName, or its file. */
export function loaderPath(name: string): string {
	return `${LOADERS_DIR}/${name.replace(/\.(graphql|gql)$/, "")}.ts`;
}

const TAB = "\t";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(
	(
		"break case catch class const continue debugger default delete do else enum export extends false finally for function if import in " +
		"instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package " +
		"private protected public await async arguments eval undefined NaN Infinity api load paginate variables"
	).split(" "),
);
const HELPERS = ["assetValue", "assetValues", "draftJson", "entryId", "entryIds", "fieldValue", "getEntry", "getSingle", "hasAny", "jsonLinks", "jsonList", "jsonObject", "jsonRichText", "linkTo", "linksTo", "listEntries", "many", "one", "references", "reverseReferencesOf", "richTextHtml", "rows", "settle", "termsOf"];

const camelCase = (await load<{ default: (s: string) => string }>("lodash/camelCase.js", "lodash")).default;
/** A name for generated code: lodash camelCase, kept a valid identifier. */
const camel = (s: string): string => {
	const name = camelCase(s);
	return /^[0-9]/.test(name) ? `_${name}` : name;
};
const pascal = (s: string): string => camelCase(s).replace(/^[a-z]/, (c) => c.toUpperCase());
const plural = (s: string): string => (s.endsWith("s") ? s : `${s}s`);
const singular = (s: string): string => (s.length > 3 && s.endsWith("s") && !s.endsWith("ss") ? s.slice(0, -1) : s);
const access = (field: string): string => (IDENTIFIER.test(field) ? `.${field}` : `[${JSON.stringify(field)}]`);

/** A JSON value as a JavaScript literal, with bare keys where they are identifiers. */
function lit(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (Array.isArray(value)) return `[${value.map(lit).join(", ")}]`;
	// A query variable in a condition (queries.mts literalVars): the value the route passes
	if (typeof value === "object" && Object.keys(value).length === 1 && typeof (value as { $variable?: unknown }).$variable === "string") {
		return `_variables[${JSON.stringify((value as { $variable: string }).$variable)}]`;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (!entries.length) return "{}";
		return `{ ${entries.map(([k, v]) => `${IDENTIFIER.test(k) ? k : JSON.stringify(k)}: ${lit(v)}`).join(", ")} }`;
	}
	return JSON.stringify(value);
}

/** One level of entries the response is built from. */
type Level = {
	/** TakeShape shape, for `_contentTypeName`. */
	shape: string;
	/** EmDash collection, for terms. */
	collection: string;
	/** Every entry at this level, as an array expression (a single top field may hold null). */
	all: string;
	/** The start of the names of what is read under this level. */
	stem: string;
	/** How many reads come before the reads under this level: 1 under a top field. */
	depth: number;
};

/**
 * One read: a const, the call that fills it, and how many reads must finish before it can start. A read whose
 * columns are known only once every field that uses it is planned (a reference read) renders its call at the end.
 */
type Read = { name: string; call: string; depth: number; render?: () => string };

// The converter's fields that meta fields read; EmDash's own fallbacks (query.ts fieldValue) are system columns
const META_COLUMNS: Partial<Record<string, string>> = { _id: "takeshape_id", _enabledAt: "takeshape_published_at", _createdAt: "takeshape_created_at", _updatedAt: "takeshape_updated_at" };
/** runtime/query.ts TERM_ORDER_FIELD, which termsOf reads from each entry. */
const TERM_ORDER_FIELD = "takeshape_term_order";

/**
 * The columns of an entry that building `selection` from it reads: what entryFields and value() read from
 * `<entry>.data`. A top list's items and an inline object are built from the same entry; repeater rows and JSON
 * values are read from the field that holds them. With `heavy`, only the columns that can hold a lot (rich text and
 * its sidecar, JSON, repeaters, lists of links), which a list that is cut reads for the entries it keeps only.
 */
export function entryColumns(selection: SelectionPlan[], out = new Set<string>(), heavy = false): Set<string> {
	for (const s of selection) {
		const { source } = s;
		switch (source.kind) {
			case "listItems":
				entryColumns(s.selection, out, heavy);
				break;
			case "repeater":
			case "json":
			case "links":
				out.add(source.field);
				break;
			case "scalar":
			case "asset":
				if (!heavy) out.add(source.field);
				break;
			case "meta": {
				const column = META_COLUMNS[source.name];
				if (column && !heavy) out.add(column);
				break;
			}
			case "richTextHtml":
			case "draftJson":
				out.add(source.field);
				if (source.sidecar) out.add(source.sidecar);
				break;
			case "object":
				if (!heavy) for (const field of source.fields) out.add(field);
				entryColumns(s.selection, out, heavy);
				break;
			case "reference":
				if (source.order && !heavy) out.add(source.order);
				break;
			case "taxonomy":
				if (!heavy) out.add(TERM_ORDER_FIELD);
				break;
		}
	}
	return out;
}

const columnsLit = (columns: Iterable<string>): string => lit([...new Set(columns)].sort());

/** The columns each target collection of a link field is built from. */
function targetColumns(targets: Array<{ collection: string; selection: SelectionPlan[] }>): string {
	const byCollection = new Map<string, Set<string>>();
	for (const t of targets) entryColumns(t.selection, byCollection.get(t.collection) ?? byCollection.set(t.collection, new Set()).get(t.collection));
	return `{ ${[...byCollection].map(([c, cols]) => `${IDENTIFIER.test(c) ? c : JSON.stringify(c)}: ${columnsLit(cols)}`).join(", ")} }`;
}

/**
 * For a route that pages through `plan`'s list: an arrow function giving the path values of an entry, built as the
 * item builds them, for the names the route's path reads, and the columns it reads. Null when a name is not a plain
 * value of the item (a nested path, a reference, an image), which the route then finds among the built items.
 */
export function pathValues(plan: QueryPlan, names: string[], param: string): { code: string; columns: string[]; helpers: string[] } | null {
	const field = plan.fields.find((f) => f.alias === plan.paginatedAlias);
	if (!field) return null;
	const items = field.legacyListShape ? field.selection : (field.selection.find((s) => s.source.kind === "listItems")?.selection ?? []);
	const columns = new Set<string>();
	const helpers = new Set<string>();
	const values: string[] = [];
	for (const name of names) {
		if (name.includes(".")) return null;
		const s = items.find((i) => i.alias === name);
		const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
		// No such field: the value is missing, as in the built item
		if (!s) {
			values.push(`${key}: undefined`);
			continue;
		}
		const { source } = s;
		if (source.kind === "scalar") {
			columns.add(source.field);
			values.push(`${key}: (${param}.data${access(source.field)} ?? ${source.default === undefined ? "null" : lit(source.default)})`);
		} else if (source.kind === "meta" && META_COLUMNS[source.name]) {
			columns.add(META_COLUMNS[source.name] as string);
			helpers.add("fieldValue");
			values.push(`${key}: fieldValue(${param}, ${lit(META_COLUMNS[source.name])})`);
		} else if (source.kind === "meta" && source.name === "_enabled") {
			values.push(`${key}: ${param}.data.status === "published"`);
		} else if (source.kind === "meta" && source.name === "_contentTypeName") {
			values.push(`${key}: ${lit(camelCase(field.shape))}`);
		} else if (source.kind === "meta") {
			values.push(`${key}: ${lit(field.shape)}`);
		} else return null;
	}
	return { code: `(${param}) => ({ ${values.join(", ")} })`, columns: [...columns].sort(), helpers: [...helpers] };
}

class LoaderEmitter {
	readonly plan: QueryPlan;
	readonly taken = new Set<string>(RESERVED);
	readonly reads: Read[] = [];
	/** The const holding the read behind each selection node. */
	readonly readOf = new Map<SelectionPlan | TopFieldPlan, string>();
	/** The reference reads made so far, by level and field, so an inline object reuses them. */
	readonly referenceReads = new Map<string, Read>();
	/** The reference reads that tell whether an inline object was stored. */
	readonly linksOf = new Map<SelectionPlan, string[]>();
	/** The columns of the entries each reference read points at. */
	readonly referenceColumns = new Map<Read, Set<string>>();
	readonly helpers = new Set<string>();

	constructor(plan: QueryPlan) {
		this.plan = plan;
		for (const h of HELPERS) this.taken.add(h);
	}

	name(base: string): string {
		let name = base;
		for (let n = 2; this.taken.has(name); n++) name = `${base}${n}`;
		this.taken.add(name);
		return name;
	}

	use(helper: string): string {
		this.helpers.add(helper);
		return helper;
	}

	/** A callback parameter: unique against the module's consts and the enclosing parameters. */
	param(base: string, enclosing: string[]): string {
		let name = camel(base) || "item";
		for (let n = 2; this.taken.has(name) || enclosing.includes(name); n++) name = `${camel(base) || "item"}${n}`;
		return name;
	}

	// -------------------------------------------------------------------------
	// Reads
	// -------------------------------------------------------------------------

	readTop(field: TopFieldPlan): void {
		const paginated = this.plan.paginatedAlias === field.alias;
		if (field.op === "list") {
			const list = this.name(camel(field.collection));
			this.readOf.set(field, list);
			const { includeDrafts, defaultSize } = listOptions(field);
			const { args } = field;
			// takeshape-ssg dropped size and from on the list it paged through, and fetched it all
			const sizeOrAll = (n: number | null) => (paginated && n !== null ? `paginate ? null : ${n}` : lit(n));
			const exclude = `${args.exclude ? `, exclude: ${lit(args.exclude)}` : ""}${args.through ? `, through: ${lit(args.through)}` : ""}${args.arrayFields ? `, arrayFields: ${lit(args.arrayFields)}` : ""}`;
			const argsLit = `{ sort: ${lit(args.sort)}, where: ${lit(args.where)}, filter: ${lit(args.filter)}, size: ${sizeOrAll(args.size)}, from: ${sizeOrAll(args.from)}, id: null${exclude} }`;
			const legacy = this.plan.legacyFields ? "" : ", legacyFields: false";
			const pick = paginated ? ", pick" : "";
			const select = `select: ${columnsLit(entryColumns(field.selection))}, heavy: ${columnsLit(entryColumns(field.selection, new Set(), true))}`;
			const options = `{ includeDrafts: ${includeDrafts}, defaultSize: ${paginated ? `paginate ? null : ${defaultSize}` : defaultSize}${legacy}, ${select}${pick} }`;
			this.reads.push({ name: list, call: `${this.use("listEntries")}(api, ${lit(field.collection)}, ${argsLit}, ${options})`, depth: 0 });
			this.readLevel(field.selection, { shape: field.shape, collection: field.collection, all: list, stem: camel(field.shape), depth: 1 });
			return;
		}
		const one = this.name(camel(field.shape));
		this.readOf.set(field, one);
		const select = columnsLit(entryColumns(field.selection));
		const call = field.op === "single" ? `${this.use("getSingle")}(api, ${lit(field.collection)}, ${select})` : `${this.use("getEntry")}(api, ${lit(field.collection)}, ${lit(field.args.id)}, ${select})`;
		this.reads.push({ name: one, call, depth: 0 });
		this.readLevel(field.selection, { shape: field.shape, collection: field.collection, all: `[${one}]`, stem: one, depth: 1 });
	}

	/**
	 * The read of one reference field for every entry of a level, made once. `targets` is what a field builds from
	 * the entries it points at; the read gets the columns of every field that uses it.
	 */
	referenceRead(level: Level, field: string, base: string, targets: SelectionPlan[] | null, order?: string): Read {
		const key = `${level.all}\u0000${field}`;
		let found = this.referenceReads.get(key);
		if (!found) {
			const columns = new Set<string>();
			const call = `${this.use("references")}(api, ${lit(level.collection)}, ${level.all}, ${lit(field)}`;
			const read: Read = { name: this.name(base), call, depth: level.depth, render: () => `${call}, ${columnsLit(columns)}${order ? `, ${lit(order)}` : ""})` };
			this.referenceColumns.set(read, columns);
			found = read;
			this.referenceReads.set(key, found);
			this.reads.push(found);
		}
		if (targets) entryColumns(targets, this.referenceColumns.get(found));
		return found;
	}

	/** The reads under one level, depth first. */
	readLevel(selection: SelectionPlan[], level: Level): void {
		for (const s of selection) {
			const { source } = s;
			if (source.kind === "listItems") this.readLevel(s.selection, level);
			else if (source.kind === "object") {
				this.readLevel(s.selection, level);
				// EmDash keeps reference fields out of `data`, so whether the object holds a link takes a read
				this.linksOf.set(s, source.references.map((field) => this.referenceRead(level, field, `${level.stem}${pascal(plural(camel(field)))}`, null).name));
			} else if (source.kind === "reference") {
				const found = this.referenceRead(level, source.field, `${level.stem}${pascal(plural(s.alias))}`, s.selection, source.order);
				this.readOf.set(s, found.name);
				this.readLevel(s.selection, { shape: source.target, collection: source.collection, all: `${found.name}.entries`, stem: singular(camel(s.alias)), depth: found.depth + 1 });
			} else if (source.kind === "taxonomy") {
				const terms = this.name(`${level.stem}${pascal(plural(s.alias))}`);
				this.readOf.set(s, terms);
				this.reads.push({ name: terms, call: `${this.use("termsOf")}(api, ${lit(level.collection)}, ${level.all}, ${lit(source.taxonomy)})`, depth: level.depth });
			} else if (source.kind === "json") {
				this.readJson(s.selection, level, source.field, []);
			} else if (source.kind === "links") {
				const read: Read = {
					name: this.name(`${level.stem}${pascal(plural(camel(s.alias)))}`),
					call: `${this.use("jsonLinks")}(api, ${level.all}, ${lit(source.field)}, [], ${targetColumns(source.targets)})`,
					depth: level.depth,
				};
				this.reads.push(read);
				this.readOf.set(s, read.name);
				for (const t of source.targets) {
					this.readLevel(t.selection, { shape: t.shape, collection: t.collection, all: `${read.name}.entries(${lit(t.collection)})`, stem: `${singular(camel(s.alias))}${pascal(t.shape)}`, depth: read.depth + 1 });
				}
			} else if (source.kind === "reverse") {
				const lookup = this.name(`${camel(source.collection)}By${pascal(source.field)}`);
				this.readOf.set(s, lookup);
				const options = [...(this.plan.legacyFields ? [] : ["legacyFields: false"]), ...(source.args ? [`args: ${lit(source.args)}`] : []), `select: ${columnsLit(entryColumns(s.selection))}`];
				const opts = `, { ${options.join(", ")} }`;
				const fields = source.also ? lit([source.field, ...source.also]) : lit(source.field);
				this.reads.push({ name: lookup, call: `${this.use("reverseReferencesOf")}(api, ${lit(source.collection)}, ${fields}, ${level.all}${opts})`, depth: level.depth });
				this.readLevel(s.selection, { shape: source.shape, collection: source.collection, all: `${lookup}.entries`, stem: camel(source.shape), depth: level.depth + 1 });
			}
		}
	}

	/** The reads under a JSON field: one per link path for every entry of the level, then what each target reads. */
	readJson(selection: SelectionPlan[], level: Level, field: string, path: string[]): void {
		for (const s of selection) {
			const { source } = s;
			if (source.kind === "jsonObject") this.readJson(s.selection, level, field, [...path, source.key]);
			else if (source.kind === "jsonLink") {
				const read: Read = {
					name: this.name(`${level.stem}${pascal(plural(camel(s.alias)))}`),
					call: `${this.use("jsonLinks")}(api, ${level.all}, ${lit(field)}, ${lit([...path, source.key])}, ${targetColumns(source.targets)})`,
					depth: level.depth,
				};
				this.reads.push(read);
				this.readOf.set(s, read.name);
				for (const t of source.targets) {
					this.readLevel(t.selection, { shape: t.shape, collection: t.collection, all: `${read.name}.entries(${lit(t.collection)})`, stem: `${singular(camel(s.alias))}${pascal(t.shape)}`, depth: read.depth + 1 });
				}
			}
		}
	}

	// -------------------------------------------------------------------------
	// The response
	// -------------------------------------------------------------------------

	/**
	 * An object literal over several lines. `depth` is the indent of the line it starts on: its fields go one
	 * deeper and its closing brace at `depth`. Every `depth` below means that.
	 */
	object(lines: string[], depth: number): string {
		if (!lines.length) return "{}";
		// A short object of plain values stays on one line: `(genre) => ({ title: genre.label })`
		if (lines.length <= 2 && lines.every((l) => !l.includes("\n")) && lines.join(", ").length <= 60) return `{ ${lines.join(", ")} }`;
		const pad = TAB.repeat(depth + 1);
		return `{\n${lines.map((l) => `${pad}${l},`).join("\n")}\n${TAB.repeat(depth)}}`;
	}

	/** `({...})` as the body of an arrow function. */
	arrow(param: string, body: string): string {
		return `(${param}) => (${body})`;
	}

	/** The fields of an entry `v` (an EmDash entry) in `level`. */
	entryFields(selection: SelectionPlan[], v: string, level: Pick<Level, "shape">, depth: number, enclosing: string[]): string[] {
		const lines: string[] = [];
		for (const s of selection) {
			const value = this.value(s, v, level, depth, enclosing);
			// A list can hold hundreds of entries a template never prints in full, so rich text renders when one reads it, once
			if (s.source.kind === "richTextHtml") lines.push(`get ${s.alias}() { return ${this.use("settle")}(this, ${lit(s.alias)}, () => ${value}); }`);
			else lines.push(`${s.alias}: ${value}`);
		}
		return lines;
	}

	value(s: SelectionPlan, v: string, level: Pick<Level, "shape">, depth: number, enclosing: string[]): string {
		const { source } = s;
		const inner = [...enclosing, v];
		switch (source.kind) {
			case "links": {
				const read = this.readOf.get(s) as string;
				const builders = source.targets.map((t) => {
					const e = this.param(camel(t.shape), inner);
					return `${lit(t.collection)}: ${this.arrow(e, this.object(this.entryFields(t.selection, e, { shape: t.shape }, depth + 2, [...inner, e]), depth + 1))}`;
				});
				const map = builders.length ? `{\n${TAB.repeat(depth + 1)}${builders.join(`,\n${TAB.repeat(depth + 1)}`)},\n${TAB.repeat(depth)}}` : "{}";
				return `${this.use(source.multiple ? "linksTo" : "linkTo")}(${read}, ${v}.data${access(source.field)}, ${map})`;
			}
			case "scalar":
				// A value the entry never stored is the property's default, as TakeShape answered it, else null, as GraphQL
				// answered a selected field with no value
				return `(${v}.data${access(source.field)} ?? ${source.default === undefined ? "null" : lit(source.default)})`;
			case "meta":
				switch (source.name) {
					// TakeShape answered _contentTypeName with the shape name in camelCase, and the GraphQL type name as is
					case "_contentTypeName":
						return lit(camelCase(level.shape));
					case "_shapeName":
					case "__typename":
						return lit(level.shape);
					case "_enabled":
						return `${v}.data.status === "published"`;
					// The converter's fields, or EmDash's own values for an entry made after the move
					case "_id":
						return `${this.use("fieldValue")}(${v}, "takeshape_id")`;
					case "_enabledAt":
						return `${this.use("fieldValue")}(${v}, "takeshape_published_at")`;
					case "_createdAt":
						return `${this.use("fieldValue")}(${v}, "takeshape_created_at")`;
					case "_updatedAt":
						return `${this.use("fieldValue")}(${v}, "takeshape_updated_at")`;
				}
				break;
			case "richTextHtml":
				return `${this.use("richTextHtml")}(${v}, ${lit(source.field)}, ${lit(source.sidecar)}, ${lit(source.args)}${source.markdown ? ", true" : ""})`;
			case "draftJson":
				return `${this.use("draftJson")}(${v}, ${lit(source.field)}, ${lit(source.sidecar)})`;
			case "asset": {
				const p = this.param(singular(s.alias), inner);
				const fields = s.selection.map((a) => `${a.alias}: ${p}.${a.source.kind === "assetField" ? a.source.name : "path"}`);
				const wrap = source.multiple ? `${this.use("many")}(${this.use("assetValues")}(` : `${this.use("one")}(${this.use("assetValue")}(`;
				return `${wrap}${v}.data${access(source.field)}), ${this.arrow(p, this.object(fields, depth))})`;
			}
			case "reference": {
				const found = this.readOf.get(s) as string;
				const p = this.param(singular(s.alias), inner);
				const body = this.object(this.entryFields(s.selection, p, { shape: source.target }, depth + 1, inner), depth);
				const targets = `${found}.of(${v})`;
				return source.multiple ? `${this.use("many")}(${targets}, ${this.arrow(p, body)})` : `${this.use("one")}(${targets}[0], ${this.arrow(p, body)})`;
			}
			case "taxonomy": {
				const terms = this.readOf.get(s) as string;
				const p = this.param(singular(s.alias), inner);
				const body = this.object(s.selection.map((t) => `${t.alias}: ${p}.${t.source.kind === "scalar" ? t.source.field : "label"}`), depth);
				const of = `${terms}.of(${v})`;
				return source.multiple ? `${this.use("many")}(${of}, ${this.arrow(p, body)})` : `${this.use("one")}(${of}[0], ${this.arrow(p, body)})`;
			}
			case "reverse": {
				const list = `${this.readOf.get(s) as string}.of(${v})`;
				return this.object(this.listFields(s.selection, list, source.shape, depth + 1, inner), depth);
			}
			case "object": {
				// An inline object with nothing stored in it was never saved, and TakeShape returned null for it
				const links = this.linksOf.get(s) ?? [];
				const stored = links.length ? `${this.use("hasAny")}(${v}, ${lit(source.fields)}, [${links.join(", ")}])` : `${this.use("hasAny")}(${v}, ${lit(source.fields)})`;
				return `${stored} ? ${this.object(this.entryFields(s.selection, v, level, depth + 1, enclosing), depth)} : null`;
			}
			case "json":
				return this.jsonWrap(s.selection, `${v}.data${access(source.field)}`, source.multiple, s.alias, depth, inner);
			case "repeater": {
				// Each row as an entry's data, so its text and images build as an entry's do. TakeShape returned null for an unset list
				const list = this.param(plural(camel(s.alias)), inner);
				const p = this.param(singular(camel(s.alias)), [...inner, list]);
				const body = this.object(this.entryFields(s.selection, p, level, depth + 1, [...inner, list, p]), depth);
				return `${this.use("one")}(${this.use("rows")}(${v}.data${access(source.field)}), ${this.arrow(list, `${this.use("many")}(${list}, ${this.arrow(p, body)})`)})`;
			}
			case "listTotal":
			case "listItems":
				break;
		}
		return "null";
	}

	/** A JSON value as TakeShape returned it: one object, or a list of them, each built from what the query selects. */
	jsonWrap(selection: SelectionPlan[], value: string, multiple: boolean, alias: string, depth: number, enclosing: string[]): string {
		const p = this.param(singular(camel(alias)), enclosing);
		const body = this.object(this.jsonFields(selection, p, depth + 1, [...enclosing, p]), depth);
		if (!multiple) return `${this.use("one")}(${this.use("jsonObject")}(${value}), ${this.arrow(p, body)})`;
		const list = this.param(plural(camel(alias)), [...enclosing, p]);
		return `${this.use("one")}(${this.use("jsonList")}(${value}), ${this.arrow(list, `${this.use("many")}(${list}, ${this.arrow(p, body)})`)})`;
	}

	/** The fields of one object inside a JSON value `x`: values as stored, images as assets, links as their targets. */
	jsonFields(selection: SelectionPlan[], x: string, depth: number, enclosing: string[]): string[] {
		return selection.map((s) => {
			const source = s.source;
			const key = "key" in source ? (source.key as string) : s.alias;
			const at = `${x}${access(key)}`;
			switch (source.kind) {
				case "jsonAsset": {
					const p = this.param(singular(camel(s.alias)), enclosing);
					const fields = s.selection.map((a) => `${a.alias}: ${p}.${a.source.kind === "assetField" ? a.source.name : "path"}`);
					const wrap = source.multiple ? `${this.use("many")}(${this.use("assetValues")}(` : `${this.use("one")}(${this.use("assetValue")}(`;
					return `${s.alias}: ${wrap}${at}), ${this.arrow(p, this.object(fields, depth))})`;
				}
				case "jsonObject":
					return `${s.alias}: ${this.jsonWrap(s.selection, at, source.multiple, s.alias, depth, enclosing)}`;
				case "jsonRichText": {
					const value = `${this.use("jsonRichText")}(${at}, ${source.html}, ${lit(source.args)})`;
					// HTML renders only when a template reads it, as an entry's rich text does
					return source.html ? `get ${s.alias}() { return ${this.use("settle")}(this, ${lit(s.alias)}, () => ${value}); }` : `${s.alias}: ${value}`;
				}
				case "jsonLink": {
					const read = this.readOf.get(s) as string;
					const builders = source.targets.map((t) => {
						const e = this.param(camel(t.shape), enclosing);
						return `${lit(t.collection)}: ${this.arrow(e, this.object(this.entryFields(t.selection, e, { shape: t.shape }, depth + 2, [...enclosing, e]), depth + 1))}`;
					});
					const map = builders.length ? `{\n${TAB.repeat(depth + 1)}${builders.join(`,\n${TAB.repeat(depth + 1)}`)},\n${TAB.repeat(depth)}}` : "{}";
					return `${s.alias}: ${this.use(source.multiple ? "linksTo" : "linkTo")}(${read}, ${at}, ${map})`;
				}
				default:
					// GraphQL answered a field the stored object lacks with the property's default, else null
					return `${s.alias}: ${at} ?? ${source.kind === "jsonValue" && source.default !== undefined ? lit(source.default) : "null"}`;
			}
		});
	}

	/** `total` and `items` of a list expression. */
	listFields(selection: SelectionPlan[], list: string, shape: string, depth: number, enclosing: string[]): string[] {
		return selection.map((s) => {
			if (s.source.kind === "listTotal") return `${s.alias}: ${list}.total`;
			const p = this.param(camel(shape), enclosing);
			return `${s.alias}: ${list}.map(${this.arrow(p, this.object(this.entryFields(s.selection, p, { shape }, depth + 1, [...enclosing, p]), depth))})`;
		});
	}

	topValue(field: TopFieldPlan): string {
		const read = this.readOf.get(field) as string;
		// Each top field starts on a line at depth 2, inside `return {`
		if (field.op !== "list") return `${read} ? ${this.object(this.entryFields(field.selection, read, field, 3, []), 2)} : null`;
		if (field.legacyListShape) {
			const p = this.param(camel(field.shape), []);
			return `${read}.map(${this.arrow(p, this.object(this.entryFields(field.selection, p, field, 3, [p]), 2))})`;
		}
		return this.object(this.listFields(field.selection, read, field.shape, 3, []), 2);
	}

	/** The reads, one statement per depth: a lone read awaits on its own, several share a Promise.all. */
	readLines(): string[] {
		const lines: string[] = [];
		const depths = [...new Set(this.reads.map((r) => r.depth))].sort((a, b) => a - b);
		for (const depth of depths) {
			const wave = this.reads.filter((r) => r.depth === depth);
			const [only] = wave;
			const call = (r: Read) => (r.render ? r.render() : r.call);
			if (wave.length === 1 && only) {
				lines.push(`${TAB}const ${only.name} = await ${call(only)};`);
				continue;
			}
			lines.push(`${TAB}const [${wave.map((r) => r.name).join(", ")}] = await Promise.all([`, ...wave.map((r) => `${TAB}${TAB}${call(r)},`), `${TAB}]);`);
		}
		return lines;
	}

	emit(): EmittedFile {
		for (const field of this.plan.fields) this.readTop(field);
		const response = this.object(this.plan.fields.map((f) => `${f.alias}: ${this.topValue(f)}`), 1);
		const path = loaderPath(this.plan.outName ?? this.plan.file);
		const runtime = importPath(path, `${RUNTIME_DIR}/query.ts`);
		const paginated = this.plan.fields.find((f) => f.alias === this.plan.paginatedAlias);
		const lines: string[] = [`// Loads what ${this.plan.file} asked TakeShape for, from EmDash, in the shape TakeShape's API answered with.`];
		if (this.helpers.size) lines.push(`import { ${[...this.helpers].sort().join(", ")} } from "${runtime}";`);
		lines.push(`import type { EmDashApi, ${paginated ? "LoadOptions, " : ""}Variables } from "${runtime}";`, "");
		if (paginated) {
			lines.push(`/**`, ` * \`paginate\` loads all of ${paginated.alias}, as takeshape-ssg did for a route that pages through this query, and \`pick\``, ` * keeps the entries of it one page needs.`, ` */`);
			lines.push(`export async function load(api: EmDashApi, _variables: Variables = {}, { paginate = false, pick }: LoadOptions = {}) {`);
		} else lines.push(`export async function load(api: EmDashApi, _variables: Variables = {}) {`);
		// The query's variable defaults, under what the route passes
		if (this.plan.variableDefaults) lines.push(`${TAB}_variables = { ...${lit(this.plan.variableDefaults)}, ..._variables };`);
		lines.push(...this.readLines());
		lines.push(`${TAB}return ${response};`, "}", "");
		return { path, source: lines.join("\n") };
	}
}

export function emitLoader(plan: QueryPlan): EmittedFile {
	return new LoaderEmitter(plan).emit();
}
