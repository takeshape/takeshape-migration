This is an EmDash site, a CMS built on Astro with a full admin UI. tsg2astro translated it from a site built with TakeShape's static site generator (takeshape-ssg): the routes in its `tsg.yml` became the pages in `src/pages/`, its Nunjucks templates became the components in `src/templates/`, and its GraphQL queries became the loaders in `src/loaders/`.

## Commands

```bash
npm run takeshape:seed  # Load the migrated content into data.db (Node mode)
npm run dev:node        # Dev server on Node: content in data.db, media in uploads/
npm run build:node      # Build for Node into dist-node/
npm run start:node      # Serve the Node build
npm run dev             # Dev server on Cloudflare's local runtime: D1 and R2 live in .wrangler/
npm run build           # Build for Cloudflare Workers
npm run deploy          # Build, then deploy to Cloudflare (the first time: see below)
npm run typecheck       # wrangler types, then astro check
npx emdash types        # Regenerate TypeScript types from a running site
```

The admin UI is at `http://localhost:4321/_emdash/admin`.

### First deploy to Cloudflare

Create the D1 database and apply EmDash's migrations before the first `npm run deploy` to a Cloudflare account. On Workers, the first request can't finish the migrations, and the site gets stuck without its content. `<db>` is the `database_name` in `wrangler.jsonc`.

1. `npm run build` writes `.emdash/migrations.json`, the list `emdash migrate` applies.
2. `npx wrangler d1 create <db> --no-update-config` creates the database. `wrangler.jsonc` already names it.
3. `CLOUDFLARE_API_TOKEN="$D1_TOKEN" npx emdash migrate --d1 <db>` applies the migrations and asks to confirm. The site's owner creates an API token with D1 Edit and enters it with `read -rs D1_TOKEN`. `emdash migrate` also needs `CLOUDFLARE_ACCOUNT_ID` (`npx wrangler whoami` lists the IDs), and so does Wrangler when the login sees more than one account.
4. `npm run deploy`, without the token. If the account has no `workers.dev` subdomain yet, have the site's owner set one up in Workers & Pages first: when Wrangler detects an agent, it registers one named after this project, for the whole account.
5. `CLOUDFLARE_API_TOKEN="$D1_TOKEN" npx emdash migrate --check --d1 <db>` exits 0.

Give the token to `emdash migrate` commands only, never to `npm run deploy` or other Wrangler commands, and never put it in `.env`: Wrangler uses `CLOUDFLARE_API_TOKEN` from the environment or `.env` in place of its login, and a D1-only token can't deploy.

After the first deploy, a GitHub Actions workflow can run the rest: build the front end (if `frontend/` exists), write `EMDASH_SITE_URL` to `.env`, `npm run build`, then `npx wrangler deploy` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the repository's secrets. That token needs Workers Scripts, Workers KV Storage, Workers R2 Storage and D1 at Edit. Content still moves by site import, never through git.

