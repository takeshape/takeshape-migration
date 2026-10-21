// prismjs 1.29.0 ships no types. What the rich-text renderer (richtext.ts) uses.
declare module "prismjs" {
	export type Grammar = Record<string, unknown>;
	const Prism: {
		languages: Record<string, Grammar | undefined>;
		highlight(text: string, grammar: Grammar, language: string): string;
	};
	export default Prism;
}
declare module "prismjs/components/*";
