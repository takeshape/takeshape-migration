---
name: migrate-takeshape-site
description: Moves a website built with TakeShape's static site generator (takeshape-ssg, a site folder with a tsg.yml) to EmDash on Cloudflare Workers, then checks every page against the live site. Use when moving a site built with TakeShape's static site generator to EmDash, or when someone needs a takeshape-ssg site off TakeShape before it shuts down on December 31, 2026. Also use to pick up such a move in a new session (a migration-log.md in the work folder).
---

# Migrate a takeshape-ssg site to EmDash

TakeShape shuts down on December 31, 2026. A site built with takeshape-ssg loses its content API, its image CDN and the servers that build and deploy it. This skill moves the site to a new Astro project on EmDash that runs on Cloudflare Workers, and proves each page matches the old one before the customer switches over.

Three scripts from the takeshape-migration repo do the work:

| Script | What it does |
| --- | --- |
| `emdash/ts2emdash.mts` | Converts the TakeShape export into an EmDash seed, a field map and a content report. |
| `emdash/tsg2astro/tsg2astro.mts` | Translates the site (`tsg.yml`, Nunjucks templates, GraphQL queries, `static/`) into an Astro project that reads EmDash, and writes `tsg2astro-report.md`. |
| `emdash/compare/compare-sites.mts` | Crawls the old site and the new one and lists every difference per URL. Exit 0 means none. |

Your job: run them in order, check each result, stop at the six points below, and fix what the reports and the compare find with the `resolve-takeshape-site-report` skill.

The translator covers what TakeShape's books starter uses. Anything else shows up in `tsg2astro-report.md` as not translated, and the resolve skill covers it.

## Start or pick up a move

The customer's prompt may name nothing but this skill. Look for `migration-log.md` in the folder you were opened in. If it's there, the move is under way: follow "Picking up a move" in `references/steps.md`. If it isn't, follow "Starting a move" there, which lists what to ask the customer and check before step 1.

## Stop and ask the customer first

Get a clear yes before each of these. Each one touches the customer's live site, their accounts or their bill.

1. Freezing edits in TakeShape and running one last TakeShape deploy (step 2). The compare checks the new site against the live one, so the live site, the code on disk and the export have to match.
2. Logging in to Cloudflare (step 8). The customer signs in themselves, in the browser window `npx wrangler login` opens.
3. Creating a Cloudflare API token with D1 Edit (step 8), which `emdash migrate` needs. The customer creates it in Cloudflare's dashboard and runs the commands that use it in a terminal of their own, which never runs `npm run deploy` or Wrangler.
4. Choosing a Workers plan, and setting up the account's `workers.dev` subdomain in Workers & Pages (step 8). `references/steps.md` says what to tell them.
5. Deploying from GitHub Actions, if the customer wants it (step 8): a GitHub repository the project gets pushed to, and a second Cloudflare token that the customer creates and stores in the repository's settings.
6. Pointing DNS at the new site (after step 10).

Never type a password, API key or token yourself. The customer enters those in the prompts, browser windows and terminal the commands use.

## Rules

- Never edit tsg2astro, ts2emdash or anything else in the takeshape-migration checkout. If a script fails or writes something wrong, stop and show the customer the error. Fixes go in the generated project.
- Hand every item in `tsg2astro-report.md`, in the content report and in each compare report to the `resolve-takeshape-site-report` skill. tsg2astro copies it into the new project's `.agents/skills/`, and it's in `emdash/skills/` in the checkout too.
- Commit the new project to git right after step 4, then commit each fix. tsg2astro rewrites `src/pages`, `src/routes`, `src/templates`, `src/loaders`, `src/lib/takeshape` and `public` every time it runs, so never run it again over a project you have edited. The project's `.gitignore` keeps the content out of git, the seed included: it holds every entry, drafts too.
- If the old site has a front-end build of its own (a `package.json` whose scripts build CSS or JavaScript into `static/`), move it into `<out>/frontend/` during step 6, as "The front end" in `resolve-takeshape-site-report` says, and before step 8 in any case. The old site's folder is dead after cutover. Its build writes into `public/`, so run it after every tsg2astro run and after every change to it.
- Use Node 22.22 or later. The scripts run on 22.18, but the new project needs 22.22, Astro 7.4's minimum.
- Start servers in the background, each in its own process group, and stop each one when its step is done. "Running servers" in `references/steps.md` has the commands, and how to use another port than 4321. Pass `--ignore-lock` to `astro dev` and `astro preview`: when Astro 7.4 detects an agent it starts them detached, where you can't stop them.
- Text a template prints from the clock (today's date) differs between the old site and the new one. Step 6 says how to confirm that and ignore exactly that text.
- Write every path in full. Shell variables and the working folder may not carry over between your commands.
- Keep the log, `<work>/migration-log.md`, as "The log" in `references/steps.md` says, so any session can pick up the move. Never write a password, API key or token in it.
- The site matches when a compare exits 0. Don't tell the customer it matches before that. Two exceptions. First, once per route: when the Routes notes in `tsg2astro-report.md` list a route at `/404` or `/500` and the old site answered that path with 200, the compare lists the path as `missing` and doesn't compare the two pages. Accept that difference only when the new site answers `/404` with 404 or `/500` with 500, and only after you've checked by hand that the new page matches the old one (`curl -s <old-url><path>` against `curl -s` of the same path on the new site). Any other status there means the page fails: fix it. Second, an `image-rules` difference, once you've shown it to the customer: either the report's Image parameters section names that parameter and the customer accepts the difference, or it's a gap in this repo's imgix rules, which the project can't fix (`compare-differences.md` in `resolve-takeshape-site-report` says how to tell). Tell the customer about each difference you accept. The move is done when, on top of that, every item under "Links to TakeShape-hosted files" in either report is resolved (a file re-hosted, an `api.takeshape.io` call or a `package.json` script replaced), and `grep -rn 'takeshape\.io' public src` in the new project finds nothing but links to TakeShape's website (`takeshape.io` or `www.takeshape.io`). The compare scans only the files its crawl reaches, so it can miss a script.

## Steps

`references/steps.md` has the commands for each step and what to check after it.

1. Get the takeshape-migration repo and run `npm install` in `emdash/`.
2. Export the content, after the freeze and the last deploy.
3. Convert it with `ts2emdash.mts --site`.
4. Translate the site with `tsg2astro.mts`, then commit the project.
5. Install the project, load the content in Node mode, and check that search came on.
6. Compare the Node build with the live site, and fix until it's clean.
7. Run the same check on Cloudflare's local runtime.
8. Create the D1 database, run EmDash's migrations, then deploy to Cloudflare. If the customer wants, later deploys run from GitHub Actions.
9. Move the content to production with EmDash's site import.
10. Compare production with the live site.

Then the customer points DNS at the new site, and the cutover list at the end of `references/steps.md` finishes the move.

## Help

For EmDash itself, use the `building-emdash-site` and `emdash-cli` skills in the new project, EmDash's docs at https://docs.emdashcms.com (also an MCP server at https://docs.emdashcms.com/mcp), and the EmDash community Discord at https://discord.gg/YY9vBaQRYt.
