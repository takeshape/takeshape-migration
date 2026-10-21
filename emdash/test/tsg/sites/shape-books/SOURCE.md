# shape-books source

This site is a copy of the books starter for takeshape-ssg.

- Repository: https://github.com/takeshape/takeshape-starter-books
- Branch: trunk
- Commit: c464c77dce5a0036c0daefe1469eef084edc6ac5
- License: `"license": "MIT"` in its package.json

Copied paths: `tsg.yml`, `src/templates/`, `static/` and `.takeshape/pattern/`.

`site/.takeshape/pattern/schema.json` and `data.jsonl` are byte-identical to `emdash/test/fixtures/shape-books/` (checked with `cmp`).

## Golden build and export (2026-10-16)

- Project: "Shape Books Sample Project", id `00000006-0000-4000-8000-000000000006`, the original sample project the `shape-books` fixture came from. Mark linked a local checkout of the starter to it and exported it the same day (`export/`, from `export-IoxjHmdWi.zip`). The export's `schema.json` says `apiVersion` "1"; the 2020 fixture says "2".
- `golden/`, `cache/` and `golden.json` come from `node test/tsg/build-golden.mts starter-books --site-dir <a checkout of takeshape-starter-books>`: takeshape-ssg 12.21.1 in a build of the TakeShape CLI, read-only GraphQL queries, fixed clock `2026-10-15T16:00:00.000Z`, a live build followed by an offline rebuild from the fresh cache. 17 route outputs. The checkout's templates are byte-identical to `site/`.
- The live project keeps the original 2017 and 2018 `_enabledAt` and `_updatedAt` values; the 2020 fixture reset them all to 2020-10-22. The export and the golden's cached responses agree on every title and date.
- No `_createdAt` ties among posts, books or authors. Books and authors share one `_enabledAt`, which no starter query sorts on.

## Assets and image index

These let the end-to-end test run after TakeShape's CDN goes away on December 31 (`npm run test:tsg-e2e -- shape-books`, see the header of `test/tsg/e2e.mts`).

- `assets/` holds 19 generated placeholders, one for each of the export's 19 assets. Each has its original's pixel size, image format, channel count and EXIF orientation tag: a two-color gradient with four large shapes and the text `placeholder <width>x<height>`, drawn with sharp. The shapes are large so the compare's image hash stays stable under resizing. `412px-Alice_par_John_Tenniel_30.png` carries mild noise to stay over 100,000 bytes, which `test/tsg/image-endpoint.test.mts` relies on. The files are not TakeShape's sample images.
- The project and asset IDs throughout this site's files (the export, `golden/`, `cache/`, the asset folder names, `image-index.json` and `site/.takeshape/pattern/`) are made up. The swap rewrote `site/.takeshape/pattern/schema.json` and `data.jsonl` too, so those two files no longer match the starter at c464c77.
- `image-index.json` holds one entry per setting for the compare's rules check: width, height and dHash of the old image for one golden URL each. All 19 golden images ask imgix only to recompress, so their settings differ only by the source's shape, and 3 entries remain (landscape, portrait, square). The sizes are the ones imgix gave when the entries were recorded from `images.takeshape.io` on 2026-10-16. The 3 URLs carry no size parameters, so the compare makes each old image (`makeOldImage`) from its placeholder at that size, with nothing resized, and each entry's hash is of that image. Because the URLs now hold made-up IDs, a compare can't record new entries for them from imgix.
