# The compare makes old images from local originals

Status: design, 2026-10-20. Owner: Mark Catalano.

## Why

Every image check in `compare-sites` fetches the old page's image from TakeShape's imgix host, images.takeshape.io. So does `test/tsg/build-image-index.mts`. Customers run the compare against their live site, several times per migration, so each run makes imgix send every image on every page. Node's `fetch` sends `Accept: */*`, which imgix answers with JPEG, while browsers mostly get WebP or AVIF. Many of those requests are probably fresh renders rather than cache hits. TakeShape pays for that bandwidth and those renders until January 15.

The originals are already on the customer's machine. A site move runs the converter with `--preload-media local`, which downloads every original from assets.takeshape.io into the project's `uploads/` and records each one in a ledger. The compare can make each old image from that copy with the same imgix rules the site's image endpoint follows, and ask imgix only for a small sample that checks those rules.

A large customer site shows the size of the saving: its golden pages held over ten thousand imgix URLs, in only about two dozen distinct parameter sets.

## Decisions (Mark, 2026-10-20)

1. **Old images come from local originals.** For an image on images.takeshape.io or assets.takeshape.io, the compare reads the original through the preload's ledger and makes the old side locally. It never fetches that image from either host.
2. **A small imgix sample checks the rules.** One real imgix request per distinct size setting, so a mistake in the rules shows up instead of agreeing with itself.
3. **Missing originals come from assets.takeshape.io.** An image the ledger doesn't hold (an asset from another TakeShape project, one missing from the export) is downloaded from assets.takeshape.io once, kept in a cache folder, and made locally like the rest. Never from imgix.
4. **Site moves always use the preload.** The migrate skill and the guide's site-move steps run the converter with `--preload-media local` every time, not only above 1,000 images and files. The guide's content-only import keeps its current advice.

## Goals

- A compare run makes no request to images.takeshape.io beyond the sample, and none to assets.takeshape.io beyond originals the ledger lacks.
- The image differences the compare reports stay as useful as today: missing or extra images, the wrong image, the wrong size, a different look.
- After January 15, a compare still runs, offline from TakeShape, given the project folder and the saved sample.
- The e2e and CI stay offline from TakeShape.

## Non-goals

- `rehost.mts` keeps fetching imgix's variant for a URL with size parameters. Those files ship on the new site, so they must be imgix's own bytes, and there are few of them (about a hundred files on the large site above, most fetched from assets.takeshape.io already). (Claude's call.)
- The converter, the preload and `emdash seed` already download from assets.takeshape.io only. They don't change.
- Images on hosts other than TakeShape's are fetched as today.

## Anti-goals

- A compare that passes because it compares the endpoint with itself and nothing else. The sample has to stay.
- A compare that fails every run after January 15 because imgix no longer answers.
- Downloading an original twice: once by the preload, again by the compare.

## The design

### Inputs

- `--media <project folder>`. The compare reads `<folder>/takeshape/takeshape-media.db` (table `takeshape_media_sources`: `source_url` on assets.takeshape.io to `storage_key`) and the files in `<folder>/uploads/`. Without `--media`, the compare works as today, and when it sees images on TakeShape's hosts it adds one note to the report saying `--media` would avoid fetching them.
- `--image-index <file>` keeps its meaning (saved facts about old images, keyed by URL, the format `compare/images.mts` reads today) and now also receives the sample: entries the compare fetches from imgix are written back to the file when the run ends. Later runs reuse every entry they find there, so they fetch only sample URLs for settings the file lacks.

### Making the old image

For an old image URL on images.takeshape.io or assets.takeshape.io:

1. Find the original. The URL's path names the asset (`<project>/dev/<asset id>/<file>`), so the ledger row is the one whose `source_url` on assets.takeshape.io has that path (see "The ledger" below). If there is no such row, use the cache folder (`<folder>/takeshape/compare-originals/`, same path layout as `--download-assets`), downloading from `https://assets.takeshape.io/<path>` if it isn't there yet. A download counts only if its size matches `Content-Length`, as everywhere else in the repo.
2. Make the image. On assets.takeshape.io the old site served the original, so use its bytes. On images.takeshape.io, take the plan from `imagePlan()` in `tsg2astro/runtime/imgix.ts` and run `sharpTransform()` from `runtime/image-sharp.ts`, the code the Node image endpoint runs. With no plan (no size parameters), use the original's bytes, capped at imgix's 8,192 pixels a side for images without parameters, which a large site showed.
3. Hash it with `imageOf()`, as the compare does today.

A file imgix rendered as an image (a PDF's first page, a PSD) can't be made locally. The compare reports it as the known class it reports today: the old site showed it as an image and the new site serves the file.

### The sample

- A setting is the URL's parameters with their values, leaving out the ones that only change encoding (`auto`, `fm`, `q`, `cs`, `lossless`, `ch`), plus three facts about the source: whether `canTransform()` takes its type (an SVG doesn't), its orientation (landscape, portrait or square), and whether it is smaller than the box the parameters ask for. So `w=300&blur=40` is its own setting, apart from `w=300`, and an effect the endpoint ignores gets sampled and shows up. (Claude's call, 2026-10-20. On the large site above, keying on every parameter but encoding gave the same settings as geometry alone.)
- For each setting seen on the old pages, the compare fetches one URL from imgix. Requests send a browser's `Accept` header (`image/avif,image/webp,image/*,*/*;q=0.8`).
- Each sampled imgix image is compared with the locally made one: the size must match exactly, the hash within the compare's threshold. A mismatch is a difference of a new kind, `image-rules`, naming the URL, both sizes and the hash distance. It is reported once per setting, not per page.
- `image-rules` counts like any other difference, so the run exits 1. It describes the same gap a page-level image difference against imgix shows today, once instead of on every page. The resolve skill's compare-differences reference explains it. A parameter the report's Image parameters section already names is a known limit: change the template or accept the difference. Any other is a gap in this repo's imgix rules, and the customer notes it as a known difference. (Claude's call.)
- If imgix doesn't answer (after January 15, or offline), the report says the rules check couldn't run for those settings, and the run's exit code doesn't change because of it.

### Crops where imgix picks the spot

For `crop=faces`, `crop=entropy`, `crop=edges` and `fit=facearea`, imgix chose where to crop from the picture itself, and sharp's choice differs (the repo measured sharp's face crop at hash distance 25 from imgix's). The compare fetches each such URL from imgix, as today, with the browser `Accept` header, and saves it to the index. They are rare: the large site had none. (Claude's call.)

