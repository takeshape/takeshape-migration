# Site translator: takeshape-ssg sites to EmDash on Cloudflare

Status: design, not built. Written 2026-10-15 against EmDash 1.2.0, EmDash's Cloudflare templates (github.com/emdash-cms/templates at commit 1930243, Astro 7.3) and takeshape-ssg 12.21.1. "Read" marks facts taken from source. "Ran" marks behavior observed on 2026-10-15 by running the built SSG outside this repo. Neither counts as tested here.

## Why

Customers who built their site with takeshape-ssg lose more than content after January 15, 2027. TakeShape builds and deploys those sites on its own servers, and every page's data comes from TakeShape's GraphQL API. `ts2emdash.mts` moves the content into EmDash, but the site itself has nowhere to run: a `tsg.yml` of routes, Nunjucks templates and GraphQL queries.

This design adds three things to the `emdash/` package:

- `tsg2astro.mts`, a script that translates a takeshape-ssg site into an Astro site on EmDash, deployed to Cloudflare.
- `compare-sites.mts`, a script that crawls the old site and the new one and reports every difference per URL.
- Agent skills, so the customer's coding agent can drive the whole move and resolve what the scripts can't.

## Who runs it, and how

A TakeShape customer whose site builds with takeshape-ssg. The `tsg.yml`, templates and queries are theirs, so every site is different. All of them build with takeshape-ssg, whose input is closed (see "The input"). The shape-* fixtures are simple approximations of these sites, not samples of real ones.

The customer runs it themselves, usually through a coding agent:

1. They open their coding agent in the old site's folder and ask it to move the site to EmDash.
2. The migration skill walks the agent through the steps: export the content, run `ts2emdash.mts`, run `tsg2astro.mts`, load the content into the new site locally, run the compare, deploy to Cloudflare, then run the compare against the deployed site.
3. When the translator's report lists something, or the compare finds a difference, the resolution skill tells the agent how to fix that kind of item in the generated Astro files, and to confirm each fix with the compare.

A customer without a coding agent follows the same steps from the guide. The skills add nothing the guide doesn't say.

## Goals

1. Identical sites. Every URL the old site served still serves the same page, each page has the same layout, the same images appear at the same size and crop, and every link goes where it went before.
2. The output is a normal Astro project on EmDash. From then on, developers maintain it by editing `.astro` and TypeScript files. No Nunjucks or GraphQL is left at runtime.
3. The translator is deterministic and covers the whole takeshape-ssg input except `locales` (see Non-goals). The same input gives the same output on every run.
4. On the starter sites and on real customer sites, the translator's report is empty and the compare comes back clean. Any fix an agent has to make counts as a translator bug, with one planned exception: browser code that calls TakeShape (next section).
5. The compare tells the customer, per URL, whether the new site matches, both before they go live and after.
6. Content edits in EmDash show on the site without a rebuild.
7. Customers download the scripts from this repo and run them with plain `node` 22.18 or later, like `ts2emdash.mts`.

## Non-goals

- Translating the customer's front-end build (webpack, Sass, PostCSS, client-side JS). It keeps running as it does today and writes into the Astro project's `public/` instead of `static/`.
- Translating browser code that calls TakeShape at runtime. On the real sites, several front-end files each import one config module that holds the `api.takeshape.io` endpoint and a token. They drive lists, search and other blocks that fill in after the page loads. Until January 15 they keep working; after that, those blocks go blank. The translator finds every call and lists it in the report with its query, and the customer's coding agent replaces each one, guided by the resolution skill. That is planned agent work, not a translator bug (Mark's decision).
- Byte-identical HTML. Minification, whitespace, attribute order and asset hosts differ, and the compare normalizes them.
- Reproducing build failures. takeshape-ssg aborts the build on `null | image`, so no deployed page ever hit it. The new helpers return `''` instead.
- Hosting on anything but Cloudflare Workers.
- TakeShape's preview, its "live links" usage stats, and its six deploy providers, from S3 to Vercel.
- SSG versions other than 12.21.1. TakeShape built every deployed site with the server's current version.
- `locales`. No real site uses it, and `ts2emdash.mts` migrates only the default locale. The translator lists it in the report as unsupported. (My call.)

## Anti-goals

These would make the work a failure even if it technically runs:

