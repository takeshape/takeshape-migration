# TakeShape migration

TakeShape shuts down on December 31, 2026. Every project, with its content, assets and APIs, is deleted that day. This repo holds the guides and scripts for moving off TakeShape before then.

## Guides

| If you use TakeShape for | Move to | Start here |
| --- | --- | --- |
| Content and images (CMS) | [EmDash](https://emdashcms.com), the open source Astro CMS from Cloudflare | [emdash/](emdash/) |
| A website TakeShape builds with takeshape-ssg (a `tsg.yml` in its folder) | An Astro site on EmDash, on Cloudflare Workers, with every page checked against the live one | [emdash/: Moving a takeshape-ssg site](emdash/README.md#moving-a-takeshape-ssg-site) |

## Working on the scripts

Each guide's folder holds its own scripts and tests. For EmDash:

```bash
cd emdash
npm install
npm run typecheck
npm test
npm run test:tsg-e2e -- shape-books
```

You need Node.js 22.18 or later for the scripts, and 22.22 or later for the site translator's end-to-end test; `.nvmrc` pins 26 for development. `npm test` runs the unit tests, then converts nine sample TakeShape exports and imports each one into a fresh EmDash database, checking that every entry arrives. Their asset IDs are made up. So every asset download fails, and the test only counts the failures. `npm run test:tsg-e2e -- shape-books` moves TakeShape's books starter through the whole site migration and compares the result with a build of the original. [CLAUDE.md](CLAUDE.md) explains how the converter and the site translator work.

## License and warranty

Everything in this repo is open source under the [MIT license](LICENSE) and comes as is, without warranty of any kind. TakeShape Inc. doesn't promise the scripts or guides will work for your project, and isn't liable for lost data, downtime or any other damage from using them.

Files copied or ported from other projects keep their own licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
