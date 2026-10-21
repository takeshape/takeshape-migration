# Compare differences

`compare-sites.mts` crawls both sites from `/`, `/sitemap.xml` and every link it finds, and compares each path the old site serves with the same path on the new site. Its report starts with a Summary table of difference kinds, then lists each page's differences. One section per kind below, in the order of that table, then the report's other parts.

Read the detail line first: it names the old and new values. For each difference, confirm the fix with the same compare command (see "Confirm each fix" in `SKILL.md`). The path must drop out of the report, and nothing new may show up.

To check one path quickly while you work, fetch it from both sites with `curl -sI <old-url><path>` and `curl -sI http://localhost:4321<path>`, then run the full compare to confirm.

## missing: pages the new site does not have

The old site serves the path and the new site answers with an error: a 4xx or a 5xx. The detail names both answers, such as `Old answers 200, new answers 500.` Find the route in the report's route table, then:

- A 5xx: a template or loader broke on this page. Read the server's output (`<work>/server.log`, or the terminal running the server) for the stack trace. It's usually a template reading a value its loader doesn't return, or a loader error. Fix it in that file.

- An item page (a post, a book): the field its URL is built from holds another value. The route's path in the report's route table names that field: `/blog/:title/` builds each post's URL from its title, so fix the title in the admin to match the old page. The entry's EmDash slug matters only for a route whose path reads `:slug`. For those, ts2emdash's `--site` gave each entry the slug its old URL used, and the content report names any it couldn't keep.
- An entry that is a draft in EmDash but had a page on the old site: some TakeShape lists included drafts. Ask the customer whether to publish it.
- A listing page past the last one (`/blog/page-4/`): the list holds fewer entries than TakeShape's did. See the loader notes in `tsg2astro-report.md` under Queries and Not translated.
- A route with no pages at all: `tsg2astro-report.md` lists it under Not translated (see `report-items.md`).
- A file (CSS, JavaScript, an image under the site's own paths): it's missing from `public/`. The old site's front-end build probably wrote it into `static/` after tsg2astro copied the folder. Move the front end into `<out>/frontend/` as "The front end" in `SKILL.md` says, and build it into `public/`.
- Pages under a locale prefix: only the default locale is translated.
- `/404` with "Old answers 200, new answers 404", or `/500` with "Old answers 200, new answers 500", when the Routes notes in `tsg2astro-report.md` list a route there: Astro answers those paths with its own status, and the compare skips their content. Check by hand that the new page matches the old one: `curl -s <old-url><path>` against the same path on the site you compared (`http://localhost:4321<path>`, or `<new-url><path>` in production). If it does, nothing to fix: each such route may leave this one difference when the move is done. Any other status at those paths, such as 500 at `/404` or 404 at `/500`, means the page fails: fix it like any other `missing` page above.

Confirm: the path drops out of the report, and `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4321<path>` prints what the old site answers.

## extra: pages only the new site has

The new site answers 200 on a path the old site answered with a 4xx, and the old site never linked to it.

- A page for an entry the old site never showed: a draft that is published in EmDash, or an entry added after the export. Ask the customer.
- A listing page beyond the old site's last one: the list holds more entries than TakeShape's did. Check the loader's conditions.
- A URL a route module answers that takeshape-ssg never wrote: the route module's `itemPage`, `listingPage` or `page` (in `src/routes/<route>.ts`) must return null for it, which gives a 404.

Confirm: the path drops out of the report, and the new site answers it with 404.

## status: different status codes

The two sites answer with different codes where `missing` and `extra` don't fit: both answer with errors, but not the same one; the old site answered an error on a path it linked to, and the new site answers it; or one side didn't answer at all (`0`, after `--timeout-ms`, 30 seconds by default).

- A 5xx on the new site where the old site also answered with an error (a 404, say): read the server's output (`<work>/server.log`, or the terminal running the server) for the stack trace, and fix the template or loader it names. The new site should answer 404 there.
- Two different 4xx codes: compare the old host's answer with the new site's 404 page (`src/pages/404.astro`). The new site answers every unknown URL with 404, as the old host did for files it didn't have.
- The old site answered an error and the new one a page: the route module answers a URL takeshape-ssg never wrote. Make its `itemPage`, `listingPage` or `page` return null for it.
- 0: the server stopped or hung. Restart it and run the compare again. Raise `--timeout-ms` for slow pages.

Confirm: the path drops out of the report, and `curl -s -o /dev/null -w '%{http_code}\n'` on both sites prints the same code.

## redirect: different redirects

One side redirects and the other doesn't, or they redirect to different places. The new site does what a static host did with takeshape-ssg's files:

- A folder URL without its trailing slash (`/blog`) gets a 301 to `/blog/` when that page exists, and a 404 when it doesn't.
- `<folder>/index.html` serves the page at `<folder>/` (`src/middleware.ts`).

If the old host had its own redirect rules (a hosting provider's redirects file, a rule for another domain), they aren't in `tsg.yml`. Add each one to `src/middleware.ts`, before it calls `next()`: return `context.redirect(target, 301)` for that path.

If the compare shows the same page under two domains (`example.com` and `www.example.com`), pass the second as `--origin https://example.com`, so it counts as the same site.

Confirm: the path drops out of the report, and `curl -sI` on both sites shows the same status and `Location`.

## content: different page content

The detail is a short diff of the page's structure and visible text: `-` lines are the old site, `+` lines the new. The compare ignores whitespace, comments, attribute order and the hosts of images and files. Find the generated template behind the URL and the old one at the same path, then look for the cause:

- Text that comes from the clock. takeshape-ssg printed it once, when TakeShape built the site, and the new site prints it on every request. Look for `now` in the template, or a date filter on a field the query doesn't ask for: `date` on a missing value prints the current date. TakeShape's books starter does this: its book page prints `Published {{ book.publishDate | date('MMMM D, YYYY') }}`, and its query never asks for `publishDate`. The difference goes away only when the old site is rebuilt. Rerun the compare with `--ignore-text` and a pattern that matches that text and nothing else, written as the source of a JavaScript regex without slashes or flags: `--ignore-text 'Published [A-Z][a-z]+ \d{1,2}, \d{4}'`. Tell the customer what you ignored and why.
- Content that changed after the export. If the old page shows newer text than the entry in EmDash, someone edited TakeShape after the export, or the live site wasn't redeployed before it. Don't patch the template: go back to the migrate skill's step 2.
- A list that holds other entries, or the same ones in another order (recent posts, related items, a listing page): a condition or sort the loader left out (`tsg2astro-report.md`, under Not translated and Queries), or a draft. Fix it in the loader.
- An empty spot where the old page showed a linked entry: the link points at a draft. EmDash's public reads skip unpublished entries, where TakeShape returned them. The content report lists each such draft under "Drafts that published entries link to". Ask the customer which to publish; publishing is their call, so don't publish one yourself.
- Rich text that differs: check the content report's "Needs your attention" for blocks kept as plain text or as TakeShape's HTML. Rebuild those blocks in the EmDash editor.
- Text that came from a connected service (content report, "Not migrated"): fetch it in the loader, or drop it with the customer's OK.
- Lines around a construct `tsg2astro-report.md` lists under Not translated: fix that construct (see `report-items.md`).
- A different `Content type` line: an endpoint answers with another Content-Type. Fix it in the endpoint in `src/pages/`.
- A file that differs in bytes (CSS, JavaScript, an icon): `public/` holds another version than the old site served. Copy the old file in.

Confirm: the path drops out of the report. For clock text, the rerun with `--ignore-text` shows no difference on those pages, and nothing else changed.

## broken-link: links on the new site that lead nowhere

A link on a new page leads to a 4xx or a 5xx, or to nothing that answers, directly or through a redirect, and the old page had no such dead link.

- The target is reported `missing` too: fix that first, and the link follows.
- A link to `/_emdash/api/media/file/...`: the media file didn't load. Check the seed's output for failed downloads and seed again (migrate skill, step 5).
- A link to a file the old site had under `static/`: copy it into `public/`.
- A link a template builds from a value the loader doesn't return: find the expression in the template, and add the field to the loader.

Confirm: the page drops out of the report's broken-link lines, and the link's target answers 200 on the new site.

## image: images that differ

Images are paired by their order on the page. Each pair must have the same pixel size and look the same; recompression and another file format are fine. With `--media`, the old side of an image on TakeShape's CDN is made from its preloaded original by the image endpoint's rules, so in Node mode a pair differs only when the new page asks for another image or other parameters, with two exceptions: an image without parameters over 8,192 pixels a side (imgix capped it, the new site sends it whole), and a crop where imgix picked the spot (`crop: 'faces'`, `entropy`, `edges`, `fit: 'facearea'`), which the compare still takes from imgix. A gap between those rules and imgix shows up once per setting, as `image-rules` below. The detail says which kind:

- "N images on the old page, M on the new": an image is missing or extra. Look for an empty image field (a failed media download, a link to a draft), or a block the template prints under another condition.
- "old ... is WxH, new ... is WxH": the size differs.
  - A parameter or value the image endpoint ignores, listed under "Image parameters" in the report: see that section in `report-items.md`.
  - On `npm run dev` or `npm run preview` (Cloudflare's local runtime), the Images binding runs offline: it resizes, but `fit: 'fillmax'` and `fit: 'min'` come out at another size. If Node mode shows the right size, the deployed site will too.
  - On the deployed site, an image at full size: the Cloudflare account is past Images Free's 5,000 unique transforms this month, and the endpoint sends the stored file. `npx wrangler tail` shows "image transform failed". The customer can wait for next month or buy Images Paid (ask first).
  - On the deployed site, one large image at full size: its stored file is over what Cloudflare transforms, 100 MB, 100 megapixels or 12,000 pixels a side (`npx wrangler tail` shows "image transform failed" and "over Cloudflare's"). Files over 20 MB go through Cloudflare's transforms by URL, which fetch them from the site's media route, so "cf.image answered" with an error code means that fetch failed. Ask the customer to upload a smaller copy in the admin and swap it in.
- "same size but they look different": another picture. Check which image the entry points at in the admin. Two TakeShape assets with the same bytes become one media item in EmDash, which is fine.
  - On Cloudflare's local runtime, the offline Images binding ignores where to crop (`crop`, `fp-x`, `fp-y`) and `flip`. If Node mode matches, the deployed site will too.
  - In Node mode, `crop: 'faces'` uses sharp's attention crop, which can pick another spot. The Workers build uses Cloudflare's face detection.
- "cannot read": the image URL didn't answer. Fetch it with `curl -sI` to see why. For an old image on TakeShape's CDN with `--media`, it's the original: the preload's record lacks it and assets.takeshape.io didn't answer either.
- "imgix showed the file old ... as an image": imgix rendered a PDF's first page or a PSD as a picture. The new site serves the file, which `<img>` can't show. Ask the customer for a PNG or JPEG of it, upload that in the admin, and swap it in.

Confirm: the page's image lines drop out of the report.

## image-rules: settings where the local image doesn't match imgix's

With `--media`, the compare makes old images itself, by the rules the site's image endpoint follows. For each setting (an image URL's parameters, apart from the ones that only change encoding, and the source's type, shape and size against the box), it asks imgix for one real image and compares it with its own. This line says the two differ: imgix's size and the endpoint's, or the hash distance. Each line names one URL and how many images on the old pages use that setting.

- A parameter or value the report lists under "Image parameters" (an effect such as `blur` or `sat`): a known limit of the endpoint. Change the template so it no longer asks for it, or show the customer the difference and accept it.
- Anything else: the endpoint's rules differ from imgix for that setting, and every image using it differs on the deployed site too. Show the customer the URL and both sizes, note it as a known difference, and move on. The rules live in the takeshape-migration repo (`emdash/tsg2astro/runtime/imgix.ts`), not in the project.

Confirm: after a template change, run the compare again; a line for a setting no page uses any more drops out.

## takeshape-host: TakeShape services that stop on December 31

An HTML, CSS, JavaScript or JSON file on the new site names `api.takeshape.io`, `images.takeshape.io`, `assets.takeshape.io` or another `takeshape.io` subdomain. The detail says which host and how often.

- `api.takeshape.io` in JavaScript: browser code that calls TakeShape. Follow "Browser code that calls TakeShape" in `SKILL.md`.
- `images.takeshape.io` or `assets.takeshape.io` as a base URL in JavaScript, with no path after it, such as `imageBaseUrl` and `assetBaseUrl` in takeshape-routing (`getImageUrl`, `getAssetUrl`): browser code that builds image URLs from an asset's `path` in the site's data files. On the new site, `path` is the file's EmDash storage key (`ts-<asset id>.jpg`), so those images are broken today, months before December 31. Build those URLs on `/_emdash/api/media/file` in the front end's source, moved into `<out>/frontend/` as "The front end" in `SKILL.md` says. Passing `{ baseUrl: '/_emdash/api/media/file' }` to takeshape-routing fixes the images, but its default base URL stays in the bundle and this scan still flags it. A `getImageUrl` of the site's own, with takeshape-routing's rules (the image's `path`, or the string itself; each path segment through `encodeURIComponent`; the query's non-empty values in key order), leaves nothing behind once no code imports takeshape-routing's. Rebuild the front end, which writes into `public/` and copies its `manifest.json` to the copy under `src/routes/_data/`, and run rehost again. Don't edit the built file in `public/`: the next build replaces it. The site sends a media URL with imgix parameters (`w`, `h`, `fit`, `auto`) through its image endpoint, so the code's sizes and `srcset`s keep working. A URL without parameters gets the stored file at full size, where TakeShape's CDN compressed it.
- A full CDN URL written into the browser code itself (`https://images.takeshape.io/<project>/dev/<id>/photo.jpg?w=300`): rehost rewrites it in `public/`'s copy, but the source keeps it, and every rebuild of the front end brings it back. Download each into the front end (the variant the URL asks for, checked against its `Content-Length`), have its build copy them into `public/` (for example from `frontend/static/images/` to `public/images/`), point the code at that path, and rebuild. Don't point it at an EmDash media URL: a site transfer gives every media file a new storage key, so a key written into code breaks on the deployed site.
- `images.takeshape.io` or `assets.takeshape.io` in a page's rich text: a link the content report lists under "Links to TakeShape-hosted files". Upload the file to the EmDash media library and change the link in the entry.
- The same hosts in a template, CSS or a static file: download the file, put it in `public/`, and point the URL there. In CSS or JavaScript the front end builds, change the source in `<out>/frontend/` instead (the file into the front end's images, the `url()` pointing at it) and rebuild: rehost rewrites the built file, and the next build, a CI build included, brings the old URL back.
- Text that only mentions a host (a sentence about TakeShape's API) counts too. Rewrite it with the customer.

Confirm: the file drops out of the report, and `grep -rn 'takeshape.io' <out>/public <out>/src` finds no service host (links to `www.takeshape.io` are a separate matter, below).

## The report's other parts

- Notes, "the compare is incomplete": the crawl stopped at `--max-pages` (5,000 by default), and the compare exits 1 even with no differences. Raise `--max-pages`, or add `--ignore-query` when query strings make one page look like many.
- "Links to TakeShape's website, which go dead after December 31": links to `takeshape.io` or `www.takeshape.io`, such as a "Powered by TakeShape" footer. They don't fail the compare. Show the list to the customer and ask whether to keep them.
- Exit 2: a site didn't answer at `/`, or the command was wrong. The message names the side. Check the address and that the server is running. "No media ledger at ..." means the project has no preload record: run the converter again with `--preload-media local`, as the migrate skill's step 3 does.
- Notes for this run don't change the exit code:
  - "The rules check couldn't run for N settings": imgix didn't answer. The old images were still made from the originals. Run the compare again while imgix answers (before December 31) to record its answers in `takeshape/image-index.json`.
  - "N originals ... were downloaded from assets.takeshape.io": images the preload's record lacks (an asset from another TakeShape project, or one missing from the export), kept in `takeshape/compare-originals/` for later runs.
  - "N old images on TakeShape's hosts were fetched from them": the compare ran without `--media`. Add it.