- A compare that passes while a visitor would see a difference: a missing page, a broken link, a wrong or missing image, a block of content gone. That includes blocks the browser fills from TakeShape, which still work until January 15.
- Generated code a developer can't follow, such as one opaque render function per page or Nunjucks hidden inside Astro.
- A URL that changes without the compare saying so.
- The translator dropping something without the report saying so.
- Agent edits becoming the normal way a site gets finished.
- The guide claiming a kind of site works before a compare in this repo came back clean on one like it.

## Decisions Mark made

- The new site runs on Cloudflare, using EmDash.
- "Identical" is judged on the built and deployed sites: the URLs and layouts, and the images and links on each page.
- The output is real Astro templates. A month after the move, a developer who wants to change the blog post layout opens the `.astro` file that controls it.
- The new site reads the collections and field names that `ts2emdash.mts` creates.
- Customers run it themselves, and it lives in this repo's `emdash/` package.
- A compare step crawls the old deployed site and the new site and reports per URL: missing or added URLs, changed or broken links, missing or different images, and layout differences. It compares rendered structure and visible content, not bytes. Our own tests run the same compare.
- The translator is a deterministic script, and the aim is for it to work perfectly. It pairs with agent skills: the customer's coding agent runs the script, and the skills guide the agent and help it resolve issues. The agent is the last resort.
- Skills are Markdown in the Agent Skills format, kept in this package. The guide covers the same steps by hand.
- `ts2emdash.mts` writes a machine-readable field map next to the seed, and the translator reads it, so the two always agree on names.
- Browser code that calls TakeShape is a job for the customer's coding agent and the skills. We document it and hand it off to the agent.
- Code from TakeShape's own source may be ported into this repo and into the helpers copied into customer projects, for the purposes of the migration.
- Mark will run a large customer site's takeshape-ssg build locally when the work is ready for it.
- The work is needed as soon as possible.
- Pages too heavy for one request load paired relations through a small helper that batch-reads EmDash's reference table directly (see "Queries become loaders").

## Constraints

From the target (read from EmDash 1.2.0 and the Cloudflare templates):

- EmDash on Cloudflare is an Astro SSR app on one Worker (`output: "server"`, `@astrojs/cloudflare`), with D1 bound as `DB` and R2 as `MEDIA`. Content pages render per request; EmDash's templates never prerender CMS content.
- Workers forbid `eval` and `new Function`, so nothing may compile templates at runtime.
- Per request, the Workers Free plan allows 10 ms of CPU and about 50 D1 queries. The Paid plan allows 30 s of CPU by default and 1,000 queries. Both allow 128 MB of memory and a 64 MiB bundle.
- EmDash owns `/_emdash/*` and `/.well-known/oauth-*`. It also serves `/sitemap.xml`, `/sitemap-<collection>.xml` and `/robots.txt` unless the site defines its own routes for them.
- Image resizing goes through EmDash's `/_image` endpoint and the Cloudflare Images binding. The free tier covers 5,000 unique transforms a month, and past that, new transforms fail with error 9422. EmDash registers its media for resizing only when the site URL (`siteUrl`, `EMDASH_SITE_URL` or `SITE_URL`) is known at build time. Otherwise images render full size (read, not run).
- EmDash serves SVG and PDF media with `Content-Disposition: attachment`, so a direct link downloads the file instead of opening it.
- A seed at `.emdash/seed.json`, at `seed/seed.json` or at the `package.json` `emdash.seed` path is bundled into the Worker. The content seed must never sit at those paths.
- `emdash seed` writes only to local SQLite. Content reaches production D1 through site transfer, as the content guide describes.
- Relation-bound reference fields come back only through `getEmDashEntry`'s `references` option, at one query per field plus one per target collection. `getEmDashCollection` returns entries without them.
- `getEmDashCollection` paginates by cursor, or by offset with `hasMore`, and returns no total count.
- Entry dates come back as `Date` objects. Imported entries have `published_at` set to the import time, so the original date lives in `takeshape_published_at`.

From the repo: Node 22.18 minimum, erasable TypeScript only, `.mts` files, and real packages imported through `load()`. The writing rules in `CLAUDE.md` apply to the report, the skills and the guide.

## The input

