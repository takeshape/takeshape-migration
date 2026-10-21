/**
 * Tokenizes the static HTML text between Nunjucks tags. A Nunjucks tag can sit anywhere, so a chunk may start or
 * end in the middle of an HTML tag, a quoted attribute value, a comment or a script. The lexer state is returned
 * with the tokens and passed into the next chunk, so the caller can thread it through a whole template and read
 * it at each Nunjucks segment to see where that segment sits.
 *
 * Tokens carry `start` and `end` offsets inside the chunk. Constructs that continue across chunks come back in
 * pieces: an unfinished start tag at the end of a chunk is `tag-partial`, the remainder of a tag a chunk starts
 * inside (up to and including its `>`) is `tag-rest`, and the parts of a comment, script or similar come back as
 * one token of that type per chunk. A script, style, textarea or title element is `open`, one `rawtext` token for
 * its contents (no tags inside), and `close`.
 *
 * Bogus comments follow browsers too: `<!` not starting a comment, CDATA or doctype, and `</` followed by anything but a
 * letter (`</ b>`, `</3>`, `</>`), run to the next `>` as one `bogus` token. A `</` or `<` at the very end of a chunk stays text,
 * since what follows it comes from a Nunjucks segment.
 *
 * Self-closing follows browsers. HTML void elements are self-closing by name. A trailing `/` on any other HTML
 * element is ignored. `/>` closes only foreign elements (inside `<svg>` or `<math>`). The slash must come right
 * before the `>`: `<a href=x/>` has the slash in its unquoted value, and `<circle r=1 / >` does not self-close.
 */
export type MarkupToken = { start: number; end: number } & (
	| { type: "open"; name: string; raw: string; selfClosing: boolean }
	| { type: "close"; name: string; raw: string }
	| { type: "tag-partial"; name: string; raw: string }
	| { type: "tag-rest"; raw: string }
	| { type: "text"; raw: string }
	| { type: "comment" | "doctype" | "pi" | "cdata" | "bogus"; raw: string }
	| { type: "rawtext"; name: RawTextName; raw: string }
);
export type RawTextName = "script" | "style" | "textarea" | "title";

/**
 * Lexer state carried from one chunk to the next.
 * - mode: what the lexer is inside. `tag` is a start or end tag after its name.
 * - element: lowercased name of the tag being read (mode `tag`) or of the raw-text element (mode `rawtext`).
 * - closing: the tag being read is an end tag.
 * - tagStart: absolute source offset of that tag's `<` (chunk offset plus the `base` argument).
 * - quote: the open attribute-value quote, if any.
 * - attr: where the lexer is in an attribute: `none` (between attributes), `name`, `before-value` (after `=`), `unquoted`.
 * - slash: the previous character was a `/` that may be part of `/>`.
 * - foreign: how many `<svg>` or `<math>` elements are open.
 */
export type LexState = {
	mode: "data" | "tag" | "rawtext" | "comment" | "doctype" | "pi" | "cdata" | "bogus";
	element: string | null;
	closing: boolean;
	tagStart: number | null;
	quote: '"' | "'" | null;
	attr: "none" | "name" | "before-value" | "unquoted";
	slash: boolean;
	foreign: number;
};

