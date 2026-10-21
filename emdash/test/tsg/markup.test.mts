import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenizeMarkup } from "../../tsg2astro/markup.mts";
import type { LexState, MarkupToken } from "../../tsg2astro/markup.mts";

const types = (s: string) => tokenizeMarkup(s).tokens.map((t) => t.type);
const selfClosing = (s: string) => tokenizeMarkup(s).tokens.filter((t): t is Extract<MarkupToken, { type: "open" }> => t.type === "open").map((t) => t.selfClosing);

/** Lexes the pieces in order, carrying state, as a template with Nunjucks segments between them. */
function chain(...chunks: string[]) {
	let state: LexState | undefined;
	return chunks.map((c) => {
		const r = tokenizeMarkup(c, state);
		state = r.state;
		return r;
	});
}

test("markup-xml-prolog", () => {
	assert.deepEqual(types('<?xml version="1.0"?><!DOCTYPE svg><svg>'), ["pi", "doctype", "open"]);
});

test("markup-script-is-rawtext", () => {
	const { tokens } = tokenizeMarkup("<script>if (a < b) {}</script>");
	assert.deepEqual(tokens.map((t) => t.type), ["open", "rawtext", "close"]);
	assert.equal(tokens.filter((t) => t.type === "rawtext").length, 1);
	const raw = tokens[1];
	assert.equal(raw?.type === "rawtext" && raw.raw, "if (a < b) {}");
});

test("markup-quoted-gt", () => {
	assert.deepEqual(types('<a title="x > y">'), ["open"]);
});

test("markup-offsets", () => {
	const src = 'hi <b class="x">there</b>';
	for (const t of tokenizeMarkup(src).tokens) assert.equal(src.slice(t.start, t.end), t.raw);
});

test("markup-partial-and-rest", () => {
	const [a, b] = chain('x <a href="', '/">go</a>');
	assert.equal(a!.endsInsideTag, true);
	assert.deepEqual(a!.tokens.map((t) => t.type), ["text", "tag-partial"]);
	assert.equal(a!.state.quote, '"');
	assert.equal(a!.state.element, "a");
	assert.equal(a!.state.tagStart, 2);
	assert.equal(b!.startsInsideTag, true);
	assert.deepEqual(b!.tokens.map((t) => t.type), ["tag-rest", "text", "close"]);
	assert.equal(b!.tokens[0]?.raw, '/">');
	assert.equal(b!.endsInsideTag, false);
});

test("markup-quoted-gt-across-chunks", () => {
	// <a title="{{ x }} > y" {% if w %}hidden{% endif %}> : the > inside the quotes does not end the tag.
	const r = chain('<a title="', '', '" ');
	assert.equal(r[2]!.endsInsideTag, true);
	const q = chain('<a title="', ' > y" ');
	assert.equal(q[1]!.endsInsideTag, true);
	assert.equal(q[1]!.state.quote, null);
});

test("markup-script-split-by-tag", () => {
	const r = chain("<script>var a = 1; if (x ", " < y) {}</script><p>");
	assert.equal(r[0]!.endsInsideTag, false);
	assert.equal(r[0]!.state.mode, "rawtext");
	assert.equal(r[1]!.state.mode, "data");
	assert.deepEqual(r[1]!.tokens.map((t) => t.type), ["rawtext", "close", "open"]);
});

test("markup-comment-spans-segment", () => {
	const r = chain("<!-- a ", " b --><i>");
	assert.equal(r[0]!.state.mode, "comment");
	assert.deepEqual(r[0]!.tokens.map((t) => t.type), ["comment"]);
	assert.deepEqual(r[1]!.tokens.map((t) => t.type), ["comment", "open"]);
	assert.equal(r[1]!.state.mode, "data");
});

test("markup-self-closing", () => {
	assert.deepEqual(selfClosing("<br><img src=x><p/>"), [true, true, false]);
	assert.deepEqual(selfClosing("<svg><circle r='1'/><g></g></svg>"), [false, true, false]);
	assert.deepEqual(selfClosing("<svg/>"), [true]);
	assert.deepEqual(selfClosing("<svg><circle r=1 / ></svg>"), [false, false]);
	assert.deepEqual(selfClosing("<svg><circle r=1/></svg>"), [false, false]);
	assert.deepEqual(selfClosing("<a href=x/>"), [false]);
});

test("markup-foreign-closes", () => {
	const r = tokenizeMarkup("<svg><path/></svg><p/>");
	assert.equal(r.state.foreign, 0);
	assert.deepEqual(r.tokens.filter((t) => t.type === "open").map((t) => t.type === "open" && t.selfClosing), [false, true, false]);
});

test("markup-rcdata-and-cdata", () => {
	assert.deepEqual(types("<textarea><b>x</b></textarea>"), ["open", "rawtext", "close"]);
	assert.deepEqual(types("<title>a <i> b</title>"), ["open", "rawtext", "close"]);
	assert.deepEqual(types("<svg><![CDATA[ a < b ]]></svg>"), ["open", "cdata", "close"]);
});

test("markup-script-in-tag-rest", () => {
	// <script {% if x %}async{% endif %}> : the tag finishes in a later chunk and the lexer enters the script.
	const r = chain("<script ", "async", ">if (a < b) {}</script>");
	assert.equal(r[2]!.tokens[0]?.type, "tag-rest");
	assert.deepEqual(r[2]!.tokens.map((t) => t.type), ["tag-rest", "rawtext", "close"]);
});

test("markup-opener-at-chunk-end", () => {
	// `<h{{ level }}>`: the chunk ends right after the tag name, so the partial tag must still come back
	const [a, b] = chain("\n<h", ' class="x">Level ');
	assert.deepEqual(a!.tokens.map((t) => [t.type, t.raw]), [["text", "\n"], ["tag-partial", "<h"]]);
	assert.deepEqual(b!.tokens.map((t) => t.type), ["tag-rest", "text"]);
	// `<p><!--{{ x }}--><b>`
	const [c, d] = chain("<p><!--", "--><b>");
	assert.deepEqual(c!.tokens.map((t) => [t.type, t.raw]), [["open", "<p>"], ["comment", "<!--"]]);
	assert.deepEqual(d!.tokens.map((t) => [t.type, t.raw]), [["comment", "-->"], ["open", "<b>"]]);
});

test("markup-bogus-comments", () => {
	const t = (s: string) => tokenizeMarkup(s).tokens.map((x) => [x.type, x.raw]);
	assert.deepEqual(t("a </ b> c"), [["text", "a "], ["bogus", "</ b>"], ["text", " c"]]);
	assert.deepEqual(t("x </3> y</>z<!x bogus>"), [["text", "x "], ["bogus", "</3>"], ["text", " y"], ["bogus", "</>"], ["text", "z"], ["bogus", "<!x bogus>"]]);
	// what follows a trailing `</` or `<` comes from a Nunjucks segment
	assert.deepEqual(t("a</"), [["text", "a</"]]);
	assert.deepEqual(t("<p>if a<"), [["open", "<p>"], ["text", "if a<"]]);
});
