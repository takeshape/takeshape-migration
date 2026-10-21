# Media preload for large TakeShape projects

Status: design, not built. Written 2026-10-14 against EmDash 1.2.0. Facts marked "verified" are recorded in `CLAUDE.md` with how they were checked.

Scope: this build ships local mode. R2 mode is designed here so the pieces fit, and gets built later, once a Cloudflare test account is ready.

## Why

Some TakeShape projects have tens of thousands of images. Today every image reaches EmDash through a `$media` reference that `emdash seed` downloads during the import, and that path breaks down at this size:

- `emdash seed` downloads one file at a time. Measured on 76 fixture downloads: mean 314 ms, p90 845 ms. 30,000 images is roughly 2.5 to 7 hours (verified).
- Its `$media` dedup cache lasts one apply. If an import dies at hour five, the rerun downloads every finished image again and adds a second media row and file for each (verified: shape-blog went from 15 rows and 24 MB to 30 rows and 48 MB).
- Customers hosting on Cloudflare then push every file a second time through site transfer: around 40 GB for 30,000 images at the fixture average of 1.36 MB. Site import also refuses files over 50 MiB and expires 24 hours after it is created (read from source).

The preload moves media into EmDash once, before content, in parallel, and remembers what it has done so a rerun only does what is left. The seed then points at the existing media rows instead of `$media`. A spike on all seven real-media fixtures showed EmDash accepts this: seeds validated, applied with 0 downloads, stored content matched a normal import, and reapplying added no media rows or files (verified).

## Goals

1. Every image or file the content uses lands in EmDash exactly once, however many times the customer reruns the converter or `emdash seed`. That includes the guide's clean redo, which deletes `data.db`.
2. An interrupted preload picks up where it stopped.
3. Downloads run in parallel.
4. `emdash seed` downloads nothing, so the content import is fast and safe to repeat.
5. Later build: optional R2 mode for Cloudflare hosting, where files never touch the laptop disk and never travel through site transfer.
6. Customers still download one file, `ts2emdash.mts`, and run it with plain `node`.

## Non-goals

- Changing how content converts. Only media values change.
- Copying assets the content never uses into EmDash. They stay out, as today; `--download-assets` remains the way to back them up.
- Rewriting rich-text links (as opposed to images) that point at `images.takeshape.io`. The report already lists them.
- Using EmDash's signed upload API. The server picks each media id after the file arrives, and site transfer needs every id fixed before content moves (verified). That is why Mark chose route B over a signed-upload design.
- Remote targets other than Cloudflare R2 and D1.
- Merging identical files. Two TakeShape assets with the same bytes (shape-startup has a pair) stay two media rows, as they are today.

## Anti-goals

These would make the feature a failure even if it technically works:

- Any rerun creating duplicate media rows or files.
- A partly written file being treated as done (the bug class fixed in `--download-assets` on 2026-10-14).
- Content pointing at media that does not exist, without the report saying so.
- Writing anything to the production D1 database before site transfer has finished. Import refuses a target with any media row, and writes during an import cause verify failures (verified).
- The customer guide claiming R2 mode works before a run on a real Cloudflare site shows it.

## Decisions Mark made

- The default destination is the local migration workspace: rows end up in `data.db`, written with EmDash's `MediaRepository`, and files go into `./uploads` through `LocalStorage`.
- The destination is swappable.
- Route B is the optional mode for Cloudflare: content goes first through site transfer, and media goes into R2 and D1 behind it. The goal is to let customers skip the laptop disk and the second upload.
- Local mode ships first. R2 mode is a later build, once a Cloudflare test account with a D1 database, an R2 bucket and an R2 API token is ready.

## How it works

### Overview

```
ts2emdash.mts export.zip --preload-media [local|r2]
  1. convert as today (seed object with $media references, in memory)
  2. collect every $media the seed holds
  3. preload each into the destination, recording it in the ledger
  4. copy the ledger's media rows to where EmDash reads them
     (local: into data.db; r2: write takeshape-media.sql for D1)
  5. rewrite each $media in the seed as the stored media value
  6. write the seed and the report
```

Step 5 is a pass over the finished seed object, the same walk the spike used. My call: a post-pass leaves the conversion code untouched. `$media` is built in `mediaFor()` in `ts2emdash.mts` and for Portable Text image blocks near lines 487 and 526.

### The ledger

My call, refining Mark's local-mode decision so goal 1 holds through the guide's clean redo: the record of what was preloaded lives in its own SQLite file, `takeshape-media.db` next to the seed, in both modes. Files still go straight into `./uploads` with `LocalStorage` (or into R2), and media rows are still created with `MediaRepository`, in the ledger's own `media` table. Step 4 then copies those rows into `data.db`. If the customer deletes `data.db` to redo the import, the next converter run copies the rows back, keeping the same ids and storage keys, without downloading anything.

