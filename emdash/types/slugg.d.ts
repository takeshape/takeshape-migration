// slugg 1.2.1 ships no types. What the filters (filters.ts) and tsg2astro use.
declare module "slugg" {
	export default function slugg(value: string, separator?: string, toStrip?: string): string;
}
