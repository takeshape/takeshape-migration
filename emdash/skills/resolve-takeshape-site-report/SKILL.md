---
name: resolve-takeshape-site-report
description: Fixes what tsg2astro-report.md, the ts2emdash content report and compare-sites list for a site moved from TakeShape's static site generator (takeshape-ssg) to EmDash, in the generated Astro files, and confirms each fix with the compare. Covers every report section, every compare difference kind (missing, extra, status, redirect, content, broken-link, image, image-rules, takeshape-host) and browser code that calls TakeShape's API. Use when a report lists an item or a compare exits 1 for a project tsg2astro generated.
---

# Resolve a tsg2astro report item or a compare difference

A project tsg2astro generated is a normal Astro site on EmDash. Fix each report item and each compare difference in its generated files, then run the compare again to confirm it. You're done when the compare exits 0 and every item under "Links to TakeShape-hosted files" in either report is resolved: each file re-hosted and its links updated, each `api.takeshape.io` call or `package.json` script replaced. That list counts on its own: the compare scans only the files its crawl reaches, so a script it never loads can still call TakeShape. To confirm, run `grep -rn 'takeshape\.io' public src` in `<out>`. It must find nothing but links to TakeShape's website (`takeshape.io` or `www.takeshape.io`).

A route at `/404` or `/500` may leave one compare difference each. When the Routes notes in `tsg2astro-report.md` list a route there and the old site answered that path with 200, the compare lists the path as `missing` and doesn't compare the two pages. Accept that difference only when the new site answers `/404` with 404 or `/500` with 500, and only after you've checked by hand that the new page matches the old one (`curl -s <old-url><path>` against `curl -s` of the same path on the site you compared). Any other status there means the page fails: fix it like any other `missing` page in `references/compare-differences.md`. Tell the customer about each difference you accept. Every other difference needs a fix.

An `image-rules` difference may stay too, after you've shown it to the customer: when the report's Image parameters section names that parameter and the customer accepts the difference, or when it's a gap in this repo's imgix rules, which the project can't fix. `references/compare-differences.md` says how to tell them apart.

## Rules

- Never edit tsg2astro, ts2emdash or anything else in the takeshape-migration checkout. Fixes go in the generated project.
- Commit the project before your first fix, and commit each fix. tsg2astro rewrites `src/pages`, `src/routes`, `src/templates`, `src/loaders`, `src/lib/takeshape` and `public` when it runs, so never run it over this folder again. If you have to, run it into a new folder and carry your commits across.
- Fix one difference at a time, at its source: the template, loader or route module behind the URL. A fix that only changes what one page prints for one entry is the wrong fix.
- Fix content mistakes in EmDash's admin (`/_emdash/admin`).
- Never make the compare pass by hiding a real difference. `--ignore-text` is only for text that comes from the clock (see "content" in `references/compare-differences.md`), with a pattern that matches that text and nothing else. Tell the customer about every pattern you add.
- Never touch `src/lib/takeshape/` to fix one page. Those helpers copy takeshape-ssg's behavior for every page. If one of them looks wrong, show the customer the difference and the helper, and ask.
- If you can't fix something, say so, with the compare's detail line and what you tried.

## Where things are

| Path | What it holds |
| --- | --- |
| `tsg2astro-report.md` | The route table (URL patterns and the files behind them), plus everything tsg2astro couldn't carry over. |
| `takeshape/content-report.md` | What ts2emdash did with the content: the field map, renamed slugs, rich text kept as text or HTML, links into TakeShape's CDN. |
| `takeshape/takeshape-field-map.json` | Each TakeShape shape and property, and the EmDash collection and field it became. |
| `src/pages/` | One page or endpoint per URL pattern. Each asks a route module for the page and renders a template. |
| `src/routes/<route>.ts` | One per `tsg.yml` route. It loads the data, finds the page for a URL (none means a 404) and builds the template's context. `_global.ts` loads the context every page sees. |
| `src/templates/` | The old Nunjucks templates, file for file: `templates/pages/book.html` is `src/templates/pages/book.astro`. HTML templates are Astro components, other templates `render()` functions. |
| `src/loaders/` | One per GraphQL query, file for file. Each reads EmDash and returns the shape TakeShape's API answered with, so the templates keep their expressions. |
| `src/lib/takeshape/` | TakeShape's filters (`filters.ts`), Nunjucks behavior (`nunjucks.ts`), the rich-text renderer (`richtext.ts`), the page rules (`context.ts`), the EmDash reads (`query.ts`, `emdash-api.ts`) and the `tsg.yml` settings (`site.ts`). |
| `src/middleware.ts` | Serves `<folder>/index.html` with the page at `<folder>/`. |
| `public/` | The old `static/` folder. |
| `frontend/` | The old site's front-end source, once you move it in (see "The front end"). Its build writes into `public/`. |