### Saved entries and local images

- An `--image-index` entry for a URL is imgix's own answer, so when one exists, it is the old side, as today. A local image is made only for URLs without an entry.
- The rules check runs only on the sample: one entry per setting, compared with its local image. It doesn't run on every entry, so a large saved index costs no extra transforms.
- Only sample fetches and the crops above are written back to the file. Without `--media`, nothing is written.
- shape-books' committed `image-index.json` is cut to its sample entries (one per setting), so the e2e makes the rest of its old images locally and exercises that path.

### The ledger

A ledger row whose `source_url` is on assets.takeshape.io holds the original. A row on images.takeshape.io (an asset missing from the export, which the preload fetched from imgix) holds imgix's copy, so it doesn't count: the compare takes that path's original from the cache folder, downloaded from assets.takeshape.io. (Claude's call.)

### Who uses it

- The migrate skill and the guide's site-move steps: the converter always with `--preload-media local`; every compare command with `--media <project folder>` and `--image-index <project folder>/takeshape/image-index.json`. The first compare by January 15 records the sample; the file is small and belongs in git.
- `test/tsg/e2e.mts`: the compare gets the e2e project's folder as `--media` and `test/tsg/sites/shape-books/image-index.json` as the saved sample, so it makes no request to a TakeShape host, which the e2e already enforces.
- `test/tsg/build-image-index.mts` and its test are removed: the compare now does that job. `image-index.json` for shape-books keeps its entries: they are the recorded sample.

## Constraints

- The compare still runs from the repo with plain `node`. Reading the ledger uses no new package: `node:sqlite` is in every Node the repo supports (22.18 and up).
- The compare imports `imgix.ts` and `image-sharp.ts` from `tsg2astro/runtime/`, so old images follow the same code the generated site runs. Nothing is copied.
- Exit codes stay as they are: 0 clean, 1 differences or the page cap, 2 usage error or a site that doesn't answer.
- `npm run typecheck`, `npm test`, `npm run test:tsg-e2e -- shape-books` in both modes, and CI all pass, offline from TakeShape.
- CLAUDE.md, the guide, both skills and the Claude doc describe the new flags and the preload rule. Writing rules from CLAUDE.md apply.

## Left to the builder

- How the compare matches a URL's path to a ledger row (an index of paths read once at start is enough).
- Which concurrency the local transforms run at: they are CPU work, so the existing `--concurrency` may need its own limit for them.
- The exact wording of the new note and of `image-rules` differences.
- Whether `--media` without a ledger (a project made without the preload) is a usage error or falls back to the cache folder for every image. A clear error that says to rerun the converter with `--preload-media local` is the default.