The ledger is created and migrated with EmDash's own migrations (`runMigrations` from `emdash/db`, dialect from `emdash/db/sqlite`, Kysely), so its `media` table matches EmDash's exactly. Next to it, a table of our own records one row per preloaded source:

| Column | Holds |
| --- | --- |
| `source_key` | `asset:<TakeShape asset id>`, or `url:<url>` for media with no asset behind it |
| `source_url` | the URL fetched |
| `source_size`, `source_etag` | what the CDN reported, to notice a replaced file |
| `media_id`, `storage_key` | the EmDash media row this source became |

This also keeps R2 mode working: if the workspace `data.db` held rows for files that are not in local storage, `emdash site export` would stop with "Media file is missing from storage" (verified). In R2 mode, step 4 writes SQL instead of touching `data.db`.

### Which media get preloaded

Everything that is `$media` in the seed today, so no `$media` is left:

- Media backed by a TakeShape asset: fetched from `https://assets.takeshape.io/<path>`, the original bytes, as `$media` does today.
- `$media` whose URL is `assets.takeshape.io/<path>` or `images.takeshape.io/<path>` and whose path matches an asset: treated as that asset. Customer content mostly linked `images.takeshape.io`, which recompresses (verified), so this maps it back to the original.
- `$media` on a TakeShape host whose path matches no asset (for example a Draft.js image entity whose asset is missing): fetched from the URL as written, keyed by URL. My call. Images on other hosts never become `$media` (`ts2emdash.mts` only converts TakeShape-hosted image URLs); they stay external URLs, as today.

### Storage keys and resuming

- Each source gets a storage key we choose: `ts-<asset id><ext>` for assets, `ts-url-<first 16 hex of SHA-256 of the URL><ext>` for URL-only media. Ids are reduced to `[A-Za-z0-9_-]`; the extension comes from the filename, or from the MIME type when the filename has none. My call. EmDash's own byline avatars use caller-chosen keys the same way, and `r2()` stores each object at the bucket root under its key unchanged (verified).
- `MediaRepository.create` always generates its own id (verified), so the ledger's source table, not the id, is how a rerun recognises a source.
- The ledger row is the "done" marker. Per source: upload the file, then create the media row and the source row. A crash in between leaves a file without a row, and the next run uploads it again over the top. This matters because `LocalStorage.upload` writes straight to the final path, so a partial file is possible (verified).
- On a rerun, a source counts as done when its rows exist and its file exists (`storage.exists`). A missing file is uploaded again.
- A replaced file is downloaded again. The signal is a changed `source_url`: TakeShape asset paths have the form `<project>/<environment>/<upload id>/<filename>`, so a replaced file should arrive under a new path (assumed from that format, not verified). Size and ETag are recorded but not rechecked, since that would cost one request per file on every run. Changed alt text or caption updates the media row. If the extension changes, the source gets a new storage key and the old file is listed in the report as unused. My call.
- One preload at a time per ledger. The builder may add a lock file.

### Per source

