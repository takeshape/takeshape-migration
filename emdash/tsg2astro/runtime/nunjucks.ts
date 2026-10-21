/*
Ported from Nunjucks 3.2.0 (github.com/mozilla/nunjucks): the stock filters and their helpers from src/filters.js,
copySafeness from src/runtime.js, the `in` operator from src/lib.js and joiner from src/globals.js. Its license:

Copyright (c) 2012-2015, James Long
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

    Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
/**
 * Nunjucks 3.2.0 behavior for generated Astro components. This file is copied into customer projects and also runs
 * in a Cloudflare Worker: erasable TypeScript, no imports from outside tsg2astro/runtime/, no eval or new Function.
 *
 * Safe strings: Nunjucks marks some values as safe (SafeString) so autoescape skips them. Astro escapes every
 * `{expression}` itself, so the runtime has no SafeString. Instead:
 *   - the emitter turns an outermost `| safe` into `set:html` and an outermost `| escape` into plain text, so
 *     those two never reach this file as markers;
 *   - `escape` returns the escaped string, and the stock filters port Nunjucks's `copySafeness`, which keeps a
 *     macro's output (below) safe through `title`, `trim`, `striptags` and `replace`.
 * One difference remains: in Nunjucks a `| safe` or `| escape` value that is not outermost (for example
 * `x | safe | trim`) stays a SafeString through some filters, so it is not escaped again at output. Here it is.
 * The emitter reports those cases as not-translated.
 *
 * Macros are the one place a safe value travels: a macro returns its output as SafeHtml, which `escape` passes
 * through as Nunjucks passed a macro's SafeString, and the emitter prints a macro call in markup with `set:html`.
 *
 * Calls on undefined: `a.b.slice(...)` with `a.b` missing, or `f(1)` with `f` undefined, print "" here where
 * Nunjucks throws. That is acceptable: takeshape-ssg aborted the build on a throwing template, so a deployed
 * site never contained one.
 */
import { decodeHTMLAttribute } from "entities";

const ESCAPES: Record<string, string> = { "&": "&amp;", '"': "&quot;", "'": "&#39;", "<": "&lt;", ">": "&gt;" };

