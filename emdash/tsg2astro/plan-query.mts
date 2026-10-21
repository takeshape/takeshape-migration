#!/usr/bin/env node
/**
 * plan-query: the loader tsg2astro would write for one GraphQL query, for a site's browser code. A query a page's
 * script sent to TakeShape's API never appears in tsg.yml, so tsg2astro writes no loader for it; this plans it the
 * same way, against the export's schema and the field map.
 *
 *   node tsg2astro/plan-query.mts <query.graphql> --export <zip|dir> --field-map <file> [--out <file>]
 *
 * Write the query with the values the browser sent where it held variables (`_id: "x"`, `from: 0`, `size: 12`, the
 * filter itself): the planner carries over literal arguments and leaves out clauses that hold a variable. Then put
 * the request's values back in the loader where those literals landed. The loader is written for
 * src/loaders/browser/<name>.ts in the project (its imports start ../../lib/takeshape/), to --out or to stdout. What
 * the planner left out (a `should`, a must_not on _id, terms) goes to stderr, one line each. Exit 0 with a loader,
 * 1 when the query doesn't parse, 2 for a usage error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { FieldMap } from "../ts2emdash.mts";
import { emitLoader } from "./emit-loader.mts";
import { readExport } from "./export.mts";
import { planQuery } from "./queries.mts";
import { Report } from "./report.mts";
import { loadTakeShapeSchema } from "./schema.mts";

const USAGE = "Usage: node tsg2astro/plan-query.mts <query.graphql> --export <zip|dir> --field-map <file> [--out <file>]";

function usage(message: string): never {
	console.error(`plan-query: ${message}\n${USAGE}`);
	process.exit(2);
}

const args = process.argv.slice(2);
const opts: { query: string | null; export: string | null; fieldMap: string | null; out: string | null } = { query: null, export: null, fieldMap: null, out: null };
for (let i = 0; i < args.length; i++) {
	const a = args[i]!;
	const value = () => args[++i] ?? usage(`${a} needs a value.`);
	if (a === "--export") opts.export = value();
	else if (a === "--field-map") opts.fieldMap = value();
	else if (a === "--out") opts.out = value();
	else if (a.startsWith("--")) usage(`Unknown option ${a}.`);
	else if (opts.query === null) opts.query = a;
	else usage(`Only one query file, not also ${a}.`);
}
if (!opts.query || !opts.export || !opts.fieldMap) usage("Pass a query file, --export and --field-map.");

let source: string;
let fieldMap: FieldMap;
let schemaJson: unknown;
try {
	source = readFileSync(resolve(opts.query), "utf8");
	fieldMap = JSON.parse(readFileSync(resolve(opts.fieldMap), "utf8")) as FieldMap;
	schemaJson = (await readExport(opts.export)).schema;
} catch (e) {
	usage((e as Error).message);
}
if (fieldMap?.version !== 1 || typeof fieldMap.shapes !== "object") usage(`${opts.fieldMap} is not a field map from ts2emdash.mts (version 1).`);

const report = new Report();
const name = basename(opts.query).replace(/\.(graphql|gql)$/, "");
const plan = planQuery(`browser/${name}.graphql`, source, loadTakeShapeSchema(schemaJson), fieldMap, report);
for (const item of report.items()) console.error(`${item.construct ? `${item.construct}: ` : ""}${item.message}`);
if (!plan.fields.length) process.exit(1);
const loader = emitLoader(plan).source;
if (opts.out) writeFileSync(resolve(opts.out), loader);
else process.stdout.write(loader);
