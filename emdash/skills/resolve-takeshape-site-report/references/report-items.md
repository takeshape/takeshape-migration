# Report items

One section per section of `tsg2astro-report.md`, in the order the report prints them, then the content report. Each says what the item means, how to fix it in the generated files, and how to confirm the fix. "Confirm" always means: rebuild, restart, run the compare (see "Confirm each fix" in `SKILL.md`), and check the paths named.

To find the paths a file serves, look it up in the report's route table.

## Routes: the notes under the route table

These say how some URLs are served, and where that differs from the old site. Most need nothing.

- Routes whose URLs overlap: one page file tries each route in `tsg.yml` order and serves the first that has a page, as takeshape-ssg kept the first route's page. Nothing to fix unless the compare reports one of those URLs.
- "Route X also writes this file. Its page is served": a file in `static/` had the same path as a page. TakeShape's publish uploaded pages last, so the page won, and the static file is left out of `public/`. Nothing to fix.
- "On TakeShape the page won; here the static file in public/ wins": a page might have been written at a static file's path. If the compare reports `content` on that path, delete the file from `public/`.
- "Route X serves /404": the site's own route took `src/pages/404.astro`, the page Astro shows for unknown URLs, so the site's page answers those too. Astro answers `/404` itself with status 404. If the old host answered it with 200, the compare lists `/404` as `missing` ("Old answers 200, new answers 404") and skips its content. That difference may stay when the move is done, but only with status 404 and once you've checked by hand that the page matches the old one (see `SKILL.md`). Any other status at `/404` means the page fails.
- "Route X writes /404.html": unknown URLs get the generic page in `src/pages/404.astro`, where many old hosts served the site's `404.html`. To serve the site's page instead, replace the generic page's body with the route's template and context, using the route module and template the note names:

  ```astro
  ---
  import { emdashApi } from "../lib/takeshape/emdash-api.ts";
  import { page } from "../routes/<route>.ts";
  import Template from "../templates/<template>.astro";

  const context = await page(emdashApi, "/404.html");
  ---
  <Template {...context} />
  ```

  Astro sends this page with status 404.
- "Route X serves /500/, where Astro keeps its server-error page": Astro answers that URL with the route's page and status 500, and shows the same page whenever another page fails with an error. If the route is the site's error page, nothing to do. If the old host answered it with 200, the compare lists the path as `missing` ("Old answers 200, new answers 500") and skips its content. That difference may stay when the move is done, but only once you've checked by hand that the page matches the old one (see `SKILL.md`), because the status can't tell a working page from a broken one here. Any other status at that path means the page fails. The page reads EmDash like every other, so when EmDash fails, that page fails too and Astro sends an empty 500.
- "Route X serves /3xx, where Astro keeps its redirect page": nothing to do. Leave `experimental.redirectPage` out of the Astro config, or Astro turns that page into the body of its build-time redirects.

Confirm: the compare reports nothing on the URLs the note names.

## Not translated

A table with four columns: File, Line, Construct, What happened. The last column says whether the construct was left out of the generated file or copied into it as raw HTML. Fix each row by hand where it says, grouped by what File holds.

### A template (`pages/book.html`, `partials/footer.html`)

Open the old template at Line and the generated file next to it (`src/templates/pages/book.astro`). Write the Astro for the construct:

- A Nunjucks tag inside an HTML start tag or attribute, or a branch that ends inside an element ("copied as raw HTML"): rebuild the element with Astro expressions, for example `class={isActive ? "active" : undefined}` or `href={...}`.
- `| safe` or `| escape` that isn't the last filter: compute the value in the frontmatter, then print it with `<Fragment set:html={value} />` for HTML or `{value}` for text.
- A `block` the component can't fill (declared above the layout it extends, reading the layout's variables or loop variables, setting variables in a loop, or placed inside an HTML tag): pass the values the block needs as props, or move the block's markup into the layout.
- An `include` shared by an HTML and a text template, or one that sets variables inside a loop: copy the partial into a second file for the other kind, or turn the variables into the return value of a function.
- A `set` left out: compute the value in the frontmatter and use it where the template read it.
- A tag tsg2astro doesn't translate yet, such as `super()` or `caller()`: write the markup it produced.
- "Template not found", "Nunjucks could not parse this template", or a template name computed at build time: check the old template first, since takeshape-ssg failed on those too. For a computed name, import each template it can name and pick one with a `switch` over the same value.
- "both become src/templates/..., so neither is written" (with three or more files, "become src/templates/..., so none of them is written"): two or more templates map to one generated file, such as `partials/extra.html` and `partials/extra.njk` (both `extra.astro`), or a file under the templates folder's `_site/` and the site file it mirrors. Translate each by hand into a file of its own, such as `src/templates/partials/extra-njk.astro`, and import it at every line the report names.
- `env` or `environmentVariables` ("takeshape-ssg passed the build's environment variables here"): pages pass an empty object there. Read the value with `getSecret` from `astro:env/server` in the route module, pass it to the template, and set it as a Cloudflare variable or secret.