/** What `{{ value }}` prints before escaping: null and undefined print "", everything else is toString(). */
export function text(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

/**
 * A macro's output: HTML that `escape` prints as it is, as Nunjucks printed a macro's SafeString. Like SafeString it is
 * a String, so string filters (upper, trim, split) work on it.
 */
export class SafeHtml extends String {
	readonly html: string;
	constructor(html: string) {
		super(html);
		this.html = html;
	}
}

/** Nunjucks's copySafeness: a filter's result stays safe when its input was. */
function copySafeness(input: unknown, result: unknown): unknown {
	return input instanceof SafeHtml && typeof result === "string" ? new SafeHtml(result) : result;
}

export function markSafe(html: string): SafeHtml {
	return new SafeHtml(html);
}

/** Nunjucks's `escape` (lib.escape on the output of toString). A macro's output passes through. */
export function escape(value: unknown): string {
	if (value instanceof SafeHtml) return value.html;
	return text(value).replace(/[&"'<>]/g, (ch) => ESCAPES[ch] as string);
}

/**
 * HTML text as a browser reads it in an attribute, every entity decoded (&copy; included) by the attribute rules. A
 * block's text goes to a layout as Nunjucks printed it, escaped; a native Astro attribute escapes & and " in what it
 * gets, so it takes the text decoded.
 */
export function unescapeHtml(value: string | undefined): string | undefined {
	return value === undefined ? undefined : decodeHTMLAttribute(value);
}

/** Nunjucks's global `joiner(sep = ",")`: a function that returns "" the first time and `sep` after. */
export function joiner(sep: unknown = ","): () => unknown {
	let first = true;
	return () => {
		const out = first ? "" : sep;
		first = false;
		return out;
	};
}

const isArray = Array.isArray;
const isString = (v: unknown): v is string => Object.prototype.toString.call(v) === "[object String]";
const isObject = (v: unknown): v is Record<string, unknown> => Object.prototype.toString.call(v) === "[object Object]";

/** One item of a one-name loop. `any`: loop variables hold template data, which templates read without types. */
type LoopItem = { key: string | null; value: any };

/**
 * A one-name loop's items, plus `len`: the `arr.length` Nunjucks read, which its `loop` variable and its else test use.
 * `map` and `forEach` hand the items themselves to their callback as its third argument, and say so here, since the
 * emitted callbacks read `len` from there (`nj.loop(i, all.len)`) and Array's own types call it a plain array.
 */
export interface LoopItems extends Array<LoopItem> {
	readonly len: unknown;
	map<U>(callbackfn: (value: LoopItem, index: number, array: LoopItems) => U, thisArg?: unknown): U[];
	forEach(callbackfn: (value: LoopItem, index: number, array: LoopItems) => void, thisArg?: unknown): void;
}

/**
 * The items of a one-name `{% for %}`, as Nunjucks 3.2.0's compiled loop takes them (compileFor). It skips a falsy
 * value; runtime.fromIterator turns Maps and Sets into arrays of their entries or values; then the loop runs while
 * `i < arr.length` and reads `arr[i]`. So `<` coerces the length (a length of "2" gives two items, true one, 1.5 two),
 * strings go by UTF-16 unit, and a plain object gives none (a loop over a single reference, say). The else runs
 * when that length is falsy, so a length of "abc" runs neither the body nor the else.
 */
export function iterate(value: unknown): LoopItems {
	const items: LoopItem[] = [];
	let len: unknown;
	if (value) {
		const arr: any = typeof value === "object" && !isArray(value) && Symbol.iterator in value ? Array.from(value as Iterable<unknown>) : value;
		len = arr.length;
		for (let i = 0; i < arr.length; i++) items.push({ key: null, value: arr[i] });
	}
	return Object.defineProperty(items, "len", { value: len }) as LoopItems;
}

/** The `loop` variable for the item at zero-based position `index0`, from the length Nunjucks read (`len`), as given. */
export function loop(index0: number, length: unknown) {
	// _emitLoopBindings computes these from len, so `-` coerces it there too
	const len = length as number;
	return {
		index: index0 + 1,
		index0,
		revindex: len - index0,
		revindex0: len - index0 - 1,
		first: index0 === 0,
		last: index0 === len - 1,
		length,
	};
}

/** Nunjucks's `in` operator (lib.inOperator), including its error for other types. */
export function inOp(needle: unknown, haystack: unknown): boolean {
	if (isArray(haystack) || isString(haystack)) return (haystack as string).indexOf(needle as string) !== -1;
	if (isObject(haystack)) return (needle as string) in haystack;
	throw new Error(`Cannot use "in" operator to search for "${String(needle)}" in unexpected types.`);
}

/** Nunjucks's `//`. */
export function floorDiv(a: number, b: number): number {
	return Math.floor(a / b);
}

function normalize(value: any, defaultValue: any): any {
	return value === null || value === undefined || value === false ? defaultValue : value;
}

function capitalize(str: any): string {
	const s: string = normalize(str, "");
	const ret = s.toLowerCase();
	return ret.charAt(0).toUpperCase() + ret.slice(1);
}

function trim(str: any): string {
	return str.replace(/^\s*|\s*$/g, "");
}

function replace(str: any, old: any, new_: any, maxCount?: number): any {
	const originalStr = str;
	if (old instanceof RegExp) return str.replace(old, new_);
	if (typeof maxCount === "undefined") maxCount = -1;
	let res = "";
	if (typeof old === "number") old = `${old}`;
	else if (typeof old !== "string") return str;
	if (typeof str === "number") str = `${str}`;
	// A macro's output (SafeString in Nunjucks) is replaced in too, and stays safe
	if (typeof str !== "string" && !(str instanceof SafeHtml)) return str;
	if (old === "") {
		res = new_ + str.split("").join(new_) + new_;
		return copySafeness(str, res);
	}
	let nextIndex = str.indexOf(old);
	if (maxCount === 0 || nextIndex === -1) return str;
	let pos = 0;
	let count = 0;
	while (nextIndex > -1 && (maxCount === -1 || count < maxCount)) {
		res += str.substring(pos, nextIndex) + new_;
		pos = nextIndex + old.length;
		count++;
		nextIndex = str.indexOf(old, pos);
	}
	if (pos < str.length) res += str.substring(pos);
	return copySafeness(originalStr, res);
}

/**
 * The stock filters the translator emits, ported from nunjucks 3.2.0 src/filters.js. Arguments are positional,
 * so the emitter turns `sort(attribute="x")` into `sort(arr, undefined, undefined, "x")`.
 */
export const filters: Record<
	"length" | "lower" | "upper" | "title" | "sort" | "striptags" | "replace" | "dump" | "urlencode" | "default" | "join" | "first" | "last" | "trim" | "escape",
	(...args: any[]) => unknown
> = {
	length(val: any) {
		const value = normalize(val, "");
		if (value !== undefined) {
			if ((typeof Map === "function" && value instanceof Map) || (typeof Set === "function" && value instanceof Set)) return value.size;
			if (isObject(value)) return Object.keys(value).length;
			return value.length;
		}
		return 0;
	},
	lower(str: any) {
		return normalize(str, "").toLowerCase();
	},
	upper(str: any) {
		return normalize(str, "").toUpperCase();
	},
	title(str: any) {
		const s: string = normalize(str, "");
		return copySafeness(
			str,
			s
				.split(" ")
				.map((word) => capitalize(word))
				.join(" "),
		);
	},
	sort(arr: any, reversed?: boolean, caseSens?: boolean, attr?: string) {
		const array = arr == null ? [] : Array.from(arr as ArrayLike<unknown>);
		array.sort((a: any, b: any) => {
			let x = attr ? a[attr] : a;
			let y = attr ? b[attr] : b;
			if (!caseSens && isString(x) && isString(y)) {
				x = x.toLowerCase();
				y = y.toLowerCase();
			}
			if (x < y) return reversed ? 1 : -1;
			if (x > y) return reversed ? -1 : 1;
			return 0;
		});
		return array;
	},
	striptags(input: any, preserveLinebreaks?: boolean) {
		input = normalize(input, "");
		const tags = /<\/?([a-z][a-z0-9]*)\b[^>]*>|<!--[\s\S]*?-->/gi;
		const trimmedInput = trim(input.replace(tags, ""));
		const original = input;
		if (preserveLinebreaks) {
			return copySafeness(
				original,
				trimmedInput
					.replace(/^ +| +$/gm, "")
					.replace(/ +/g, " ")
					.replace(/(\r\n)/g, "\n")
					.replace(/\n\n\n+/g, "\n\n"),
			);
		}
		return copySafeness(original, trimmedInput.replace(/\s+/gi, " "));
	},
	replace,
	dump(obj: unknown, spaces?: string | number) {
		return JSON.stringify(obj, null, spaces);
	},
	urlencode(obj: any) {
		const enc = encodeURIComponent;
		if (isString(obj)) return enc(obj);
		const keyvals: Array<[string, string]> = isArray(obj) ? (obj as Array<[string, string]>) : Object.entries(obj);
		return keyvals.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
	},
	default(val: unknown, def: unknown, bool?: boolean) {
		return bool ? val || def : val !== undefined ? val : def;
	},
	join(arr: any, del?: string, attr?: string) {
		del = del || "";
		if (attr) arr = arr == null ? [] : arr.map((v: any) => v[attr]);
		return arr.join(del);
	},
	first(arr: any) {
		return arr[0];
	},
	last(arr: any) {
		return arr[arr.length - 1];
	},
	trim(str: any) {
		return copySafeness(str, trim(str));
	},
	escape,
};
