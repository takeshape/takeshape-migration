/**
 * Which entries a TakeShape list query returns by status: published only, drafts only, both, or none. The
 * loader planner (queries.mts) and the site slugs (site-slugs.mts) both decide it here, so a draft gets a URL
 * slug exactly when its loader lists it.
 *
 * TakeShape's rule (CLAUDE.md, "TakeShape API behavior"): a list with neither `where` nor `filter` applies
 * `onlyEnabled`, default true, which keeps published entries when the shape has a workflow (always from
 * apiVersion 2 on, see `onlyEnabledFilters`) and filters nothing otherwise. A `where` or a `filter` drops that
 * default, and then only their own `_enabled` and `_status` clauses limit the status; both apply when both are given.
 */
import type { FieldNode } from "graphql";
import { load } from "./load.mts";

export type ListStatus = "published" | "drafts" | "all" | "none";
/** `guessed` is set when a status clause could not be read exactly (inside OR, NOT or should, or a workflow step this module does not know); the status then counts every entry the clause could allow. */
export type ListStatusResult = { status: ListStatus; guessed: boolean };

type Status = "published" | "draft";
type Found = { set: Set<Status>; guessed: boolean };

const { valueFromASTUntyped } = await load<typeof import("graphql")>("graphql");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const BOTH = (): Set<Status> => new Set(["published", "draft"]);
// TakeShape's default workflow, as its source defines it: steps match by name or key
const LIVE_STEPS = new Set(["enabled", "rkhRGs4WL"]);
const DRAFT_STEPS = new Set(["disabled", "r1uCfi4ZL"]);

const intersect = (a: Set<Status>, b: Set<Status>): Set<Status> => new Set([...a].filter((s) => b.has(s)));
const union = (a: Set<Status>, b: Set<Status>): Set<Status> => new Set([...a, ...b]);
const complement = (a: Set<Status>): Set<Status> => new Set([...BOTH()].filter((s) => !a.has(s)));

/** The statuses one `_enabled` or `_status` value allows. */
function valueStatuses(field: "_enabled" | "_status", value: unknown): Found {
	if (field === "_enabled") {
		if (value === true) return { set: new Set(["published"]), guessed: false };
		if (value === false) return { set: new Set(["draft"]), guessed: false };
		return { set: BOTH(), guessed: true };
	}
	if (typeof value === "string" && LIVE_STEPS.has(value)) return { set: new Set(["published"]), guessed: false };
	if (typeof value === "string" && DRAFT_STEPS.has(value)) return { set: new Set(["draft"]), guessed: false };
	return { set: BOTH(), guessed: true };
}

/** A clause that names `_enabled` or `_status` anywhere, which this module reads only in known places. */
function mentionsStatus(v: unknown): boolean {
	if (Array.isArray(v)) return v.some(mentionsStatus);
	if (!isObj(v)) return false;
	return Object.entries(v).some(([k, x]) => k === "_enabled" || k === "_status" || mentionsStatus(x));
}

/** TakeShape's `where`: `_enabled` and `_status` with eq or in, combined by AND. */
function whereStatuses(where: Record<string, unknown>): Found {
	let set = BOTH();
	let guessed = false;
	for (const [key, cond] of Object.entries(where)) {
		if (key === "AND" && Array.isArray(cond)) {
			for (const item of cond) {
				if (!isObj(item)) continue;
				const inner = whereStatuses(item);
				set = intersect(set, inner.set);
				guessed ||= inner.guessed;
			}
		} else if ((key === "_enabled" || key === "_status") && isObj(cond) && Object.keys(cond).length === 1 && ("eq" in cond || "in" in cond)) {
			const values = "eq" in cond ? [cond.eq] : Array.isArray(cond.in) ? cond.in : [cond.in];
			let allowed = new Set<Status>();
			for (const v of values) {
				const one = valueStatuses(key, v);
				allowed = union(allowed, one.set);
				guessed ||= one.guessed;
			}
			set = intersect(set, allowed);
		} else if (mentionsStatus({ [key]: cond })) guessed = true;
	}
	return { set, guessed };
}

