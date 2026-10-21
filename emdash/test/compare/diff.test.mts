import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines } from "../../compare/diff.mts";

// 6,000 lines on each side changed is 36 million cells, past the table's limit, so these take the large-input path.
const alternating = (n: number, first: string, second: string) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? first : second));

test("small inputs: a moved line shows as removed and added", () => {
	assert.deepEqual(diffLines(["a", "b", "c"], ["b", "a", "c"]), ["- a", "+ a"]);
});

test("small inputs: identical pages give no diff", () => {
	assert.deepEqual(diffLines(["a", "b"], ["a", "b"]), []);
});

test("large inputs: the same lines in another order still differ", () => {
	const old = alternating(6000, "First", "Second");
	const now = alternating(6000, "Second", "First");
	const d = diffLines(old, now);
	assert.ok(d.length > 0, "a reordered page must not compare equal");
	assert.equal(d[0], "- First");
	assert.equal(d[1], "+ Second");
});

test("large inputs: 6,000 distinct lines reversed still differ", () => {
	const old = Array.from({ length: 6000 }, (_, i) => `Line ${i}`);
	const d = diffLines(old, [...old].reverse());
	assert.deepEqual(d.slice(0, 2), ["- Line 0", "+ Line 5999"]);
	assert.match(d[2]!, /^\.\.\. lines 1 to 6000 hold the same lines in another order/);
});

test("large inputs: a line repeated a different number of times differs", () => {
	const old = alternating(6000, "First", "Second");
	const now = [...old];
	// Both ends change, so the whole page is one changed region; overall, one First became a Second.
	now[0] = "Second";
	now[5999] = "First";
	now[3000] = "Second";
	const d = diffLines(old, now);
	assert.deepEqual(d, ["- First", "+ Second"]);
});

test("large inputs: lines only one side has are listed in file order", () => {
	const old = alternating(6000, "First", "Second");
	const now = alternating(6000, "First", "Second");
	old[10] = "Only old";
	now[5990] = "Only new";
	assert.deepEqual(diffLines(old, now), ["- Only old", "+ Only new"]);
});

test("large inputs: identical pages give no diff", () => {
	assert.deepEqual(diffLines(alternating(6000, "First", "Second"), alternating(6000, "First", "Second")), []);
});