Confirm: the pages that use the template (the route table names them) show no `content` difference at those lines.

### A query (`data/posts.graphql`)

The loader is `src/loaders/data/posts.ts`. It lists entries with the helpers in `src/lib/takeshape/query.ts` and returns TakeShape's response shape. `takeshape/takeshape-field-map.json` gives the EmDash name of each TakeShape field.

- A condition, filter or sort left out ("this list may hold entries TakeShape left out"), full-text `terms`, or a status condition that "could not be read exactly": apply it in the loader, on the entries `listEntries` returns, before it builds the response. Keep TakeShape's rules: a list without `size` returns at most 20 entries, newest `_createdAt` first.
- An argument that takes a variable: loaders get the variables from `tsg.yml`, and `load(api, variables)` ignores them. Apply the variable's value in the loader yourself.
- A field left out because EmDash keeps no such thing (an asset's caption or credit, a term's extra fields): it can't come back from EmDash. Tell the customer which pages print it.
- A field left out that EmDash does keep (a repeater, a field the converter skipped): read it from `entry.data`, or with `references(api, collection, entries, field)` for a reference, and add it to the response under TakeShape's name.
- "has no literal _id": the query asks for one entry by a variable. Pass the id in from the route module and look it up with `getEntry`.
- "Only the first query in a file is translated": write a loader for each other query, and call each where the route module builds its context.
- "The query could not be parsed": check the query in the old site. takeshape-ssg failed on it too.
- `routes.<name>.paginate.data` ("pages through a query only when it lists exactly one paginated list"): the route has no item or listing pages. Write them by hand, as for `paginate.property` below.

Confirm: the pages the query feeds show no `content` or `missing` difference.

### `tsg.yml`

- `paginate.property`: the route has no pages. Write them by hand: copy a generated route module and page that work the same way (item pages, listing pages, or both), and change the data source.
- "The route needs both path and template": takeshape-ssg couldn't build that route either, so the old site has no page for it. Nothing to fix unless the compare reports one of its URLs `missing`.
- "answers the same URLs as ... only route X is served there": two routes give the same URL pattern as different kinds of file (an HTML page and an XML feed, say), and one Astro file serves only one kind. The later route has no pages. If the compare reports its URLs `missing` or different, serve both from one endpoint that tries each route in `tsg.yml` order and answers with the first that has a page.
- "a URL both could answer goes to whichever file Astro picks": two routes of different kinds can give the same URL. Check the compare on those URLs. Where the wrong route answers, make the file Astro picks try the other route first, as the generated overlap pages do with `answer()` from `src/lib/takeshape/context.ts`.
- A path with variables on a route that doesn't paginate: takeshape-ssg wrote that path as it stands, braces included. If the compare reports it `missing`, add a page at that literal path.
- An HTML template on a path with another extension: write an endpoint (`src/pages/<path>.ts`) that renders the template to a string and returns it with the old Content-Type.
- `locales`: only the default locale is translated. Pages under other locales' path prefixes show up as `missing`. EmDash's internationalization guide covers adding locales: https://docs.emdashcms.com/guides/internationalization/
- "The data file X is not translated yet": copy the file into `src/data/`, import it in `src/routes/_global.ts` (global context) or the route's module, and add it to the context under the same key. Convert YAML to JSON once, by hand, if it's YAML.
- "The query files X and Y both become src/loaders/..., so neither has a loader" (with three or more, "so none of them has a loader"): write a loader for each by hand under a name of its own (a generated loader is a good start), and call it in the route module that used the query.
- "Route X serves /path/ with T, but T and U both become src/templates/..., so neither is written and /path/ has no pages" (with three or more files, "so none of them is written"): two or more template files map to one generated file, such as `pages/extra.html` and `pages/extra.htm`, so the route lost its template. If you haven't edited the project yet, rename all but one of those files in a copy of the old site, change every `tsg.yml` line and include that names them, and run tsg2astro on that copy into a new folder. Otherwise, write the route by hand: translate each template into a file of its own, such as `src/templates/pages/extra-htm.astro`, then copy a generated route module and page that work the same way (a plain page, item pages or listing pages) and point them at that template.
- "The query file X was not found": restore the query file in the old site and write its loader by hand, or remove it from the context with the customer's OK.

