// A small line diff: shows what changed ("- old line", "+ new line"), in file order.
const MAX_CELLS = 25_000_000;
const MAX_LINES = 200;

export function diffLines(a: string[], b: string[]): string[] {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const x = a.slice(start, endA);
	const y = b.slice(start, endB);
	const out: string[] = [];
	if (x.length * y.length > MAX_CELLS) {
		// Too big for the table: show the lines one side has more often than the other, in file order. If both
		// hold the same lines the same number of times, the order changed: show where the region starts to differ.
		// The region is never equal on both sides (the loops above trimmed everything that matched), so this
		// always returns at least one line.
		const surplus = (from: string[], other: string[], sign: string) => {
			const left = new Map<string, number>();
			for (const l of other) left.set(l, (left.get(l) ?? 0) + 1);
			for (const l of from) {
				const n = left.get(l) ?? 0;
				if (n > 0) left.set(l, n - 1);
				else out.push(`${sign} ${l}`);
			}
		};
		surplus(x, y, "-");
		surplus(y, x, "+");
		if (out.length === 0) {
			out.push(`- ${x[0]}`, `+ ${y[0]}`, `... lines ${start + 1} to ${endA} hold the same lines in another order (too many to diff line by line)`);
		}
	} else {
		const w = y.length + 1;
		const t = new Int32Array((x.length + 1) * w);
		for (let i = x.length - 1; i >= 0; i--) {
			for (let j = y.length - 1; j >= 0; j--) {
				t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < x.length || j < y.length) {
			if (i < x.length && j < y.length && x[i] === y[j]) {
				i++;
				j++;
			} else if (j >= y.length || (i < x.length && t[(i + 1) * w + j] >= t[i * w + j + 1])) {
				out.push(`- ${x[i++]}`);
			} else {
				out.push(`+ ${y[j++]}`);
			}
		}
	}
	return out;
}

// Joins diff lines into a detail string, capped so one huge page cannot flood a report.
export function detailOf(lines: string[]): string {
	if (lines.length <= MAX_LINES) return lines.join("\n");
	return [...lines.slice(0, MAX_LINES), `... and ${lines.length - MAX_LINES} more lines`].join("\n");
}
