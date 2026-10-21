/**
 * TakeShape's schema.json as the query planner reads it: each shape's properties, the content queries
 * (getX, getXList, getSingleton), and the reverse fields TakeShape adds for relationships. It reads both
 * relationship formats: `@relationship` with `shapeIds` (older exports), and from schema 3.18 on a getRelated
 * resolver with `@ref` or `oneOf` refs, on `items` for a list, named by `@backreference`.
 */
import { onlyEnabledFilters } from "./list-status.mts";
import { load } from "./load.mts";

export type TSProperty = {
	name: string;
	kind: "scalar" | "draftjs" | "markdown" | "asset" | "relationship" | "object" | "array" | "service";
	multiple: boolean;
	/** Target shape names of a relationship or asset. */
	targets: string[];
	/** The back reference name the property declares, if any. */
	relatedName: string | null;
	/** Sub-properties of an inline object, or of each item of an array of objects. */
	properties?: Record<string, TSProperty>;
	/** A scalar's `default`, which TakeShape's API answered when the entry stored no value (read from its source). */
	default?: unknown;
};
/** `onlyEnabledFilters`: whether a list of this shape without where or filter keeps only published entries (list-status.mts). */
export type TSShape = { name: string; id: string; model: "single" | "multiple" | "taxonomy" | null; properties: Record<string, TSProperty>; onlyEnabledFilters: boolean };
export type ReverseField = { shape: string; property: string; multiple: boolean; others?: Array<{ property: string; multiple: boolean }> };
export type TSSchemaModel = {
	shapes: Map<string, TSShape>;
	queries: Map<string, { shape: string; op: "get" | "list" | "single" }>;
	/**
	 * Target shape name, then reverse field name, then the property that points at the target. An unnamed reverse field
	 * (`<shape>Set`) lists the entries that reference the target through any field (relationships.ts filters on
	 * `_references`), so `others` holds the shape's other properties that point at it.
	 */
	reverse: Map<string, Map<string, ReverseField>>;
};

type Json = Record<string, unknown>;

const camelCase = (await load<{ default: (s: string) => string }>("lodash/camelCase.js", "lodash")).default;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const CONTENT_RESOLVERS = new Set(["takeshape:get", "takeshape:list", "shapedb:get", "shapedb:list"]);