Confirm: the URLs of that route show no `missing` difference.

## Image parameters

An image that passes `w` or `h` goes through the site's image endpoint, `/_takeshape/image`: `src/lib/takeshape/imgix.ts` maps imgix's parameters, `src/image-endpoint.ts` runs it on Workers with Cloudflare's Images binding (files over 20 MB through `fetch()` with `cf.image`, `src/lib/takeshape/image-fetch.ts`), and `src/image-endpoint-node.ts` runs it on Node with sharp. It honors `w`, `h`, `dpr`, `fit`, `crop`, `fp-x`, `fp-y`, `bg`, `fill`, `fill-color`, `flip`, `fm`, `auto` and `q`, and ignores the rest. Rich-text images follow the same rules with only the parameters their query passes: `imageDefaults` doesn't apply to them. Each row names a parameter or value the endpoint ignores, and where it's passed:

- A template and line: an `image` filter passes it, as in `image({w: 400, blur: 20})`.
- A query and line: a rich-text `...Html` field passes it in `imageConfig` or `images`.
- `tsg.yml`: `imageDefaults` sets it for every image.
- "could not read": the `image` filter's parameters sit in a variable. Find what the variable holds in the template, and treat each parameter in it as above.

A value the template computes isn't listed, since whatever it holds reaches the endpoint as it reached imgix. `fit: crop` with `crop` unquoted is a variable nothing defines, so neither imgix nor the endpoint got `fit`, and nothing changes.

Fixes:

- `fit: 'facearea'` or `fit: 'clamp'`: the endpoint resizes as `clip` does. `fit: 'crop'` with `crop: 'faces'` comes closest to facearea.
- `fill: 'blur'` or `fill: 'gen'`: the endpoint pads with a solid color. Set `bg` to the color that suits the page.
- An effect the endpoint doesn't do (`blur`, `sat`, `mark`, `txt` and the like) that matters to the customer: apply it once to the original, upload the result to the EmDash media library, and point the entry at it. That's a content change, so ask the customer.
- `fm` the endpoint ignores (`jxl`, `json`): drop it. Images go out as WebP.

Confirm: the compare's `image` lines for those pages are gone.

## Environment variables

- `env.NAME`: `tsg.yml` reads it when it loads, and tsg2astro wrote the value it had into the generated files. If the value was wrong or changes, find it with `grep -rn '<old value>' src` and change it there. Setting the variable later changes nothing, and tsg2astro must not run over the project again.
- `env.NAME` holding a secret (an API key, a token): it must not stay in `src/`, which gets committed. Ask the customer to store it with `npx wrangler secret put NAME`, replace the value in `src/` with a read of `getSecret("NAME")` from `astro:env/server` in the route module that builds the context, and check that the old value is gone with `grep -rn '<old value>' src`. For Node mode, put it in `.env`, which `npm run start:node` loads. `.env` stays out of git.
- `EMDASH_SITE_URL`: the site's address. Put it in `.env` before you build: EmDash's own `Image` component resizes only when it's set. The translated pages' images go through `/_takeshape/image` and don't need it. Steps 4 and 8 of the migrate skill set it.

Confirm: the pages that print the value show no `content` difference.

## Links to TakeShape-hosted files

Files in `static/` (now `public/`) and scripts in the old site's `package.json` that name a `takeshape.io` host. They stop working after January 15.

- An image or file URL in CSS, JavaScript or HTML under `public/`: download the file while TakeShape's CDN is still up, save it under `public/`, and change the URL to the local path. Download the exact URL the file names, query string included, so the picture keeps the size the old site showed. A file the front end builds (its CSS or JavaScript bundle) gets the change in its source in `<out>/frontend/` instead: see `takeshape-host` in `compare-differences.md`.
- `api.takeshape.io` in front-end code: follow "Browser code that calls TakeShape" in `SKILL.md`.
- A `package.json` script that calls TakeShape: the old site's own build fetched from TakeShape. Point it at the new site's endpoints, or drop it with the customer's OK. Scripts that run TakeShape's CLI (`takeshape build`, `takeshape deploy`) go when the front end moves into `<out>/frontend/`.