The generated markup follows the old template line for line where it can, so open the old template next to the generated one. The old site's folder still has them.

## Names

The commands below use these names. Replace each with its full path or URL. If the `migrate-takeshape-site` skill set up the move, they match its names.

| Name | What it is |
| --- | --- |
| `<out>` | This project, the folder with `tsg2astro-report.md`. |
| `<repo>` | The takeshape-migration checkout with the scripts. If it isn't on disk: `git clone https://github.com/takeshape/takeshape-migration.git`, then `npm install` in its `emdash/` folder. |
| `<work>` | A folder for reports and logs, outside `<out>`. Its parent works. |
| `<site>` | The old site's folder, the one with `tsg.yml`: its templates and front-end source. |
| `<old-url>` | The old site as the compare reads it: the live site, or a folder holding its built output. |
| `<new-url>` | The deployed new site, once there is one. |
| `<account>` | The Cloudflare account ID the site deploys to, from `npx wrangler whoami`. It isn't a secret. Without a terminal, Wrangler stops when the login sees more than one account and none is set. |

## Confirm each fix

Rebuild, restart the server the compare ran against, and run the same compare again, with the same `--ignore-text` if it had one:

| Where you compared | Rebuild, then restart | Compare |
| --- | --- | --- |
| Node mode | `npm run build:node`, then `npm run start:node` | `node <repo>/emdash/compare/compare-sites.mts <old-url> http://localhost:4321 --out <work>/compare-node.md --media <out> --image-index <out>/takeshape/image-index.json` |
| Cloudflare's local runtime | `npm run build`, then `npx astro preview --ignore-lock` | the same, into `<work>/compare-cloudflare.md` |
| Production | `CLOUDFLARE_ACCOUNT_ID=<account> npm run deploy` | the same with `<new-url>`, into `<work>/compare-production.md` |

