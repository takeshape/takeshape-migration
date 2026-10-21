// Loaded with `node --import`. Pins `Date.now()` and `new Date()` to TSG_FIXED_NOW.
// Dates built from arguments are untouched.
const fixed = process.env.TSG_FIXED_NOW;

if (fixed) {
	const fixedMs = new Date(fixed).getTime();
	if (Number.isNaN(fixedMs)) throw new Error(`TSG_FIXED_NOW is not a date: ${fixed}`);
	const RealDate = Date;

	class FixedDate extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) super(fixedMs);
			else super(...(args as [number]));
		}
		static override now(): number {
			return fixedMs;
		}
	}

	// A bare Date() call returns a string, so the class needs a call trap.
	globalThis.Date = new Proxy(FixedDate, {
		apply: () => new RealDate(fixedMs).toString(),
	}) as DateConstructor;
}
