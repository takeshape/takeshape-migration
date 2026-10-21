import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixedClock = fileURLToPath(new URL("./fixed-clock.mts", import.meta.url));

test("fixed-clock pins now", () => {
	const out = execFileSync(process.execPath, ["--import", fixedClock, "-e", "console.log(new Date().toISOString(), Date.now(), new Date(0).toISOString())"],
		{ env: { ...process.env, TSG_FIXED_NOW: "2026-10-15T16:00:00.000Z" }, encoding: "utf8" });
	assert.equal(out.trim(), "2026-10-15T16:00:00.000Z 1792080000000 1970-01-01T00:00:00.000Z");
});

test("fixed-clock makes a bare Date() call return the fixed time", () => {
	const out = execFileSync(process.execPath, ["--import", fixedClock, "-e", "console.log(Date() === new Date().toString(), new Date() instanceof Date)"],
		{ env: { ...process.env, TSG_FIXED_NOW: "2026-10-15T16:00:00.000Z" }, encoding: "utf8" });
	assert.equal(out.trim(), "true true");
});