Confirm: the compare reports no `takeshape-host` difference on those files, and `grep -rn 'takeshape\.io' public src` in `<out>` finds nothing but links to TakeShape's website (`takeshape.io` or `www.takeshape.io`).

## Queries

Notes where a loader answers differently from TakeShape's API, even though the page may not show it.

- "returns the field's Portable Text from EmDash. TakeShape returned Draft.js JSON here": code that reads the raw rich-text field (not its `...Html` field) now gets Portable Text. If a page prints it, print the `...Html` field instead, or render it with `PortableText` from `emdash/ui`.
- "lists published X entries only. X has no workflow (apiVersion 1), so TakeShape listed drafts here too": if the old page showed a draft there, the compare reports it. Ask the customer whether to publish that entry in EmDash.
- "This query is used with other variables in ...": one loader serves both uses, with the variables of the first. Write a second loader for the other use and call it from that route module.
- "The field map has no TakeShape ids and dates": the content was converted with `--no-legacy-fields`, so lists come in EmDash's order and lookups by TakeShape id fail. Converting again without that flag fixes it, which means redoing the import. Ask the customer.
- "is kept as JSON": the loader returns the stored value whole. If a template reads sub-fields by other names, map them in the loader.
- "description comes from the image's alt text": nothing to do unless the compare shows a different description.

Confirm: the pages the query feeds show no difference.

## Notes

Things worth knowing, such as a site with no `static/` folder, or the old site's own build scripts. If the old site's front-end build wrote into `static/`, move the front end into `<out>/frontend/` ("The front end" in `SKILL.md`), where its build writes into `public/`.

## The content report (`takeshape/content-report.md`)

- "Needs your attention":
  - A slug that changed (`post-a` became `post-a-2`): two entries shared a slug. It matters only where a route builds its URLs from the slug (`:slug` in its path). There the compare reports the old URL `missing`: fix the slug in the admin. A route that builds its URLs from another field (`/blog/:title/`) keeps its pages where they were.
  - Relationships to entries missing from the export were dropped. The old site printed nothing for them either, so there's usually nothing to do.
  - Rich text kept as plain text, or as TakeShape's own HTML: the renderer prints these as TakeShape did where it can. If the compare reports `content` there, rebuild the block in the EmDash editor.
  - A style dropped (such as small text): the text stays, the style doesn't. Restyle it in the editor if the customer wants.
  - Failed downloads or preloads: run the migrate skill's step 3 or 5 again.
- "Drafts that published entries link to": entries TakeShape returned through a published entry's relationship fields though they were never published, so the old site may have shown them. They stay hidden on the new site until someone publishes them in EmDash's admin. The compare reports the pages that lose them as `content` (an empty spot, a missing tag or person) and fewer images. Show the list to the customer and publish only the ones they name.
- "Links to TakeShape-hosted files": links inside rich text that point at TakeShape's CDN. The compare reports them as `takeshape-host` on every page that prints them. Upload each file to the EmDash media library and change the link in the entry.
- "Not migrated": fields TakeShape fetched from connected services (Shopify, REST, GraphQL). Pages that printed them show `content` differences. Fetch the data from that service in the loader, with its credentials read through `getSecret`, or drop it with the customer's OK.
- "Slugs taken from your site's URLs": entries got the slugs their old URLs used. Lines below the list name any entry whose URL couldn't be kept; the compare reports those pages `missing`.
- Not in either report: a `Failed to enable search for <collection>` line from `emdash seed` (`npm run takeshape:seed`). That collection has no search index, so EmDash's `search()` finds nothing in it, and a site transfer carries it into production without one: the import builds indexes only for collections whose search was on in the package. The line ends with SQLite's error. `near "<name>": syntax error` means a field name breaks EmDash's search SQL, which writes field names unquoted. ts2emdash renames the names it knows (a field named `references` becomes `ts_references`), so show the customer the line. The fix renames the field with a `--config` override (`{ "fields": { "<Shape>.<property>": { "slug": "<new name>" } } }`, shape and property from the field map), which changes the field map, so it means the migrate skill's steps 3 to 5 again: into this folder before your first fix, into a new folder after it, carrying your commits across.
