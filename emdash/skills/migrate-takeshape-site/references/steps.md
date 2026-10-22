# Steps: a takeshape-ssg site to EmDash

The commands use these names. Replace each with its full path or URL in every command.

| Name | What it is |
| --- | --- |
| `<work>` | A new, empty folder for the move, outside the old site's folder. Everything this skill writes goes in it. |
| `<repo>` | `<work>/takeshape-migration`, the checkout with the scripts. |
| `<site>` | The old site's folder, the one with `tsg.yml`. Nothing here writes to it. |
| `<export>` | The TakeShape export: the ZIP, or the folder it unzips to. |
| `<out>` | `<work>/emdash-site`, the new Astro project. |
| `<old-url>` | The old site as the compare reads it: the live site, for example `https://www.example.com`, or a folder holding the old site's built output, which the compare serves itself. |
| `<new-url>` | The deployed new site, from step 8 on. |

## Starting a move

Before step 1, find out the following, check each answer, and write the log.

1. `<work>`: the folder you were opened in, if it's empty or holds only a takeshape-migration checkout. Otherwise ask the customer for a new, empty folder outside the old site's folder.
2. `<site>`: ask where the old site's code is. Find its `tsg.yml` with `find <folder> -name tsg.yml -not -path '*/node_modules/*'`. The folder that holds it is `<site>`. If there are several, ask which one is live.
   - No `tsg.yml` means TakeShape doesn't build this site, and this skill doesn't apply. Tell the customer, and offer the guide's steps 1 to 7 instead (`<repo>/emdash/README.md`): they move the content to EmDash, and the customer's own front end then needs updating. Keep the log the same way, and write at its top that the move follows the guide.
   - The compare checks the new site against the live one, so `<site>` has to hold the code that's live. If it's a git checkout, show the customer `git -C <site> status --short --branch` and `git -C <site> log -1 --oneline`, and ask whether that's the code TakeShape deploys, so step 2's last deploy ships exactly what's in it.
3. `<old-url>`: ask for the address visitors use, and check that it answers with `curl -sL -o /dev/null -w '%{http_code} %{url_effective}\n' <old-url>/`. It must print 200. If it ends on another address (`http` to `https`, or a bare domain to `www`), use that one. If the live site can't be crawled (a login in front of it, a host that blocks crawlers), ask for a folder holding the old site's built output instead.
4. The front end: read `<site>/package.json`, and the one in the repo's root if `<site>` is a subfolder. A script that builds CSS or JavaScript into `static/` (webpack or Sass, say) means the site has a front end of its own. Ask the customer how they ran it before a TakeShape deploy, and on which Node version. Step 2 runs it, and step 6 moves it into `<out>/frontend/`.
5. Run `grep -n 'env\.' <site>/tsg.yml` and tell the customer the names it finds, so they can look up the values TakeShape's build had. Step 2 asks for them.
6. Check `node --version` (22.22 or later) and `git --version`. Tell the customer what they'll need later: admin access to the TakeShape project (step 2) and a Cloudflare account on Workers Paid (step 8).

Then write the log, show the customer what you found, and outline the ten steps and the six stop points in a few lines. Start step 1 when they say go.

## Picking up a move

A session can end anywhere, even partway through a step. Before you run anything:

1. Read `<work>/migration-log.md`. Its names give every path and URL. If its top says the move follows the guide, pick up there.
2. Check the disk against it:
   - `git -C <out> status --short` and `git -C <out> log --oneline -5`. Uncommitted changes are a fix in progress: show them to the customer before you go on.
   - If `<work>/server.pid` exists, a server may still be running. Stop it as "Running servers" says, `pgrep` check included.
   - If the log's last step is a compare that hasn't come back clean, read its newest report.
   - Step 8's token terminal belongs to the customer. If they closed it, they run its `export` and `read` lines again before the next `emdash migrate`.
3. Ask whether anyone edited content in TakeShape since the export the log names. If so, the end of "Cutover" says what to redo.
4. Tell the customer the last step the log shows done, what the disk shows, and the next step. Where the log and the disk disagree, ask.

A yes from an earlier session covers only what the log shows was done with it, so ask again at every stop point still ahead. Values the log leaves out on purpose, such as a secret `${env.NAME}` value, have to come from the customer again when a step needs them.

If there's no log but `<work>` holds `takeshape-migration/` and `emdash-site/`, the move started before this skill kept one. Ask the customer how far it got, check the disk as above, and write the log from both.

## The log

`<work>/migration-log.md` lets any session pick up the move. Write it before step 1, then bring it up to date each time a step or a fix finishes and each time the customer answers at a stop point. It holds:

- The names in the table above, plus `<account>` and `<db>` from step 8, each with its value.
- One line per step: the date, its result (an exit code, a count, a report's path) and anything left to do.
- Every decision, with its date: the answer at each stop point, each `--ignore-text` pattern and what it hides, each difference the customer accepted, the front end's build command.
- The next step, in one line, kept current.

Never write a password, API key or token in it. For a `${env.NAME}` value, write the name only, unless the customer says the value isn't secret.

## Running servers

Steps 5 and 7 and every fix loop start a server that keeps running while you work. Start each one in its own process group, so one command later stops it and everything it started. `npm run dev` starts workerd, and stopping only the npm process can leave workerd running.

Start (here `npm run start:node`; each step names its own command):

```bash
cd <out>
bash -c 'set -m; npm run start:node > "$1" 2>&1 & echo $! > "$2"' _ <work>/server.log <work>/server.pid
```

Wait until `/` answers 200, for up to 2 minutes:

```bash
i=0; until [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4321/)" = 200 ]; do i=$((i+1)); [ $i -ge 120 ] && echo "not ready" && break; sleep 1; done
```

If it prints `not ready`, read `<work>/server.log`.

Stop it, with everything it started, and wait until the port is free:

```bash
kill -TERM -- -$(cat <work>/server.pid)
i=0; while curl -s -o /dev/null http://localhost:4321/; do i=$((i+1)); [ $i -ge 30 ] && echo "still running" && break; sleep 1; done
pgrep -fl workerd
```

`pgrep` must print nothing from `<out>/node_modules`. If it lists such a workerd, `kill` its process id. Run one server at a time: they all use port 4321.

### Another port

Port 4321 sits in two places: `EMDASH_SITE_URL` in `<out>/.env` (step 4 wrote it from `--site-url`) and the URLs in these commands. To use another port, such as 4400, rerun nothing:

- Set `EMDASH_SITE_URL=http://localhost:4400` in `<out>/.env` before you build.
- Start the Node build with `PORT=4400 npm run start:node`, and pass `--port 4400` to the others: `npm run dev:node -- --port 4400 --ignore-lock`, `npm run dev -- --port 4400 --ignore-lock`, `npx astro preview --port 4400 --ignore-lock`.
- Use 4400 in every URL below.

## 1. Get the scripts

```bash
node --version
git clone https://github.com/takeshape/takeshape-migration.git <work>/takeshape-migration
cd <repo>/emdash && npm install
```

`node --version` must print 22.22 or later. If the customer already has a checkout of the repo, use it as `<repo>`.

Check: `npm install` exits 0.

## 2. Export the content

Ask first (stop point 1). Tell the customer that edits made in TakeShape after the export never reach the new site, and that the compare needs the live site to match the export. Once they agree:

1. They freeze edits in TakeShape.
2. They deploy the site from TakeShape one last time, the way they always do. TakeShape's CLI does it with `takeshape deploy` in the site folder, once the folder is linked to the project with `takeshape link`.
3. They export the project with its data. In TakeShape's web app: Project Settings, then Export This Project. With TakeShape's CLI: `npm i -g @takeshape/cli`, `takeshape login`, `takeshape link`, then `takeshape export --project --to <work>/export`.

Ask for the export's path, or copy the ZIP into `<work>`.

Check: the export holds `schema.json` and `data.jsonl` (`unzip -l <export>` for a ZIP).

Two things to settle before step 3:

- Run `grep -n 'env\.' <site>/tsg.yml`. For each `${env.NAME}` it finds, ask the customer for the value TakeShape's build had, and set it in the environment of steps 3 and 4. Both scripts read `tsg.yml`, and a missing value stops them.
- If the site has a front-end build of its own (a `package.json` whose scripts build CSS or JavaScript into `static/`), run it the way the customer did before a TakeShape deploy, so `static/` holds the built files. The front end itself moves into the new project in step 6.

## 3. Convert the content

```bash
cd <repo>/emdash
node ts2emdash.mts <export> --site <site> --out <out>/takeshape/takeshape.seed.json --report <out>/takeshape/content-report.md \
  --preload-media local --database <out>/data.db --uploads-dir <out>/uploads
```

`--site` gives each entry the slug its page had in the old site's URLs. The seed, the field map (`takeshape-field-map.json`) and the content report land in `<out>/takeshape/`, where the new project expects them.

`--preload-media local` downloads every image and file from assets.takeshape.io up front, 8 at a time, into `<out>/uploads/`, records each one in `<out>/takeshape/takeshape-media.db`, and the seed in step 5 then downloads nothing. A site move always uses it, whatever the site's size: the compares in steps 6, 7 and 10 make the old site's images from those files instead of asking TakeShape's image CDN for every image on every page. A second run retries what failed and skips what it already has.

Check:

- It exits 0.
- Read `<out>/takeshape/content-report.md`. "Needs your attention" lists links to missing entries, renamed slugs, and rich text kept as plain text or as TakeShape's own HTML. "Slugs taken from your site's URLs" lists entries whose slug differs from the one the converter gives without `--site`, which is expected.
- "Links to TakeShape-hosted files" lists rich-text links into TakeShape's CDN. They break on December 31 (see the cutover list).
- Its summary says how many images and files it preloaded and that 0 failed. If some failed, run the same command again: it fetches only those.

## 4. Translate the site

```bash
cd <repo>/emdash
node tsg2astro/tsg2astro.mts <site> --export <export> --field-map <out>/takeshape/takeshape-field-map.json --out <out> --site-url http://localhost:4321
```

`--site-url` is where the new site runs for steps 5 to 7. It goes into `<out>/.env` as `EMDASH_SITE_URL`, and step 8 changes it.

Check:

- It exits 0. It refuses an `--out` folder that holds files it didn't write, apart from `takeshape/` and the content files.
- Read `<out>/tsg2astro-report.md`. Its first line says whether anything was left untranslated. The route table names the files behind each URL pattern. Every other section is work for `resolve-takeshape-site-report`. Fix those after the first compare in step 6, which shows what each one changes on the pages.

Then move the TakeShape files the site names onto the site (a logo in a layout's JSON-LD, icons in templates, backgrounds in the CSS and bundled JavaScript), while TakeShape's CDN still answers:

```bash
node tsg2astro/rehost.mts <out>
```

It downloads each file once into `<out>/takeshape/files/`, copies it to `public/_takeshape-files/` and rewrites the URLs. Exit 1 means a download failed: `<out>/takeshape/rehost-report.md` lists it, with the calls to TakeShape's API and the URLs a template builds at run time, which need a hand fix. tsg2astro rewrites `public/` and `src/` every time, so after every tsg2astro run, build the front end again (once it has moved into `<out>/frontend/`), then run rehost again. A rerun downloads nothing it already has.

Then commit the project, so every fix after this is a diff you can see and replay:

```bash
cd <out> && git init && git add -A && git commit -m "tsg2astro output"
```

The project's `.gitignore` keeps out `data.db` and its `-shm` and `-wal` files, `uploads/`, the media preload's record (`takeshape/takeshape-media.db`), the content seed (`takeshape/takeshape.seed.json`, every entry with drafts, tens of MB on a large site), the originals the compare downloads (`takeshape/compare-originals/`), `node_modules/`, the builds and `.env`. The field map, the content report and the compare's `takeshape/image-index.json` stay in git. The deployed site gets its content by site import (step 9), never from git.

## 5. Load the content in Node mode

Node mode keeps the content in `data.db` and the media in `uploads/`, which makes it the quickest place to check the site.

```bash
cd <out>
npm install
git add package-lock.json && git commit -m "package-lock.json"
npm run takeshape:seed
npm run build:node
```

`npm install` warns that the install scripts of workerd and esbuild aren't approved, and suggests `npm install-scripts approve`. That's expected. Don't approve anything: steps 1 to 7 have run without it. Steps 8 and 9 have run on a test Cloudflare account from a shell without a terminal, and step 10's compare against its `workers.dev` address.

Then start `npm run start:node` as in "Running servers" and wait for it. It serves `http://localhost:4321`.

Check:

- `takeshape:seed` prints `Content: N created`, with N the entry count from the content report's Summary.
- It prints no `Failed to download`, `Error processing $media` or `Skipping $media reference` line. If it does, fix the network, stop the server, delete only the `data.db` files (`data.db`, `data.db-shm`, `data.db-wal`), run step 3 again, which fetches only what's missing, and run `npm run takeshape:seed` again.
- It prints no `Failed to enable search for <collection>` line. Such a collection has no search: EmDash's `search()` finds nothing in it, and step 9's site import carries that into production, since the import builds search only for collections whose search was on in the package. Show the customer the line. It ends with SQLite's error, and `near "<name>": syntax error` means a field name breaks EmDash's search SQL (ts2emdash renames the SQL keywords it knows). Fix it now, before any other edit: write a `--config` override that renames the field (`{ "fields": { "<Shape>.<property>": { "slug": "<new name>" } } }`, shape and property from `<out>/takeshape/takeshape-field-map.json`), stop the server, delete the `data.db` files, run step 3 again with the same flags plus `--config <file>`, run step 4 again (nothing is edited yet, so tsg2astro may run over the project), commit, and run this step again.
- The wait loop ended without `not ready`.

## 6. Compare with the live site

```bash
cd <repo>/emdash
node compare/compare-sites.mts <old-url> http://localhost:4321 --out <work>/compare-node.md --json <work>/compare-node.json \
  --media <out> --image-index <out>/takeshape/image-index.json
```

`--media <out>` makes each old image on TakeShape's CDN from the original the preload stored in step 3, with the rules the new site's image endpoint follows, so the compare doesn't ask TakeShape for every image on every page. To check those rules, it asks imgix (images.takeshape.io) for one image per setting, and keeps the answers in `<out>/takeshape/image-index.json`. Later runs reuse them and ask only about settings the file lacks. The first compare has to run before December 31, while imgix answers. Commit the file with the project. Every compare in this skill passes both flags.

| Exit | Meaning |
| --- | --- |
| 0 | No differences. Go on to step 7. |
| 1 | Differences, or the crawl stopped at its page cap (the report's Notes say so). The report's "Notes for this run" (imgix didn't answer, originals downloaded) don't change the exit code. |
| 2 | A site didn't answer, or the command was wrong. The message says which. |

Expect one kind of difference that isn't a translation bug: text printed from the clock. takeshape-ssg printed it once, when TakeShape built the old site, and the new site prints it on every request. A template does this when it prints `now`, or a `date` filter on a field its query never asks for. TakeShape's books starter does it on its book pages: `Published {{ book.publishDate | date('MMMM D, YYYY') }}`, with no `publishDate` in the query, so each book page shows up as a `content` difference with an old date and today's date. Confirm it before you ignore it: the diff lines differ only in that date, and the template line prints a value its query doesn't fetch. Then run the compare again with `--ignore-text` and a pattern for exactly that text, written as the source of a JavaScript regex without slashes or flags. For the books starter:

```bash
node compare/compare-sites.mts <old-url> http://localhost:4321 --out <work>/compare-node.md --json <work>/compare-node.json \
  --media <out> --image-index <out>/takeshape/image-index.json --ignore-text 'Published [A-Z][a-z]+ \d{1,2}, \d{4}'
```

Keep the pattern that narrow, and tell the customer what it hides.

For anything else on exit 1, load `resolve-takeshape-site-report` and work through `tsg2astro-report.md` and `compare-node.md`. If the site has a front-end build of its own, move it into `<out>/frontend/` first, as the resolve skill's "The front end" says, and commit it. After each fix, run `npm run build:node`, restart the server, run the compare again (with the same `--ignore-text`) and commit. Repeat until it exits 0, or until its only differences are the ones the rules in `SKILL.md` allow: the `/404` and `/500` paths, each with its own status and checked by hand, and `image-rules` lines the customer has seen and accepted.

The crawl starts from `/` and `/sitemap.xml` and follows every link on both sites, 4 requests at a time. Add `--delay-ms 200` if the live site's host rate-limits.

A section called "Links to TakeShape's website" doesn't fail the compare. Show it to the customer: those links go dead after December 31.

## 7. Check on Cloudflare's local runtime

This runs the Workers build in workerd, with D1 and R2 kept locally under `<out>/.wrangler/state`. No Cloudflare account needed. The content moves over with EmDash's site transfer, as it will in step 9. Stop the step 5 server first.

`emdash site import --json` prints progress lines before its JSON, and has no flag to silence them. Save its output and keep the part from the first line that starts with `{`, as below.

Export the Node-mode content as a site package. Start `npm run dev:node -- --ignore-lock` as in "Running servers", wait for it, then:

```bash
cd <out>
npx emdash site export --url http://localhost:4321 --output <work>/site.emdash
```

Stop the server once the export is written. Then load the package into empty local D1 and R2. Delete only `.wrangler/state`, since `astro preview` needs the rest of `.wrangler`:

```bash
rm -rf <out>/.wrangler/state
```

Start `npm run dev -- --ignore-lock` as in "Running servers" and wait for it. Then analyze:

```bash
cd <out>
npx emdash site import <work>/site.emdash --url http://localhost:4321 --analyze --json > <work>/analyze.out
sed -n '/^{/,$p' <work>/analyze.out > <work>/analyze.json
node -p 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); [j.planDigest, (j.plan?.blockers ?? []).length].join(" ")' <work>/analyze.json
```

It prints the plan digest and the number of blockers, which must be 0. A `seeded_scaffold_removed` transformation in the plan is expected: the dev server gives an empty database EmDash's default collections, and the import removes them. Run the plan with that digest (put `sha256:` in front if it's bare hex):

```bash
npx emdash site import <work>/site.emdash --url http://localhost:4321 --plan <planDigest> --confirm --json > <work>/import.out
sed -n '/^{/,$p' <work>/import.out > <work>/import.json
node -p 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); [j.state, j.receipt?.verification, j.receiptDigestValid].join(" ")' <work>/import.json
```

Check: it prints `complete verified true`. Stop the dev server. Then build for Workers:

```bash
cd <out>
npm run build
```

Start `npx astro preview --ignore-lock` as in "Running servers", wait for it, and compare, with the same `--ignore-text` as step 6 if step 6 needed one:

```bash
cd <repo>/emdash
node compare/compare-sites.mts <old-url> http://localhost:4321 --out <work>/compare-cloudflare.md \
  --media <out> --image-index <out>/takeshape/image-index.json --ignore-text 'Published [A-Z][a-z]+ \d{1,2}, \d{4}'
```

The exit codes and the fix loop are the same as in step 6, with `npm run build` and a preview restart after each fix. Clock text differs here as it did in step 6. Stop the preview once the compare exits 0, or shows only the differences `SKILL.md` allows.

Images that crop or flip can differ here and nowhere else: the local runtime's Images binding runs offline, so it resizes but ignores `crop`, `fp-x`, `fp-y` and `flip`, and makes `fit: 'fillmax'` and `fit: 'min'` at another size. An `image` difference on such an image, where step 6's compare had none, is that. Note it and go on; step 10 compares the deployed site, where Cloudflare does them.

## 8. Deploy to Cloudflare

Ask first (stop points 2, 3 and 4).

For the plan, tell the customer the site needs Workers Paid. Workers Free can't run it: the books starter's Worker is 5.0 MB gzipped, over Free's 3 MB, and single requests to its pages that read content took up to 15 ms of CPU on the test account (medians 5 to 8 ms), where Free allows 10 ms. The customer picks the plan in Cloudflare's dashboard.

Before your first `npm run deploy`, ask the customer to open Workers & Pages in Cloudflare's dashboard and tell you the account's `workers.dev` subdomain they see there. It becomes part of `<new-url>`. Wait until they confirm one is set. On the test account, Cloudflare's API said opening that page for the first time "will create a workers.dev subdomain automatically", and one existed after the owner opened it. Don't let the deploy pick it: when Wrangler detects an agent, it registers a subdomain on its own, named after the project, for the whole account (read from Wrangler 4.151.0's source).

The D1 database and EmDash's migrations come before the first deploy: on Workers, the first request can't finish the migrations, and the site gets stuck without its content. `<db>` below is the `database_name` in `<out>/wrangler.jsonc`.

Two shells take part. You run Wrangler and `npm run deploy` in your own shell. The customer runs every `emdash migrate` command in a terminal of their own, the token terminal, where the token sits in a shell variable that only those commands get. Never run `npm run deploy` or Wrangler in the token terminal, and never put the token in `.env`: Wrangler takes `CLOUDFLARE_API_TOKEN` from the environment and from `.env` ahead of its own login, and a D1-only token can't deploy.

```bash
cd <out>
npx wrangler login
npx wrangler whoami
```

The customer finishes `wrangler login` in the browser. `whoami` lists the accounts the login can use, with their IDs. If it lists more than one, ask the customer which one the site goes to. That ID is `<account>` below; it isn't a secret. Pass it to every Wrangler command: without a terminal, Wrangler stops when the login sees more than one account and none is set.

```bash
cd <out>
npm run build
CLOUDFLARE_ACCOUNT_ID=<account> npx wrangler d1 create <db> --no-update-config
```

`npm run build` writes `.emdash/migrations.json`, the list `emdash migrate` applies, and the database it applies them to. After a Node build (`npm run build:node`), `emdash migrate` works on the local `data.db` even with `--d1` (seen on the test account, 2026-10-18), so run `npm run build` again first. The first line `emdash migrate` prints, `Migration target:`, must start with `d1`. `--no-update-config` keeps Wrangler from adding the database to `wrangler.jsonc`, which already names it.

`emdash migrate` needs a Cloudflare API token with D1 Edit, and doesn't use Wrangler's login (stop point 3). It also needs the account ID, however many accounts there are. The customer creates the token in Cloudflare's dashboard: My Profile, API Tokens, Create Token, Create Custom Token, permission Account / D1 / Edit, resource: their account. Then, in the token terminal in `<out>`, they run these two lines and paste the token when `read` waits:

```bash
export CLOUDFLARE_ACCOUNT_ID=<account>
read -rs D1_TOKEN
```

Then, on its own:

```bash
CLOUDFLARE_API_TOKEN="$D1_TOKEN" npx emdash migrate --d1 <db>
```

`emdash migrate` shows the database and asks to confirm, and the customer types `y`. It then applies EmDash's migrations (90 in 102 seconds on the test account). Without `--d1` it stops with "D1 migrations require an explicit database selector or Wrangler config", and without the account ID with "A valid Cloudflare account ID is required for D1 migrations". Once it's done, deploy from your shell:

```bash
cd <out>
CLOUDFLARE_ACCOUNT_ID=<account> npm run deploy
```

`npm run deploy` builds the site and runs `wrangler deploy`, which finds the database by name and creates the R2 bucket and a KV namespace for sessions. Wrangler prints the Worker's `workers.dev` address. That address is `<new-url>` until DNS moves. If Wrangler says it wrote IDs to the config file, delete the `database_id` it added to `<out>/wrangler.jsonc`: local dev looks up its database by that ID and would open an empty one.

Check: the customer runs this in the token terminal, and it exits 0:

```bash
CLOUDFLARE_API_TOKEN="$D1_TOKEN" npx emdash migrate --check --d1 <db>
```

EmDash reads the site's address when the site builds: its own `Image` component resizes only with it (the translated pages' images don't need it). Put `EMDASH_SITE_URL=<new-url>` in `<out>/.env` and run `CLOUDFLARE_ACCOUNT_ID=<account> npm run deploy` again. At cutover, set it to the real domain and deploy once more.

If anyone opened the site before `emdash migrate` ran, its pages load empty and EmDash's API answers 500 with `EmDash is not initialized`: the migrations stopped partway and their lock is still held. The customer runs this in the token terminal (after the `export` and `read` lines again, if they closed it):

```bash
CLOUDFLARE_API_TOKEN="$D1_TOKEN" npx emdash migrate --status --d1 <db>
```

It prints the lock id. Then:

```bash
CLOUDFLARE_API_TOKEN="$D1_TOKEN" npx emdash migrate --take-over-lock <lock id> --d1 <db>
```

It asks to confirm (`y`), then applies the rest, the migration that was cut off included, which is safe to run again. Wait about 30 seconds: after a failed start, EmDash waits that long before it tries again. Then the customer runs the `--check` command above, and `<new-url>` answers with its pages.

### Deploying from GitHub Actions

Optional. Once a deploy from your shell has worked, GitHub can build every push and deploy `main`, so the site no longer depends on one machine. Ask first (stop point 5). The workflow below follows the one that deploys a large site's test copy, whose repository keeps the site in a subfolder and builds a Yarn front end; this file as written hasn't run.

1. The customer creates a private GitHub repository, and you push `<out>` to it, `package-lock.json` included (`npm ci` needs it). `.gitignore` keeps out the content, `.env` and the builds.
2. The customer creates a second Cloudflare API token, for deploys: on their account, Workers Scripts, Workers KV Storage, Workers R2 Storage and D1, each at Edit. That site's deploy token started from the dashboard's "Edit Cloudflare Workers" template, which Cloudflare's GitHub Actions guide recommends (https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), with D1 added. The D1-only token from above can't deploy.
3. They store the deploy token as `CLOUDFLARE_API_TOKEN` and `<account>` as `CLOUDFLARE_ACCOUNT_ID`, as secrets of an environment named `production` (the repository's Settings, Environments, New environment, Add environment secret). An environment's secrets reach only jobs that name it: on that site, the deploy step got no token until its job named the environment. GitHub Free offers environments only on public repositories, so for a private repository on GitHub Free they add both as repository secrets (Settings, Secrets and variables, Actions, New repository secret), and you delete the `environment: production` line below.
4. You write `<out>/.github/workflows/deploy.yml`, with `<new-url>` as `EMDASH_SITE_URL` (the custom domain after cutover). Leave out the front-end step if there's no `<out>/frontend/`, and use the front end's own install and build commands in it:

```yaml
# Builds the site on every push, and deploys main to Cloudflare Workers with the
# CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets of the production environment.
name: Build and deploy

on:
  push:
  workflow_dispatch:

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment: production
    env:
      EMDASH_SITE_URL: https://site.example.workers.dev
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 26

      - name: Front end
        working-directory: frontend
        run: |
          npm ci
          npm run build

      - name: Site
        run: |
          npm ci
          echo "EMDASH_SITE_URL=$EMDASH_SITE_URL" > .env
          npm run build

      - name: Deploy
        if: github.ref == 'refs/heads/main'
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: npx wrangler deploy
```

What that site's front end needed on the runner, each found by a failed run:

- A lockfile that fetches a package from GitHub over SSH (`ssh://git@github.com/...`) fails with `Permission denied (publickey)`, since the runner has no SSH key. `git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"` before the install fetches it over HTTPS, which works for public repositories.
- pngquant, which imagemin-webpack-plugin compiles when it installs, failed to build ("make sure that libpng-dev is installed"). The plugin was unused, so it went.
- A script that copies the manifest into `src/routes/_data/` has to create the folder first: git keeps no empty folders.

Its front end runs on Yarn 1: the workflow runs `npm install -g yarn@1.22.22` (the version its `package.json` names), then `yarn install --frozen-lockfile --non-interactive` and `yarn build`. Node 26 ships without corepack, though GitHub's Ubuntu runner had that Yarn on its path already (setup-node's log lists it).

Commit and push the workflow. Check the run in the repository's Actions tab, then load `<new-url>`. The workflow writes `.env` with the site's address only; tokens stay in the environment's secrets, since Wrangler reads `.env`. It ships code and static files. Content still moves by site import (step 9), and `emdash migrate` still runs in the token terminal.

## 9. Move the content to production

This is EmDash's site import again, against the deployed site, with the package from step 7. The target must hold no content yet.

1. The customer opens `<new-url>/_emdash/admin` and finishes the setup wizard. If it offers sample content, they clear that box. The wizard makes their admin account and a passkey. On the test account, that passkey was saved for one device only, and Chrome couldn't sign in with it after the wizard ran in another browser, so the customer signs in where they finished the wizard.
2. Run `npx emdash login --url <new-url>`. It opens the default browser on `/_emdash/admin/device`, and the customer approves it in the browser that holds the passkey, copying the address there if another browser opened. Run one login at a time: the token route allows 12 requests a minute per IP, and the CLI polls every 5 seconds, 11 or 12 times a minute. Two logins at once go over the limit, and one alone can reach it. The CLI then prints `Token exchange failed: [object Object]`. If you see that, stop every login, wait a minute and run one. The token lasts an hour.
3. Analyze, then run the plan, reading the JSON as in step 7:

```bash
cd <out>
npx emdash site import <work>/site.emdash --url <new-url> --analyze --json > <work>/analyze-production.out
npx emdash site import <work>/site.emdash --url <new-url> --plan <planDigest> --confirm --json > <work>/import-production.out
```

Check: 0 blockers, then `complete verified true`. A `seeded_scaffold_removed` transformation is expected, as in step 7: the setup wizard gives the site EmDash's default collections. An upload that fails with `fetch failed` gets retried by the CLI. EmDash takes files up to 50 MiB each by default, and an import that hasn't finished 24 hours after it was created expires. `npx emdash site import resume <operation-id> <work>/site.emdash` continues an interrupted upload.

## 10. Compare production with the live site

```bash
cd <repo>/emdash
node compare/compare-sites.mts <old-url> <new-url> --out <work>/compare-production.md \
  --media <out> --image-index <out>/takeshape/image-index.json
```

Add the same `--ignore-text` as in step 6 if it needed one. Same exit codes and fix loop as step 6, with `CLOUDFLARE_ACCOUNT_ID=<account> npm run deploy` after each fix. When it exits 0, or shows only the differences the rules in `SKILL.md` allow (check the `/404` and `/500` pages by hand again, against `<new-url>`), show the customer the report and ask about DNS (stop point 6).

## Cutover

1. The customer adds the domain to the Worker as a custom domain in Cloudflare's dashboard and moves DNS. Set `EMDASH_SITE_URL` in `<out>/.env` to the domain and run `CLOUDFLARE_ACCOUNT_ID=<account> npm run deploy`. With the GitHub Actions deploy, change `EMDASH_SITE_URL` in the workflow instead, and push to `main`.
2. Every item under "Links to TakeShape-hosted files" in either report gets resolved as `resolve-takeshape-site-report` says for its kind: files re-hosted and their links updated, `api.takeshape.io` calls and `package.json` scripts replaced. Then `grep -rn 'takeshape\.io' public src` in `<out>` must find nothing but links to TakeShape's website (`takeshape.io` or `www.takeshape.io`).
3. The customer revokes their TakeShape API keys. The last compare's `takeshape-host` scan must be clean, so nothing calls `api.takeshape.io`.
4. All of it before December 31, 2026.

If anyone edited TakeShape after the export, go back to step 2 before step 9: export again, then redo steps 3, 5 and 7 with `data.db`, `uploads/` and `.wrangler/state` deleted first. Your commits in `<out>` stay.