/** The shape name a `$ref` (`#/shapes/X/schema`) or `@ref` (`local:X`) names. */
function refName(p: Json | undefined): string | null {
	const ref = p?.$ref ?? p?.["@ref"];
	if (typeof ref !== "string") return null;
	const m = ref.match(/^#\/shapes\/([^/]+)\/schema$/) ?? ref.match(/^(?:local:)?([A-Za-z_][\w]*)$/);
	return m ? (m[1] as string) : null;
}

export function loadTakeShapeSchema(schemaJson: unknown): TSSchemaModel {
	const raw = isObj(schemaJson) ? schemaJson : {};
	const rawShapes = (isObj(raw.shapes) ? raw.shapes : {}) as Record<string, Json>;
	const forms = (isObj(raw.forms) ? raw.forms : {}) as Record<string, Json>;
	const nameById = new Map<string, string>();
	for (const [key, s] of Object.entries(rawShapes)) if (typeof s.id === "string") nameById.set(s.id, typeof s.name === "string" ? s.name : key);
	const idOfRef = (ref: unknown): string | null => {
		const name = typeof ref === "string" ? ref.replace(/^local:/, "") : "";
		const shape = rawShapes[name];
		return typeof shape?.id === "string" ? shape.id : name === "Asset" ? "ASSET" : null;
	};

	/** A property's relationship in the older form, whichever form the schema uses. TakeShape's getRelationship. */
	function relationshipOf(p: Json): { shapeIds: string[]; type: string; relatedName: string | null } | null {
		const backref = isObj(p["@backreference"]) ? p["@backreference"] : null;
		const named = typeof backref?.name === "string" ? backref.name : null;
		const rel = isObj(p["@relationship"]) ? p["@relationship"] : null;
		if (rel) {
			return {
				shapeIds: Array.isArray(rel.shapeIds) ? rel.shapeIds.map(String) : [],
				type: p.type === "array" || rel.type === "multiple" ? "multiple" : "single",
				relatedName: named ?? (typeof rel.relatedName === "string" ? rel.relatedName : null),
			};
		}
		const out = isObj(p["@output"]) ? p["@output"] : p;
		const resolver = isObj(out["@resolver"]) ? out["@resolver"].name : undefined;
		if (resolver !== "shapedb:getRelated" && resolver !== "takeshape:getRelated") return null;
		const node = isObj(out.items) ? out.items : out;
		const refs = Array.isArray(node.oneOf) ? node.oneOf.map((o) => (isObj(o) ? o["@ref"] : undefined)) : [node["@ref"]];
		return { shapeIds: refs.map(idOfRef).filter((id): id is string => id !== null), type: out.type === "array" ? "multiple" : "single", relatedName: named };
	}
	const schemaOf = (name: string): Json | undefined => {
		const s = rawShapes[name]?.schema;
		return isObj(s) ? s : undefined;
	};
	const propsOf = (schema: Json | undefined): Record<string, Json> => (isObj(schema?.properties) ? (schema.properties as Record<string, Json>) : {});

	function widget(shape: string, path: string[]): string {
		let node: unknown = isObj(forms[shape]) ? (forms[shape] as Json).default : undefined;
		for (const p of path) node = isObj(node) && isObj(node.properties) ? (node.properties as Json)[p] : undefined;
		return isObj(node) && typeof node.widget === "string" ? node.widget : "";
	}

	/** TakeShape's type defaults for a required property it has no value for (read from its source). */
	const TYPE_DEFAULTS: Record<string, unknown> = { string: "", boolean: false, integer: 0, number: 0 };
	const requiredOf = (schema: Json | undefined): Set<string> => new Set(Array.isArray(schema?.required) ? schema.required.map(String) : []);

	function property(shape: string, path: string[], p: Json, inside: string[], required = false): TSProperty {
		const name = path[path.length - 1] as string;
		const base = { name, multiple: false, targets: [] as string[], relatedName: null as string | null };
		if (p["@resolver"] && !p["@mapping"]) return { ...base, kind: "service" };
		const rel = relationshipOf(p);
		if (rel) {
			const ids = rel.shapeIds;
			return {
				...base,
				kind: ids.length && ids.every((id) => id === "ASSET") ? "asset" : "relationship",
				multiple: rel.type === "multiple",
				targets: ids.map((id) => nameById.get(id) ?? id),
				relatedName: rel.relatedName,
			};
		}
		if (p["@tag"] === "draftjs" || p["@draftjs"]) return { ...base, kind: "draftjs" };
		const items = isObj(p.items) ? p.items : undefined;
		const inline = refName(p) ?? (p.type === "array" ? refName(items) : null);
		if (inline && rawShapes[inline] && !inside.includes(inline)) {
			const properties: Record<string, TSProperty> = {};
			const req = requiredOf(schemaOf(inline));
			for (const [n, sub] of Object.entries(propsOf(schemaOf(inline)))) properties[n] = property(shape, [...path, n], sub, [...inside, inline], req.has(n));
			return { ...base, kind: p.type === "array" ? "array" : "object", multiple: p.type === "array", properties };
		}
		const markdown = /markdown|mdx/i.test(widget(shape, path)) || /^(mdx|markdown)$/i.test(String(p["@tag"] ?? ""));
		if ((p.type === "string" || p.type === undefined) && markdown) return { ...base, kind: "markdown" };
		const fallback = p.default !== undefined ? p.default : required && typeof p.type === "string" ? TYPE_DEFAULTS[p.type] : undefined;
		return { ...base, kind: "scalar", multiple: p.type === "array", ...(fallback !== undefined ? { default: fallback } : {}) };
	}

	const shapes = new Map<string, TSShape>();
	for (const [key, s] of Object.entries(rawShapes)) {
		const name = typeof s.name === "string" ? s.name : key;
		const type = isObj(s.model) ? s.model.type : undefined;
		const model = type === "single" || type === "multiple" || type === "taxonomy" ? type : null;
		const properties: Record<string, TSProperty> = {};
		const req = requiredOf(schemaOf(key));
		for (const [n, p] of Object.entries(propsOf(schemaOf(key)))) properties[n] = property(name, [n], p, [name], req.has(n));
		shapes.set(name, { name, id: typeof s.id === "string" ? s.id : name, model, properties, onlyEnabledFilters: onlyEnabledFilters(raw, name) });
	}

	// Content queries from the schema, plus the ones TakeShape generates for every model shape
	const queries = new Map<string, { shape: string; op: "get" | "list" | "single" }>();
	for (const [name, q] of Object.entries(isObj(raw.queries) ? (raw.queries as Record<string, Json>) : {})) {
		const resolver = isObj(q.resolver) ? q.resolver.name : undefined;
		if (typeof resolver !== "string" || !CONTENT_RESOLVERS.has(resolver) || typeof q.shape !== "string") continue;
		const list = q.shape.match(/^PaginatedList<(.+)>$/);
		if (list) queries.set(name, { shape: list[1] as string, op: "list" });
		else if (shapes.has(q.shape)) queries.set(name, { shape: q.shape, op: String(q.args).startsWith("TSGetSingletonArgs") || shapes.get(q.shape)?.model === "single" ? "single" : "get" });
	}
	for (const s of shapes.values()) {
		if (!s.model) continue;
		if (!queries.has(`get${s.name}`)) queries.set(`get${s.name}`, { shape: s.name, op: s.model === "single" ? "single" : "get" });
		if (s.model !== "single" && !queries.has(`get${s.name}List`)) queries.set(`get${s.name}List`, { shape: s.name, op: "list" });
	}

	// Reverse fields, found the way TakeShape's findExistingRelationships walks model shapes: into inline
	// objects and array items, each inline shape once, and later fields of one name replace earlier ones.
	const reverse = new Map<string, Map<string, ReverseField>>();
	// Every property of a shape that points at a target, named or not, its reverse on or off, for the unnamed fields below
	const pointing = new Map<string, Array<{ property: string; multiple: boolean }>>();
	// The reverse fields an unnamed relationship made, while no later definition of the name has replaced them
	const unnamed = new Set<ReverseField>();
	const seen = new Set<string>();
	function walk(model: TSShape, p: Json, path: string[]): void {
		const rel = relationshipOf(p);
		if (rel) {
			const here = { property: path.join("."), multiple: rel.type === "multiple" };
			const backref = isObj(p["@backreference"]) ? (p["@backreference"] as Json) : null;
			// Schemas before 3.13 had no @backreference; TakeShape's migration enables one for every relationship
			if (backref && !backref.enabled) return;
			for (const id of rel.shapeIds) {
				const target = nameById.get(id);
				if (!target) continue;
				const fields = reverse.get(target) ?? new Map<string, ReverseField>();
				const name = rel.relatedName ?? `${camelCase(model.name)}Set`;
				const existing = fields.get(name);
				if (!rel.relatedName && existing && unnamed.has(existing) && existing.shape === model.name) existing.others = [...(existing.others ?? []), here];
				else {
					// A later definition of the name replaces the earlier one, as in TakeShape's relationships.ts
					if (existing) unnamed.delete(existing);
					const field: ReverseField = { shape: model.name, ...here };
					fields.set(name, field);
					if (!rel.relatedName) unnamed.add(field);
				}
				reverse.set(target, fields);
			}
			return;
		}
		const inline = refName(p);
		if (inline) {
			if (!rawShapes[inline] || seen.has(inline)) return;
			seen.add(inline);
		}
		const node = inline ? schemaOf(inline) : p;
		if (isObj(node?.properties)) for (const [n, sub] of Object.entries(propsOf(node))) walk(model, sub, [...path, n]);
		else if (isObj(node?.items)) walk(model, node.items as Json, path);
	}
	for (const [key, s] of Object.entries(rawShapes)) {
		const model = shapes.get(typeof s.name === "string" ? s.name : key);
		if (model?.model) for (const [n, p] of Object.entries(propsOf(schemaOf(key)))) walk(model, p, [n]);
	}
	// _references holds every relationship's links (TakeShape's indexing adds them all): a field whose own reverse is
	// off, and each use of an inline shape, which the walk above visits once as TakeShape's naming did. A shape already
	// on the path stops the descent, so a shape that holds itself ends.
	function collect(model: TSShape, p: Json, path: string[], onPath: ReadonlySet<string>): void {
		const rel = relationshipOf(p);
		if (rel) {
			const here = { property: path.join("."), multiple: rel.type === "multiple" };
			for (const id of rel.shapeIds) {
				const target = nameById.get(id);
				if (!target) continue;
				const key = `${target}\u0000${model.name}`;
				pointing.set(key, [...(pointing.get(key) ?? []), here]);
			}
			return;
		}
		const inline = refName(p);
		if (inline && (!rawShapes[inline] || onPath.has(inline))) return;
		const node = inline ? schemaOf(inline) : p;
		const next = inline ? new Set([...onPath, inline]) : onPath;
		if (isObj(node?.properties)) for (const [n, sub] of Object.entries(propsOf(node))) collect(model, sub, [...path, n], next);
		else if (isObj(node?.items)) collect(model, node.items as Json, path, next);
	}
	for (const [key, s] of Object.entries(rawShapes)) {
		const model = shapes.get(typeof s.name === "string" ? s.name : key);
		if (model?.model) for (const [n, p] of Object.entries(propsOf(schemaOf(key)))) collect(model, p, [n], new Set());
	}
	// An unnamed field reads `_references`, every reference of the entry, so it also lists entries linked through a
	// field that has a name of its own (relationships.ts)
	for (const [target, fields] of reverse) {
		for (const field of fields.values()) {
			if (!unnamed.has(field)) continue;
			const others = (pointing.get(`${target}\u0000${field.shape}`) ?? []).filter((p) => p.property !== field.property);
			if (others.length) field.others = others;
		}
	}

	return { shapes, queries, reverse };
}