1. Fetch. Retry network errors and 5xx a few times with backoff; treat 403 and 404 as permanent.
2. Hold the file in memory. EmDash's `LocalStorage` and `S3Storage` both buffer whole files before writing anyway (verified). Cap the total bytes in flight, using `Content-Length`, so a few large videos cannot exhaust memory. My call; the builder picks the cap.
3. For images, read width and height from the file header. EmDash's seed path does the same and computes no blurhash. My call: no blurhash by default, because a pure-JS decode of 30,000 images costs real CPU time. The builder may add an opt-in flag using `enrichImageMetadata` from `emdash/media`.
4. Compute the content hash with `computeContentHash` from `emdash` (`sha1:<hex>`, the format EmDash's own uploads store), so EmDash's duplicate detection recognises these files later.
5. Upload to the destination under the storage key.
6. Create or update the media row with `MediaRepository`: filename, MIME type, size, width, height, alt, caption, storage key, content hash, status `ready`. Alt and caption come from the same asset fields `mediaFor()` uses today.

Default concurrency is 8, changeable with `--media-concurrency`. My call.

### Failed sources

A source that still fails after retries gets no media row. My call: the seed leaves that value out (an empty field, or no image block in rich text), and the report lists each one with its URL, its error and the entries that use it. Rerunning the converter retries it, and a following `emdash seed` with `--on-conflict update` fills it in. Keeping `$media` as a fallback would have recreated the duplicate rows this design exists to prevent.

### Copying rows to EmDash

- Local mode: the converter migrates `data.db` if needed and upserts every ledger media row into it (same id, insert or update). It names that database in the report, because the seed only works against it.
- R2 mode: the converter writes `takeshape-media.sql` with one upsert per ledger media row (`INSERT … ON CONFLICT(id) DO UPDATE`), so running it twice is harmless and corrections reach D1.

### Seed values

These shapes were verified by the spike:

- Image and file fields: `{provider: "local", id, alt?, width?, height?, mimeType, filename, meta: {storageKey}}`.
- Portable Text image blocks: `{_type: "image", _key, asset: {_type: "reference", _ref: <id>, url: "/_emdash/api/media/file/<storageKey>", provider: "local"}, alt?, caption?, width?, height?}`.

Per-occurrence alt text from the `$media` reference wins over the row's alt, as EmDash's own `resolveMedia` does.

### R2 mode, end to end

The customer's order of operations. Credentials come from environment variables (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`), never flags, so they stay out of shell history.

1. Create the production site from EmDash's Cloudflare template (`d1()` and `r2({ binding: "MEDIA" })`), finish setup with sample content cleared, on the same EmDash version as the workspace.
2. Create an R2 API token with object read and write on the media bucket.
3. Run `ts2emdash.mts --preload-media r2` with the account id and bucket name. Files go to R2, rows go to the ledger, the seed points at those rows, and `takeshape-media.sql` is written.
4. `emdash seed` into a fresh workspace. It creates no media rows.
5. `emdash site export` and `site import` as the guide already describes. The package carries content and no media files. EmDash passes the media values through untouched (verified from source) and counts them as `unknown_storage_key` transformations, which the guide should mention so the count does not alarm anyone.
6. After the import shows a verified receipt: `npx wrangler d1 execute <database> --remote --file takeshape-media.sql`.
7. `npx emdash media repair-usage --all --url <site> --token <token>` to rebuild the media usage index, which EmDash marks stale after any import (verified).

R2 mode needs `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` in the workspace, because `emdash/storage/s3` imports both (verified). My call: use EmDash's own S3 adapter so the R2 calls are the code EmDash ships, and load it dynamically so local mode never needs those packages. The builder confirms which versions EmDash 1.2.0 expects.

### Report

A new "Media preload" section: mode, ledger path, the database or SQL file the rows went to, sources referenced, uploaded this run, already present, refreshed, failed (each with URL, error and the entries that use it), and total bytes. In R2 mode it also lists steps 6 and 7 above.

### CLI

Suggested flags; the builder may rename them:

- `--preload-media [local|r2]`, off by default. My call: opt-in for now, because the `$media` path is tested and simpler for small projects. Revisit after real customer exports have been through it.
- `--media-ledger <file>`, default `takeshape-media.db` next to the seed.
- Local mode: `--database <file>` and `--uploads-dir <dir>`, defaulting to `./data.db` and `./uploads` like `emdash seed`.
- `--media-concurrency <n>`, default 8.
- R2 mode, in the later build: `--r2-account <id>` and `--r2-bucket <name>`. Until then `--preload-media r2` fails with a clear message.

`--download-assets` stays independent. The builder may let one fetch serve both when both flags are set.

## Testing

Required before local mode ships. Offline, like `test/download-assets.mts` (fetch replaced with `test/fake-fetch.mts`), on each fixture:

- Preload, apply the seed, and check for 0 downloads during the apply and stored content that matches a `$media` import value for value.
- Run the converter and seed a second time: 0 new media rows, 0 new files.
- Delete `data.db`, run both again: 0 downloads, the same media ids and storage keys, the same stored content.
- A run where every download dies mid-stream leaves no media rows, leaves those values out of the seed and lists them in the report. A following good run fills them in.
- Change an asset's path or alt text in a copy of the export: the next run refreshes that file or row and nothing else.

Also required:

- Live CDN run on the seven real-media fixtures: every asset preloaded, files byte-identical to `curl`.
- Scale run with a synthetic export of 30,000 assets served by the fake fetch. Record wall time and peak memory, plus the file sizes and how long `emdash seed` takes. These are measurements, with no target yet.

Required before R2 mode goes in the customer guide (later build):

- Steps 1 to 7 above on a real Cloudflare site with at least one real-media fixture: the site package holds no media files, the media library lists every asset, entries render their images, and usage repair completes.

## Docs

- Guide, step 3: a short "Large projects" part for local mode: the flag, that rerunning resumes, and that a clean redo deletes only `data.db` (keep `uploads` and `takeshape-media.db`). Mirror into the Claude doc as `CLAUDE.md` describes.
- Guide, step 7 (Cloudflare): the site import limits that already apply to everyone, 50 MiB per file and 24 hours per import. R2 mode is added here only after the real-site run.
- `CLAUDE.md`: the new flags and tests, plus what was verified.

## Left to the builder

- Code structure inside `ts2emdash.mts`, flag names, progress output. Keep the destination behind one small interface (does this source exist, put these bytes, record this row) so R2 mode slots in later without touching the rest.
- The in-flight memory cap, retry counts and backoff.
- Whether one fetch also serves `--download-assets`.
- Splitting `takeshape-media.sql` if one file is too large for wrangler.
- How the tests are wired up, within the checks listed above.