/** An Elasticsearch-style `filter`: term, match and terms on `_enabled` or `_status`, inside bool must, filter and must_not. */
function filterStatuses(filter: unknown): Found {
	if (Array.isArray(filter)) {
		let set = BOTH();
		let guessed = false;
		for (const item of filter) {
			const inner = filterStatuses(item);
			set = intersect(set, inner.set);
			guessed ||= inner.guessed;
		}
		return { set, guessed };
	}
	if (!isObj(filter)) return { set: BOTH(), guessed: false };
	let set = BOTH();
	let guessed = false;
	for (const [key, body] of Object.entries(filter)) {
		if (key === "bool" && isObj(body)) {
			for (const [part, clauses] of Object.entries(body)) {
				if (part === "must" || part === "filter") {
					const inner = filterStatuses(clauses);
					set = intersect(set, inner.set);
					guessed ||= inner.guessed;
				} else if (part === "must_not") {
					// None of the clauses may match: each one's statuses are excluded, when it limits status at all
					for (const clause of Array.isArray(clauses) ? clauses : [clauses]) {
						const inner = filterStatuses(clause);
						if (inner.set.size === 1) set = intersect(set, complement(inner.set));
						guessed ||= inner.guessed;
					}
				} else if (mentionsStatus(clauses)) guessed = true;
			}
		} else if ((key === "term" || key === "match" || key === "terms") && isObj(body) && Object.keys(body).length === 1) {
			const [field, raw] = Object.entries(body)[0]!;
			if (field !== "_enabled" && field !== "_status") continue;
			const value = isObj(raw) && "query" in raw ? raw.query : isObj(raw) && "value" in raw ? raw.value : raw;
			let allowed = new Set<Status>();
			for (const v of key === "terms" && Array.isArray(value) ? value : [value]) {
				const one = valueStatuses(field, v);
				allowed = union(allowed, one.set);
				guessed ||= one.guessed;
			}
			set = intersect(set, allowed);
		} else if (mentionsStatus(body)) guessed = true;
	}
	return { set, guessed };
}

/**
 * Whether `onlyEnabled` keeps only the published entries of a shape, from schema.json. TakeShape filters a list
 * on the live steps of the shape's workflow (`shape.workflow`, else `default`) and on nothing when that workflow
 * does not exist or has no live step. The `default` workflow is added from apiVersion 2.0.0 on, so in an
 * apiVersion 1 project without workflows of its own a list returns every entry (both read from TakeShape's source).
 */
export function onlyEnabledFilters(schema: unknown, shapeName: string): boolean {
	const raw = isObj(schema) ? schema : {};
	const shape = isObj(raw.shapes) ? raw.shapes[shapeName] : undefined;
	const name = isObj(shape) && typeof shape.workflow === "string" ? shape.workflow : "default";
	// semver.coerce reads the first number; a schema without one is treated as the current version
	const major = Number(/\d+/.exec(String(raw.apiVersion ?? ""))?.[0] ?? 2);
	if (name === "default" && major >= 2) return true;
	const workflow = isObj(raw.workflows) ? raw.workflows[name] : undefined;
	return isObj(workflow) && Array.isArray(workflow.steps) && workflow.steps.some((step) => isObj(step) && step.live === true);
}

/**
 * From a list field's `where`, `filter` and `onlyEnabled` as JSON, variables filled in (an unset one is undefined).
 * `onlyEnabledFilters` says whether the listed shape has a workflow (see the function of that name).
 */
export function listStatus(args: { where?: unknown; filter?: unknown; onlyEnabled?: unknown }, { onlyEnabledFilters = true }: { onlyEnabledFilters?: boolean } = {}): ListStatusResult {
	const where = args.where ?? null;
	const filter = args.filter ?? null;
	if (where === null && filter === null) return { status: args.onlyEnabled === false || !onlyEnabledFilters ? "all" : "published", guessed: false };
	let set = BOTH();
	let guessed = false;
	for (const found of [isObj(where) ? whereStatuses(where) : null, filter !== null ? filterStatuses(filter) : null]) {
		if (!found) continue;
		set = intersect(set, found.set);
		guessed ||= found.guessed;
	}
	const status: ListStatus = set.size === 2 ? "all" : set.has("published") ? "published" : set.has("draft") ? "drafts" : "none";
	return { status, guessed };
}

/** A list field's `where`, `filter` and `onlyEnabled` from its GraphQL arguments, with `variables` filled in. */
export function statusArgs(field: FieldNode, variables: Record<string, unknown> = {}): { where?: unknown; filter?: unknown; onlyEnabled?: unknown } {
	const out: { where?: unknown; filter?: unknown; onlyEnabled?: unknown } = {};
	for (const arg of field.arguments ?? []) {
		const name = arg.name.value;
		if (name === "where" || name === "filter" || name === "onlyEnabled") out[name] = valueFromASTUntyped(arg.value, variables);
	}
	return out;
}