Run each server in its own process group, so one command stops it with everything it started (on Cloudflare's runtime that includes workerd). Start, wait for a 200, then stop when you rebuild:

```bash
cd <out>
bash -c 'set -m; npm run start:node > "$1" 2>&1 & echo $! > "$2"' _ <work>/server.log <work>/server.pid
i=0; until [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4321/)" = 200 ]; do i=$((i+1)); [ $i -ge 120 ] && echo "not ready" && break; sleep 1; done
kill -TERM -- -$(cat <work>/server.pid)
```

After the stop, `pgrep -fl workerd` must list nothing from `<out>/node_modules`. To serve on another port, set `EMDASH_SITE_URL` in `.env` to that address before building, and pass `--port` (or `PORT=` for `start:node`).

Exit 0 means no differences. Exit 1 means some remain, or the crawl stopped at its page cap. Exit 2 means a site didn't answer. The difference you fixed must be gone, and no new one may appear.

## The items

- `references/report-items.md`: one section per section of `tsg2astro-report.md`, then the content report.
- `references/compare-differences.md`: one section per kind in the compare report's Summary table, then the compare's Notes and its list of links to TakeShape's website.

## The front end

Some sites build their own CSS and JavaScript (webpack, Sass, a `package.json` whose scripts build into `static/`). That build moves into the new project, `<out>/frontend/`, and writes straight into `public/`. The old site's folder is dead after cutover, so a fix made there has no home. Move the front end before your first fix to browser code, to image URLs it builds, or to its CSS:

1. Copy the front end's source into `<out>/frontend/`: its scripts, styles and images, the build config, `package.json` and the lockfile. Leave out `node_modules/` and the built files. Also copy the files the build reads from elsewhere in the old site's folder, at the same paths under `frontend/`: fonts the stylesheets name as `/static/fonts/...`, for example.
2. Point the build's output at `public/`, at the path `static/` had: a webpack that wrote `static/assets/` now writes `../public/assets/`. The templates link the same paths as before.
3. If `tsg.yml` reads a file the build writes, such as a `manifest.json` with the hashed bundle names, the Notes in `tsg2astro-report.md` name the copy pages read, under `src/routes/_data/` (`src/routes/_data/static/assets/manifest.json.json` for `static/assets/manifest.json`). Add a small script the build runs last that creates that folder and copies the new file there. Until it does, pages link the old bundle.
4. If the code imports `tsg.yml` for its routes, as takeshape-routing's `route()` needs, write the routes into `frontend/routes.json` as `{ "routes": { "<name>": { "path": "<path>" } } }` and import that. `route()` reads only each route's `path`, and the YAML loader can go.
5. Drop the TakeShape CLI and the scripts that call it (`takeshape build`, `takeshape deploy`, `takeshape watch`), plus tools that only served that build, such as browser-sync on `build/`. Keep linters and the type check.
6. If the build type-checks as it bundles (webpack's `ts-loader` without `transpileOnly`), set `transpileOnly: true` and run the type check as a script of its own (`tsc --noEmit`). On one site, ts-loader type-checked plain-JS components and failed some builds and not others, with a different bundle hash each time. With `transpileOnly`, three builds in a row gave the same bundle.
7. Build it, check that `public/` got the new files, and commit `frontend/` with the project.

Build order: tsg2astro owns `public/` and copies the old `static/` into it on every run, so build the front end after any tsg2astro run, then run rehost, then build the site. After each change to the front end, build it before `npm run build` or `npm run deploy`: they ship what `public/` holds.

## Browser code that calls TakeShape

Some sites fetch content in the browser straight from TakeShape's API: search, filtered lists, "load more" buttons. That code keeps working until January 15, then those blocks go blank. The compare flags it as `takeshape-host` on every JavaScript or JSON file that names `api.takeshape.io`. Replacing them is planned work for you. Replace each call:

1. Add an endpoint to the new site that answers the same query from EmDash with a loader.
2. Point the front-end code at it.
3. Remove the TakeShape token.
4. Rebuild.
5. Rerun the compare until the `takeshape-host` scan is clean, and check each page in a browser.

In detail:

1. Move the front end into `<out>/frontend/` first, as "The front end" says. Then find each call: `grep -rn 'takeshape.io' <out>/frontend <site>` searches the moved source and the old site's whole folder. Also read the `takeshape-reference` lines in `tsg2astro-report.md`. For each call, note the GraphQL query it sends, its variables, and which fields of the response the code reads. Then find the pages that run it: a component's tag can sit inside an HTML comment in a template, and a query TakeShape rejects (a variable of the wrong type) never filled its block. Tell the customer about each such call before you make it work.
2. Plan a loader for each query. Copy the query into a file, with the values the browser sent wherever it held a variable (`_id: "<an id from a page>"`, `from: 0`, `size: 12`, the filter written out), and run:

   ```bash
   node <repo>/emdash/tsg2astro/plan-query.mts <query.graphql> --export <the export> --field-map <out>/takeshape/takeshape-field-map.json --out <out>/src/loaders/browser/<name>.ts
   ```

   It writes the loader tsg2astro writes for a `tsg.yml` query, every field mapped through the field map, and prints what it left out, such as a `should` or a `must_not` on `_id`. Then edit the loader: take the request's values in `load`'s second parameter (`_variables`), put them where the literals landed (`getEntry(api, "categories", "<an id>", ...)`, `size: 12, from: 0`), and apply what it left out yourself, in the loader. A page prints an entry's `_id` as its TakeShape id, or as EmDash's own id for an entry made after the move, and `getEntry` looks up the TakeShape id only, so fall back to `api.entry(collection, id)` when it finds nothing.
3. Add an endpoint in `src/pages/`, such as `src/pages/api/browser/stories.json.ts`. Answer `{ data }` in the shape TakeShape's API did, so only the request changes, and answer 400 for values TakeShape refused (`size` above 250):

   ```ts
   // src/pages/api/browser/stories.json.ts: what the stories component asked TakeShape's API for, read from EmDash
   import type { APIRoute } from "astro";
   import { emdashApi } from "../../../lib/takeshape/emdash-api.ts";
   import { load } from "../../../loaders/browser/stories.ts";

   export const GET: APIRoute = async ({ url }) => {
   	const size = Number(url.searchParams.get("size") ?? 20);
   	const from = Number(url.searchParams.get("from") ?? 0);
   	if (!Number.isInteger(size) || size < 0 || size > 250 || !Number.isInteger(from) || from < 0) {
   		return Response.json({ errors: [{ message: "size must be 0 to 250, from 0 or more" }] }, { status: 400 });
   	}
   	return Response.json({ data: await load(emdashApi, { id: url.searchParams.get("id"), size, from }) });
   };
   ```

   Search (`terms` in a list query) needs one step more. TakeShape matched the words as a phrase, the last one as a prefix, over every text field of the shapes the query listed, and answered no terms with every entry. Find the entries with EmDash's `search()` (`import { search } from "emdash"`) over those shapes' collections, with `status: "published"` and a `limit` above any collection's size, and put a query of more than one word in double quotes so it matches as a phrase. Then list the hits with the planned loader, adding `id: [<the hits' ids>]` to each list's `where`. `search()` covers only collections whose search is on. If `emdash seed` printed "Failed to enable search for <collection>", that collection finds nothing, and a site transfer carries it into production that way: fix it as the content report section of `references/report-items.md` says, before you export the site.
4. Point the front-end code in `<out>/frontend/` at the endpoint: replace the POST to `api.takeshape.io` with a GET to `/api/browser/stories.json`, the variables as query parameters, and delete the GraphQL text and the filters the code no longer sends. Keep the code that reads the response. One small helper (`fetchData(name, params)`, building the query string) keeps each call to one line.
5. Delete the TakeShape API key and endpoint from the front-end code and its config. The customer revokes the key in TakeShape at cutover. Fix the image URLs the same code builds while you are there: see `takeshape-host` in `references/compare-differences.md`.
6. Build the front end in `<out>/frontend/` with its own build command, which writes into `public/` and copies its manifest (see "The front end"). Never edit the built files in `public/`: the next build replaces them. Then run rehost again, and rebuild the site. Never rerun tsg2astro into this folder to pick up the build: it deletes all of `src/pages/` and `src/loaders/` first, the endpoints and loaders from steps 2 and 3 included.
7. Rerun the compare until it reports no `takeshape-host` difference. Put the bundle's new path (`/assets/javascripts/main.<hash>.js`) in the `--urls` file: the compare scans a script only when it is listed. The compare runs no scripts, so also open each page in a browser and check that each block fills in from `/api/browser/...`, that its images load, and that the network log has no request to a `takeshape.io` host. Click through what only shows on demand: "load more" buttons, tabs, hover panels.
8. While TakeShape's API still answers, send it each old query and the new endpoint the same values, and compare the two answers as data. Entries in another order that share their date are fine: Elasticsearch broke those ties in an order nobody can repeat. Entries TakeShape listed that are drafts in EmDash are left out, as on every page (see "content" in `references/compare-differences.md`). Anything else is a bug in the loader.

This playbook ran on a large site's browser code (2026-10-19), including a search over many shapes. Tell the customer what you changed, call by call.

## Help

The new project's `building-emdash-site` skill covers EmDash queries, Portable Text and images. EmDash's docs are at https://docs.emdashcms.com, also as an MCP server at https://docs.emdashcms.com/mcp, and the EmDash community is on Discord at https://discord.gg/YY9vBaQRYt.
