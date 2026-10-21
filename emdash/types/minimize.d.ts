// minimize 2.2.0 ships no types. What runtime/html-compression.ts uses: parse without a callback returns the HTML.
declare module "minimize" {
	export default class Minimize {
		constructor(options?: Record<string, unknown>);
		parse(html: string): string;
	}
}