If the site was opened before the migrations ran, its pages load empty and the API answers `EmDash is not initialized`. To recover, in this folder and the shell where `D1_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set:

1. `CLOUDFLARE_API_TOKEN="$D1_TOKEN" npx emdash migrate --status --d1 <db>` shows the migration lock's id.
2. `CLOUDFLARE_API_TOKEN="$D1_TOKEN" npx emdash migrate --take-over-lock <id> --d1 <db>` applies the rest and asks to confirm.
3. Wait about 30 seconds: after a failed start, EmDash waits that long before it tries again.
4. `CLOUDFLARE_API_TOKEN="$D1_TOKEN" npx emdash migrate --check --d1 <db>` exits 0. Then load the site.

## Where things are

Start with `tsg2astro-report.md`. Its route table names the files behind every URL, and it lists anything tsg2astro could not translate.

| Path | What it holds |
| --- | --- |
| `src/pages/` | One page or endpoint per URL pattern in the old `tsg.yml`. `/blog/:title/` is `src/pages/blog/[title].astro`. |
| `src/routes/` | One module per `tsg.yml` route. It loads the route's data, finds the page for a URL (or none, for a 404) and builds the context its template renders with. `_global.ts` loads the global context every page sees. |
| `src/templates/` | The old templates, file for file: HTML templates as Astro components, other templates as `render()` functions. |
| `src/loaders/` | The old GraphQL queries, file for file. Each loader reads EmDash and returns the shape TakeShape's API answered with, so the templates keep their expressions. |
| `src/lib/takeshape/` | What the generated code imports: TakeShape's filters, Nunjucks behavior, the rich-text renderer, the page rules (`context.ts`), the EmDash calls (`emdash-api.ts`), the image endpoint (`imgix.ts` maps imgix's parameters, `image-endpoint.ts` serves them, `image-sharp.ts` transforms on Node, `image-fetch.ts` sends files over the Images binding's 20 MB through `fetch()` with `cf.image`, `image-header.ts` reads their size in pixels) and the settings from `tsg.yml` (`site.ts`). |
| `src/image-endpoint.ts`, `src/image-endpoint-node.ts` | `/_takeshape/image`, where images with a size go: Cloudflare's Images binding on Workers (and `cf.image` for files over 20 MB), sharp on Node. `astro.shared.mjs` adds the route; each config picks its file. |
| `src/middleware.ts` | Answers `<folder>/index.html` with the page at `<folder>/`, as the old host did. |
| `public/` | The old `static/` folder. tsg2astro replaces it with a fresh copy of `static/` each time it runs. |
| `frontend/` | The old site's own CSS and JavaScript build, if it had one and it was moved in (the `resolve-takeshape-site-report` skill, "The front end"). Its build writes into `public/`: run it after tsg2astro and after each change. |
| `takeshape/` | The content seed (kept out of git: it holds every entry, drafts included), the field map and the content report from ts2emdash. |
| `astro.config.mjs` | The Cloudflare build: D1 for content, R2 for media. |
| `astro.node.config.mjs` | The Node build for local runs: SQLite in `data.db`, media in `uploads/`. |
| `astro.shared.mjs` | Options both builds share. |
| `src/live.config.ts` | EmDash loader registration (boilerplate, don't modify). |

## Running tsg2astro again

tsg2astro rewrites every path listed in `.tsg2astro.json` each time it runs, including `src/pages`, `src/routes`, `src/templates`, `src/loaders`, `src/lib/takeshape` and `public`. It never touches `data.db`, `uploads/`, `.wrangler/`, `takeshape/`, `node_modules/` or `dist*/`. Once you have edited generated files, run tsg2astro into a new folder and compare the two instead of running it over this one.

## Skills

Agent skills are in `.agents/skills/`. Load the one that fits the task:

| Skill | Use it for |
| --- | --- |
| `building-emdash-site` | Querying content, rendering Portable Text, schema design, seed files, site features (menus, widgets, search, SEO, comments, bylines). Start here. |
| `creating-plugins` | EmDash plugins with hooks, storage, admin UI, API routes and Portable Text block types. |
| `emdash-cli` | CLI commands for content management, seeding, type generation and the visual editing flow. |
| `resolve-takeshape-site-report` | Fixing what `tsg2astro-report.md`, `takeshape/content-report.md` or a compare against the old site lists, including browser code that still calls TakeShape's API. |

## Documentation

The EmDash docs are available as an MCP server at `https://docs.emdashcms.com/mcp`. When you need to verify an API, hook, config option, field type or pattern, call `search_docs` against the live documentation rather than relying on training-data recall.

This project ships `.mcp.json`, `.cursor/mcp.json` and `.vscode/mcp.json` so Claude Code, Cursor and VS Code find the docs server. Other tools need a one-time setup: see [docs.emdashcms.com/docs-mcp](https://docs.emdashcms.com/docs-mcp).

## Rules

- All content pages are server-rendered (`output: "server"`). No `getStaticPaths()` for CMS content.
- Keep `compressHTML: false` in `astro.shared.mjs`. The translated templates rely on the whitespace between inline elements.
- Keep the content seed at `takeshape/takeshape.seed.json`. EmDash bundles a seed at `seed/seed.json`, `.emdash/seed.json` or a `package.json` `emdash.seed` path into the Worker.
- `npm run takeshape:seed` applies the seed with `--on-conflict update`. Entries that link to each other in a loop get a placeholder first, and the full entry then updates it, so the seed needs that flag.
- Code in `src/` must run on Workers and on Node: no `cloudflare:workers` imports. Read secrets with `getSecret` from `astro:env/server`.
- Image fields are objects (`{ src, alt }`), not strings. In new code, use `<Image image={...} />` from `"emdash/ui"`.
- `entry.id` is the slug (for URLs). `entry.data.id` is the database ULID (for API calls like `getEntryTerms`).
- Loaders answer `_id`, `_createdAt`, `_updatedAt` and `_enabledAt`, and sort by them, from each entry's `takeshape_id`, `takeshape_created_at`, `takeshape_updated_at` and `takeshape_published_at`. An entry created in EmDash after the move has none of these, so the loaders use EmDash's own id and dates for it. An entry edited in EmDash keeps its TakeShape `takeshape_updated_at`, so pages that print or sort by `_updatedAt` (a sitemap's `lastmod`) keep the old date. When an edit should change that date, clear the entry's `takeshape_updated_at` (EmDash's own date then applies) or set it to the new date.
- Taxonomy names in queries must match the seed's `"name"` field exactly (e.g., `"genre"`, not `"genres"`).
