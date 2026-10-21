// github-slugger 1.5.0 ships no types. What the rich-text renderer (richtext.ts) uses.
declare module "github-slugger" {
	export default class GithubSlugger {
		slug(value: string, maintainCase?: boolean): string;
		reset(): void;
	}
}