export function initialLexState(): LexState {
	return { mode: "data", element: null, closing: false, tagStart: null, quote: null, attr: "none", slash: false, foreign: 0 };
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set<string>(["script", "style", "textarea", "title"]);
const ENDS = { comment: "-->", doctype: ">", pi: "?>", cdata: "]]>", bogus: ">" } as const;
const WS = /\s/;

/** Reads tag text from `i`. Returns the index after the `>` and whether the tag finished, plus whether a `/` came right before it. */
function scanTag(chunk: string, i: number, s: LexState): { end: number; done: boolean; slashBefore: boolean } {
	for (let j = i; j < chunk.length; j++) {
		const c = chunk[j]!;
		if (s.quote) {
			if (c === s.quote) {
				s.quote = null;
				s.attr = "none";
			}
			continue;
		}
		const prevSlash = s.slash;
		s.slash = false;
		if (s.attr === "unquoted") {
			if (WS.test(c)) s.attr = "none";
			else if (c === ">") return { end: j + 1, done: true, slashBefore: false };
			continue;
		}
		if (s.attr === "before-value") {
			if (WS.test(c)) continue;
			if (c === '"' || c === "'") s.quote = c;
			else if (c === ">") return { end: j + 1, done: true, slashBefore: false };
			else s.attr = "unquoted";
			continue;
		}
		if (c === ">") return { end: j + 1, done: true, slashBefore: prevSlash };
		if (c === "=") s.attr = "before-value";
		else if (c === "/") {
			s.slash = true;
			s.attr = "none";
		} else if (WS.test(c)) s.attr = "none";
		else s.attr = "name";
	}
	return { end: chunk.length, done: false, slashBefore: false };
}

/** Applies a finished tag to the state. Returns whether an open tag is self-closing. */
function completeTag(s: LexState, slashBefore: boolean): boolean {
	const name = s.element ?? "";
	let selfClosing = false;
	const wasForeign = s.foreign > 0;
	if (s.closing) {
		if (name === "svg" || name === "math") s.foreign = Math.max(0, s.foreign - 1);
	} else {
		const foreignTag = wasForeign || name === "svg" || name === "math";
		selfClosing = foreignTag ? slashBefore : VOID.has(name);
		if (!selfClosing && (name === "svg" || name === "math")) s.foreign++;
	}
	const raw = !s.closing && !selfClosing && !wasForeign && RAW.has(name);
	s.mode = raw ? "rawtext" : "data";
	if (!raw) s.element = null;
	s.closing = false;
	s.tagStart = null;
	s.quote = null;
	s.attr = "none";
	s.slash = false;
	return selfClosing;
}

export function tokenizeMarkup(
	chunk: string,
	state: LexState = initialLexState(),
	base = 0,
): { tokens: MarkupToken[]; state: LexState; startsInsideTag: boolean; endsInsideTag: boolean } {
	const s: LexState = { ...state };
	const startsInsideTag = s.mode === "tag";
	const tokens: MarkupToken[] = [];
	const n = chunk.length;
	let i = 0;
	let textStart = -1;
	/** Start of the tag or construct being read, or null when it began in an earlier chunk. */
	let begin: number | null = null;
	const flushText = (end: number) => {
		if (textStart >= 0 && end > textStart) tokens.push({ type: "text", raw: chunk.slice(textStart, end), start: textStart, end });
		textStart = -1;
	};
	while (i < n) {
		if (s.mode === "tag") {
			const from = begin ?? i;
			const r = scanTag(chunk, i, s);
			const raw = chunk.slice(from, r.end);
			const name = s.element ?? "";
			if (!r.done) {
				tokens.push(begin === null ? { type: "tag-rest", raw, start: from, end: r.end } : { type: "tag-partial", name, raw, start: from, end: r.end });
			} else {
				const closing = s.closing;
				const selfClosing = completeTag(s, r.slashBefore);
				if (begin === null) tokens.push({ type: "tag-rest", raw, start: from, end: r.end });
				else if (closing) tokens.push({ type: "close", name, raw, start: from, end: r.end });
				else tokens.push({ type: "open", name, raw, selfClosing, start: from, end: r.end });
			}
			begin = null;
			i = r.end;
			continue;
		}
		if (s.mode === "rawtext") {
			const re = new RegExp(`</${s.element}(?=[\\s/>])`, "gi");
			re.lastIndex = i;
			const m = re.exec(chunk);
			const stop = m ? m.index : n;
			if (stop > i) tokens.push({ type: "rawtext", name: s.element as RawTextName, raw: chunk.slice(i, stop), start: i, end: stop });
			i = stop;
			if (m) {
				s.mode = "data";
				s.element = null;
			}
			continue;
		}
		if (s.mode !== "data") {
			const end = ENDS[s.mode];
			const at = chunk.indexOf(end, i);
			const stop = at === -1 ? n : at + end.length;
			const from = begin ?? i;
			tokens.push({ type: s.mode, raw: chunk.slice(from, stop), start: from, end: stop });
			begin = null;
			if (at !== -1) s.mode = "data";
			i = stop;
			continue;
		}
		const lt = chunk.indexOf("<", i);
		if (lt === -1) {
			if (textStart < 0) textStart = i;
			i = n;
			break;
		}
		if (textStart < 0 && lt > i) textStart = i;
		const construct = (mode: "comment" | "doctype" | "pi" | "cdata" | "bogus", prefix: number) => {
			flushText(lt);
			s.mode = mode;
			begin = lt;
			i = lt + prefix;
		};
		if (chunk.startsWith("<!--", lt)) {
			construct("comment", 4);
			continue;
		}
		if (chunk.startsWith("<![CDATA[", lt)) {
			construct("cdata", 9);
			continue;
		}
		if (chunk.slice(lt, lt + 9).toLowerCase() === "<!doctype") {
			construct("doctype", 2);
			continue;
		}
		if (chunk.startsWith("<?", lt)) {
			construct("pi", 2);
			continue;
		}
		if (chunk.startsWith("<!", lt) || (chunk.startsWith("</", lt) && lt + 2 < chunk.length && !/[A-Za-z]/.test(chunk[lt + 2]!))) {
			construct("bogus", 2);
			continue;
		}
		const m = /<(\/?)([A-Za-z][^\s/>]*)/y;
		m.lastIndex = lt;
		const found = m.exec(chunk);
		if (!found) {
			if (textStart < 0) textStart = lt;
			i = lt + 1;
			continue;
		}
		flushText(lt);
		s.mode = "tag";
		s.element = found[2]!.toLowerCase();
		s.closing = found[1] === "/";
		s.tagStart = base + lt;
		s.quote = null;
		s.attr = "none";
		s.slash = false;
		begin = lt;
		i = lt + found[0].length;
	}
	flushText(n);
	// The chunk ended right after an opener (`<h` before `{{ level }}`, or `<!--`): it still starts a construct.
	if (begin !== null && begin < n) {
		const raw = chunk.slice(begin, n);
		if (s.mode === "tag") tokens.push({ type: "tag-partial", name: s.element ?? "", raw, start: begin, end: n });
		else if (s.mode !== "data" && s.mode !== "rawtext") tokens.push({ type: s.mode, raw, start: begin, end: n });
	}
	return { tokens, state: s, startsInsideTag, endsInsideTag: s.mode === "tag" };
}
