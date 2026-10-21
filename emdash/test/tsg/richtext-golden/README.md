# Rich-text golden files

These files hold the HTML that TakeShape's own Draft.js renderer printed for the rich text in the fixtures and in the crafted cases (`../richtext-cases.json`). They were made on 2026-10-15.

`../richtext.test.mts` converts the same values with `ts2emdash.mts` and checks that `tsg2astro/runtime/richtext.ts` prints exactly the same HTML.

The IDs in these files were replaced with made-up ones, the same as in the fixtures. The renderer that made them is not part of this repo, so the files are not regenerated.
