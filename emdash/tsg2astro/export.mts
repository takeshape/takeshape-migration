/** Finds and reads schema.json and data.jsonl in a TakeShape export folder or ZIP (same rules as ts2emdash.mts). */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

async function findFile(dir: string, name: string, depth = 3): Promise<string | null> {
	const direct = join(dir, name);
	if (existsSync(direct)) return direct;
	if (depth === 0) return null;
	for (const entry of await readdir(dir)) {
		const p = join(dir, entry);
		if ((await stat(p)).isDirectory()) {
			const hit = await findFile(p, name, depth - 1);
			if (hit) return hit;
		}
	}
	return null;
}

export async function readExport(pathOrZip: string): Promise<{ dir: string; schema: unknown; rows: Array<Record<string, unknown>> }> {
	let root = resolve(pathOrZip);
	if (!existsSync(root)) throw new Error(`${root} does not exist.`);
	if (/\.zip$/i.test(root)) {
		// Unzip next to the archive with whatever the OS provides (unzip, or tar on macOS and Windows)
		const { execFileSync } = await import("node:child_process");
		const target = root.replace(/\.zip$/i, "");
		await mkdir(target, { recursive: true });
		try {
			execFileSync("unzip", ["-oq", root, "-d", target], { stdio: "ignore" });
		} catch {
			try {
				execFileSync("tar", ["-xf", root, "-C", target], { stdio: "ignore" });
			} catch {
				throw new Error(`Could not unzip ${root}. Unzip it yourself and pass the folder instead.`);
			}
		}
		root = target;
	}
	const schemaPath = await findFile(root, "schema.json");
	const dataPath = await findFile(root, "data.jsonl");
	if (!schemaPath) throw new Error(`No schema.json found under ${root}. Unzip the TakeShape export first.`);
	if (!dataPath) throw new Error(`No data.jsonl found under ${root}. Export the project with its data (not an empty export).`);
	const schema: unknown = JSON.parse(await readFile(schemaPath, "utf8"));
	const rows: Array<Record<string, unknown>> = [];
	for (const l of (await readFile(dataPath, "utf8")).split("\n")) {
		if (!l.trim()) continue;
		try {
			rows.push(JSON.parse(l));
		} catch {
			// ts2emdash reports unreadable lines; here they are skipped
		}
	}
	return { dir: root, schema, rows };
}