A customer site consists of these and nothing else (read from the source of takeshape-ssg and TakeShape's CLI; the deploy zip holds only `tsg.yml`, `staticPath` and `templatePath`):

- `tsg.yml`, merged over defaults with `${env.X}` and `${key}` interpolation.
- Nunjucks 3.2.0 templates with stock tags, filters, tests and globals, and autoescape on.
- 11 TakeShape filters: `image`, `asset`, `route`, `date`, `md`, `number`, `numberFormat`, `code`, `pluralize`, `union` and `intersection`.
- GraphQL queries against the project's TakeShape API, named only from `tsg.yml`.
- JSON and YAML data files.
- `static/`, often filled by a webpack build, plus manifest JSON that templates read through `context`.
- Environment variables.

A site can't add code: no custom filters, globals, tags, plugins or hooks. Across the real sites, `route`, `safe` and `image` make up nearly all filter use. `asset`, `number`, `code`, `pluralize`, `union` and `intersection` never appear, but the translator still covers them.

Appendix A lists the behavior the translator has to reproduce, with sources.

## What the customer gets

A new Astro project folder, `./emdash-site` by default and never inside the old site's folders. It starts from EmDash's `starter-cloudflare` template at a pinned version and contains:

- The template's `astro.config.mjs`, `wrangler.jsonc`, `src/worker.ts` and `src/live.config.ts`, with the site URL set.
- `src/pages/`: one page or endpoint per `tsg.yml` route (see "Routes").
- `src/layouts/` and `src/components/`: translated base templates and partials, plus a component per macro.
- `src/data/`: one loader per query file (see "Queries become loaders").
- `src/lib/takeshape/`: helpers the generated code imports. That covers the 11 TakeShape filters, the stock Nunjucks filters the site uses, path slugging, the rich-text renderer and image URLs. They're copied in as source, so the project doesn't depend on this repo.
- `public/`: the old `static/` folder.
- `tsg2astro-report.md`: everything not translated, by file and line, with the reason.
- No content seed at any of the bundled seed paths.

## How it works

### Pipeline

```
node tsg2astro.mts <site dir> --export <export.zip|dir> --field-map <file>
                   [--out ./emdash-site] [--site-url https://www.example.com]
  1. load tsg.yml exactly as takeshape-ssg does: defaults, lodash merge, ${} interpolation with env
  2. parse every template the routes reach (Nunjucks's own parser) and every query (graphql)
  3. resolve each query against the TakeShape schema in the export, then map shapes and
     properties to collections and fields through the field map
  4. emit loaders, pages, endpoints, layouts, components and helpers
  5. copy the template scaffold and static files
  6. write the report
```

The script reads only. Rerunning it rewrites its output folder and report.

### Field map and slugs

`ts2emdash.mts` writes `takeshape-field-map.json` next to the seed. It records, for each shape, its collection or taxonomy; for each property path, the field slug and kind, plus any relation and its direction; the entry slugs that were renamed; and the `takeshape_id` and `takeshape_published_at` fields. (My call: the file name and location.)

Item pages must find their entry from the URL with one indexed lookup. takeshape-ssg builds item URLs from `slugg(value)` of the path variables, and that value may not be the EmDash entry slug: `/blog/:title/` uses the title. My call: `ts2emdash.mts` takes the site's `tsg.yml` (`--site <tsg.yml>`) and sets each routed entry's slug to the value tsg put in its URL. The new site then looks entries up by slug, and entries created later in EmDash get URLs the same way. The builder settles routes with several path variables and entries reached by more than one route. The report lists any entry whose old URL can't be kept.

### Routes

Each `tsg.yml` route becomes Astro routes that answer exactly the URLs tsg wrote:

- A plain route (`path`, `template`, optional `context`) becomes a page at that path. tsg never substitutes variables in plain routes, so `/people/{author.name}` is a literal path (ran).
- Paginated item pages become a dynamic route that loads the entry by slug, checks it belongs to the route's query (its `where` and `filter`), and passes `item`, the `itemName` alias, `previousItem`/`previousPath` and `nextItem`/`nextPath` in the route's sort order.
- Listing pages become a dynamic route over `:num`, with `items` and `pagination.currentPage`/`pagination.totalPages`. `firstPage` moves page 1 to its own path.
- Routes whose output paths overlap become one dynamic route that tries each in `tsg.yml` order and serves the first match. That copies tsg's rule that the first route wins and later duplicates are dropped silently. One real site puts several paginated routes on `/:slug/`.
- A path with an extension (feeds, sitemaps, JSON "static APIs", `/404.html`) becomes an endpoint that returns the same text with the same content type.
- A URL tsg never wrote returns a real 404 through `Astro.rewrite("/404")`, never a redirect.
- Trailing slashes behave as they did on the old host. The compare checks this.

### Queries become loaders

Each `.graphql` file becomes a loader module: a typed async function that calls `getEmDashCollection` and `getEmDashEntry` and returns an object shaped like the GraphQL response. My call: keeping the response shape lets the translated template bodies keep their original expressions (`item.title`, `site.logo.path`), so a developer can read the old and new templates side by side. TakeShape's field names appear in the shape, and EmDash's names appear only inside the loader.

Loaders cover:

- `getX`, `getXList` and singleton queries, with `where` on `_enabled` and stored fields (`eq`, `in`, ranges), `sort`, `size` and `from`.
- Elasticsearch-style `filter` with `bool`, `must`, `must_not` and `match`, which is what the real sites use (for example `filter: {bool: {must_not: {match: {isArchived: true}}, must: {match: {_enabled: true}}}}`).
- Nested relationships in both directions, assets, taxonomies, and `_id` (as `takeshape_id`), `_enabledAt`, `_createdAt` and `_updatedAt`.
- `*Html` fields, rendered as described under "Rich text".
- The list query migration: an old-format `getXList { fields }` returns a bare array.
- Pagination as tsg ran it: `paginate.data` fetches every item whatever `size` says.

Anything a loader can't express exactly, such as `terms` full-text search, goes in the report with the query file and line. The real sites use `size: 9999` and similar caps on non-paginated lists. The default list size without `size` is probably 20 but unconfirmed, and the builder confirms it from the API source.

Every page has to fit the Workers Paid plan's limits, with headroom, on the real sites. EmDash returns paired relations only through `getEmDashEntry`, one entry at a time, and on one real site a JSON endpoint loads every entry of a collection with six relations each, which could pass 1,000 D1 queries. So loaders read paired relations for a whole list through one helper that batch-reads `_emdash_content_references`. The helper lives in its own file in `src/lib/takeshape/`, is the only generated code that touches EmDash's internal tables, and has tests against the pinned EmDash version. Global context (a site-wide query and the webpack manifest) is loaded once per request and shared. Pages set `Astro.cache` from EmDash's cache hints, so repeat views come from cache and edits invalidate them. The guide states which plan a site needs.

### Templates become Astro

HTML templates become `.astro` files whose markup follows the original line for line where possible:

- `{% extends %}` and `{% block %}` become a layout component with named slots, and a block's default content becomes the slot's fallback. The translator sees every template, so `{{ super() }}` is resolved at translate time by inlining the parent block.
- `{% include %}` becomes a component. Includes with a computed name become a switch over the files that name can match.
- `{% macro %}` becomes a component, and `{% call %}` with `caller()` becomes a slot. A macro used inside an expression becomes a function.
- `for` (with `loop.*` and `else`), `if`/`elif`, `set`, `filter` blocks and `raw` keep their meaning.
- Expressions keep Nunjucks semantics: missing members print as empty instead of throwing, `~` concatenates, and `in`, `//` and `**` work as Nunjucks defines them. Calling JS methods on values (`.slice(0, 3)`, `.length`) works as before.
- Autoescape carries over: plain output is escaped, and `| safe` becomes `set:html`.

Non-HTML templates (XML, RSS, JSON, text) become functions that build the same text, called from the route's endpoint.

### Filters become helpers

Every TakeShape filter, every stock Nunjucks filter and test, and the three stock globals become a helper in `src/lib/takeshape/` with the same output as takeshape-ssg's environment. That includes the odd cases: `date(undefined)` returns now, so shape-books' `{{ now | date('YYYY') }}` prints the year. `route` on an unknown route returns `#`. `imageDefaults: {}` does not clear `auto=compress,format`. `md` lets raw HTML through. The builder chooses whether to reimplement Nunjucks's built-ins or reuse its filter source. Either way, differential tests against real Nunjucks 3.2.0 prove them.

### Rich text

TakeShape rendered Draft.js to HTML on the server (`xHtml(imageConfig, images, classPrefix, headerIdPrefix)`), and templates print that HTML with `| safe`. The real sites use `*Html` fields about 250 times. EmDash stores Portable Text, so a shared renderer turns Portable Text back into TakeShape's exact markup, which the loaders return as the `*Html` string. That markup includes `<figure class="{alignment} {size}"><img ...><figcaption>`, `<div class="oembed">`, heading ids, and image URLs sized by the query's `imageConfig`. The source is TakeShape's own Draft.js renderer and its image and oEmbed templates. Porting that code is allowed (see "Decisions Mark made"), and so is porting TakeShape's schema code to resolve queries against `schema.json`.

This needs the content converter to keep more than it keeps today (see "Content converter changes").

Markdown fields printed with `| md` render through commonmark 0.29 with raw HTML allowed. The builder picks between rendering the converted Portable Text to identical HTML and keeping those fields as Markdown text. The compare decides which one holds up.

### Images

The `image` filter returns a URL string, used in `src`, `srcset`, inline styles and meta tags, so the helper also returns a URL string. It maps imgix parameters (`w`, `h`, `fit`, `crop`, `auto`, `q`, `fm`, `dpr`) to EmDash's `/_image` endpoint backed by the Cloudflare Images binding. Parameters with no exact match, such as face cropping, go in the report with each template line that uses them. The compare checks that each picture appears at the same pixel size.

The site URL must be set at build time, or EmDash serves full-size originals. The guide explains the 5,000 free transforms a month and how a `srcset` multiplies them.

`asset` returns the EmDash media URL. Links to PDFs and SVGs must open in the browser as they did before, so the builder adds a route that serves those inline, or proves EmDash can be configured to do it.

### Global context, data files and env

`context` resolves as in tsg: query results are spread or nested by key. JSON and YAML files are parsed, and other values pass through. Arrays become index-keyed objects (ran), and the translator copies that quirk only where a template depends on it. Data and manifest files are imported at build time, because a Worker can't read files at runtime. `env` references become Cloudflare environment variables, and the report lists each one the customer must set.

### Static files and the front-end build

`static/` is copied to `public/`. The report lists the old site's build scripts (webpack and similar) and where to point their output. It also lists every reference to `takeshape.io` hosts found in static files and front-end source. For each browser call to TakeShape's API, it gives the file, the line and the GraphQL query, so the agent has what it needs to replace it.

### The report

`tsg2astro-report.md` follows `ts2emdash`'s report style. It covers: routes and the files that serve them, anything not translated (file and line, plus the construct and why), imgix parameters without an exact match, environment variables to set, front-end references to TakeShape, and the Workers plan the site needs. When it's empty apart from the route table, the translator considers the job done.

## Content converter changes

- Write `takeshape-field-map.json`.
- Take `--site <tsg.yml>` and set routed entries' slugs to their old URL values.
- Keep what the rich-text renderer needs on Portable Text image blocks: the asset id and link, the alignment and size, and the caption and credit. The builder checks whether EmDash's editor keeps unknown keys on blocks when an entry is saved, and finds another home for them if it doesn't.
- Keep oEmbed HTML when the old markup depends on it.
- Whatever the Markdown decision under "Rich text" needs.

Each change gets offline tests in the existing suite. Seeds for fixtures without `--site` stay as they are today, apart from the new image block keys.

## Compare

```
node compare-sites.mts <old site URL> <new site URL> [--urls <list>] [--out compare-report.md]
```

- URLs: start from the old site's `sitemap.xml` when there is one, plus every same-site link found while crawling both sites, plus `--urls`. Report URLs missing from either side.
- Per page: parse both, drop what's expected to differ (whitespace, comments, attribute order, the image and asset hosts), then compare the DOM structure and visible text. Show differences as a short diff.
- Links: every `href` resolves to the same path on the other site. Broken links are reported on both sides.
- Images: each image on the old page has a counterpart in the same place on the new page, and the two match in pixel size. A perceptual check catches wrong pictures.
- Non-HTML outputs (XML, JSON, RSS): compared after parsing.
- Status codes and redirects match, including 404s and trailing slashes.
- TakeShape leftovers: every HTML, JS, CSS and JSON file the new site serves is scanned for `takeshape.io` hosts, and any hit fails the compare. That catches browser code still calling TakeShape while the old API answers, without running a headless browser. (My call.)

The reference is the old site as deployed. Before exporting, the migration skill has the customer freeze edits in TakeShape and run one last deploy there, so the live site, the code and the export all match. The agent asks the customer before triggering that deploy, since it touches their production site. (My call.)

For the real sites in our own tests, the reference is the live site when the code on disk is what's deployed. Otherwise it's a fresh takeshape-ssg 12.21.1 build of the code on disk against the live TakeShape API, made by January 15 and kept as a golden. (My call.)

The compare must run before anything is public, against the new site running locally on the migrated content, and again against the deployed site. The builder picks the local setup: `astro dev` on Cloudflare's local bindings with the content loaded through site transfer, or something simpler that gives the same pages. Crawling is polite: limited concurrency and a delay setting.

## Agent skills

Two skills in `emdash/skills/`, in the Agent Skills format (`SKILL.md` plus references):

- `migrate-takeshape-site`: the end-to-end steps, which commands to run, what to check after each, and when to stop and ask the customer (account logins, plan choice, DNS).
- `resolve-takeshape-site-report`: for each kind of report or compare item, how to fix it in the generated Astro files, and that every fix gets confirmed by rerunning the compare. It never edits the translator. It includes a worked playbook for browser calls to TakeShape: add an endpoint to the new site that answers the same query from EmDash with a loader, point the front-end code at it, drop the TakeShape token, rebuild the front end, and rerun the compare until the TakeShape scan is clean.

Both follow the guide's rules: self-serve only, nothing that invites the customer to contact TakeShape, and pointers to EmDash's docs and Discord where those help.

## Testing

1. Differential tests for the template translation. For each Nunjucks construct, each stock filter and each TakeShape filter, run the input through real Nunjucks 3.2.0 with takeshape-ssg's filters and through the translated Astro output, using the same context, and compare. These run offline in `npm test`.
2. Starter sites. TakeShape's starters on GitHub (`takeshape/takeshape-starter-{blog,books,jobboard,portfolio,shop,startup}`) match the content of our shape-* fixtures. Each starter's templates plus its fixture export make a full test site. Golden output comes from building the starter with takeshape-ssg against a TakeShape project holding that content, by January 15. Goldens are committed so the tests keep working after shutdown.
3. Real sites: two customer sites and takeshape.io, all on disk. Translate each one, run it on its exported content, and compare it against the reference described under "Compare". For the larger customer site, Mark runs the takeshape-ssg build locally when the work reaches that point. Customer sites are tested locally only: those tests skip when the data is missing, and nothing from those sites (code, exports, crawls, goldens) is committed, since customers download from this repo. (My call.)
4. Cloudflare: deploy at least one starter and one real site to a Cloudflare test account and compare against the deployed URL. Measure CPU and D1 queries per page.

The builder decides where goldens and crawl outputs live, following the existing `test/` layout.

## Guide

A new section in `emdash/README.md` (mirrored in the Claude doc) for takeshape-ssg sites: when it applies, the agent-driven path, the same steps by hand, the report and the compare, Workers plan and image transform limits, and cutover. Add a row to the top-level `README.md`. Record in `CLAUDE.md` only what a run in this repo showed.

## Order of work

Mark needs this as soon as possible, so the plan builds one site end to end before widening (my call on the order):

1. One starter, shape-books with `takeshape-starter-books`: translate it, compare it locally, deploy it to Cloudflare and compare again.
2. The larger customer site, including the agent handoff for its browser calls.
3. The other customer site and takeshape.io.
4. Constructs and filters no real site or starter uses, driven by the differential tests.

The skills and the guide section grow with each step, so a customer whose site looks like a finished one can start early.

## Open items

The plan raises these with Mark when it reaches them:

- TakeShape projects holding the starter content, needed to build starter goldens by January 15, and whose account they live under.
- Exports of the other customer site and takeshape.io.
- A Cloudflare test account with Workers Paid and Images for the deploy tests. `CLAUDE.md` notes the R2 work is waiting on the same thing.

## Left to the builder

- How the translator represents templates between parsing and output.
- The exact file layout and naming of generated pages, components and loaders, as long as a developer can find the file behind any URL.
- Neighbor lookups for `previousItem` and `nextItem`, and the page count for listings, within the per-request limits.
- The local setup for the compare, and how the guide sequences the content import into it.
- How the compare matches images on a page and how strict its perceptual check is.
- Whether the generated project uses the Cloudflare adapter's Workers Cache.

## Appendix A: takeshape-ssg behavior to reproduce

Each item is read from takeshape-ssg 12.21.1's source, and from takeshape-routing's for paths and image URLs. "(ran)" marks behavior observed by running the built SSG.

**tsg.yml**. No schema, and unknown keys are ignored. Defaults: `templatePath: templates`, `staticPath: static`, `buildPath: build`, `locale: en-us`, `dates: {tz: America/New_York, format: LLL}` (the example sites write `dates.timezone`, which is ignored), `numbers: {format: ","}`, `imageBaseUrl: https://images.takeshape.io`, `assetBaseUrl: https://assets.takeshape.io`, `imageDefaults: {auto: "compress,format"}`. `locales.<code>` builds the whole site once per locale with a `pathPrefix`; none of the real sites use it. A missing `${env.X}` fails the build (ran).

**Paths**. Variables are `:name` or `{name}` with dot paths, and each value goes through `slugg`. A falsy value gives an empty segment and a warning. A path containing `.` is a file name; otherwise `index.html` is appended. A trailing slash in `path` carries into `route` output (ran).

**Paginate**. `data` (a query file, or `{query, variables}`) or `property` (a top-level context key holding a real array). `pageSize`, `path`, `template`, `firstPage`, `itemName`. Item pages need `path` and `template`. Listing pages need `pageSize`, `paginate.template` and `paginate.path`. `totalPages = ceil(total / pageSize)`. Items whose path is empty are skipped for item pages but stay in listings (ran). `firstPage` changes only the output path; `1 | route('posts.paginate')` still returns `/posts/page-1/` (ran).

**Template variables**. Global and route context spread at the top level, plus `global`, `env`, `environmentVariables`, `locale` and `currentPath`. Item pages add `item`, the `itemName` alias, `previousItem`, `previousPath`, `nextItem` and `nextPath`. Listing pages add `items` and `pagination.{currentPage,totalPages}`. No globals are added; `now` is undefined.

**Queries**. Named only in `tsg.yml`: a string ending in `.graphql`, or `{query, variables}` (which also accepts `.gql`). A bare `foo.gql` string is not queried (ran). A query with GraphQL errors fails the build. The pagination iterator needs exactly one paginated field, strips the user's `size` and `from`, and fetches 100 at a time.

**Filters**. `image(key, params)`: key is a path string, `{path}` or `{s3Key}`; URL-encoded path segments; query keys sorted; `''` and `undefined` values dropped; an empty path returns `''`. `asset(key)`: `{assetBaseUrl}/{path}`. `route(obj, name)`: `name` is a lodash path into `routes`, and an unknown route returns `#`. `date(value, fmt | {format, tz, locale})`: `moment.utc(value).tz(tz).locale(locale).format(fmt)`, and `null` prints `Invalid date` (ran). `md`: commonmark 0.29 with default options. `number`/`numberFormat`: d3-format with a 52-locale table. `code`: Prism, returning safe markup. `pluralize`: pluralize 8.0.0. `union`/`intersection`: lodash `unionBy`/`intersectionBy`.

**Nunjucks**. `new Environment(loader)` with no options: autoescape on, `throwOnUndefined` off, `trimBlocks` off. Every template name resolves from the `templatePath` root, and any file type can be included. Only stock filters and tests, plus the globals `range`, `cycler` and `joiner`. There are no `select`, `reject` or `map` filters (ran).

**Output**. Minify (`.html` only) runs before gzip. The CLI copies `static/` while pages build, so which file wins a collision is undefined. TakeShape's production publish uploads static files first and pages second, so pages win. Production forces `usageStats`, which adds `_id` to every selection set, so JSON written with `| dump` on deployed sites carries extra `_id` fields.

**Public sources.** `github.com/takeshape/takeshape-starter-books` has `tsg.yml`, templates and static files. `github.com/takeshape/patterns` holds schemas and data only.
