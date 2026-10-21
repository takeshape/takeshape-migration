# Narrow content reads (tsg2astro runtime), 2026-10-18

## Why

A large site's test deploy on Workers took 420 to 960 ms of CPU and 350 to 820 ms of D1 time a page (`deploy-timing.mts`, 8 rounds). A Node profile of the same build put most of the time in EmDash's list read: `getEmDashCollection` runs `SELECT *` and parses every column of every row (`mapRowToData`, `normalizeLocalMediaValue`), and the loaders read whole collections:

- An item page builds its route's whole list to find the item at the URL. An item page of the site's largest collection read every entry in it, hundreds of entries and over 10 MB, most of it rich text.
- A list with `size` (the home page's six latest entries) reads the whole collection and cuts it in memory.
- The feed and the sitemap read about a dozen lists and dozens of single entries in full to print a few fields of each. Every request to either one left an isolate that the next request had to start again (EmDash's init ran on it), which points at the 128 MB memory limit.

EmDash's public reads have no way to choose columns.

## What changes

1. `runtime/rows.ts` reads a collection's content table (`ec_<collection>`) with the columns a read needs, and maps each row as EmDash 1.3.0's loader does (`loader.ts`: `mapRowToData`, `normalizeLocalMediaValue`, `entryIdForRow`): system columns in camelCase with dates as `Date`, boolean fields as booleans, text that starts with `{` or `[` parsed as JSON. Same conditions as EmDash's public list read: `deleted_at IS NULL`, one status, equality `where` bound as EmDash binds it, EmDash's default order. Which columns exist and which fields are booleans comes from one query a request on `_emdash_fields`, the one `references.ts` already made for bindings. A `where` on anything that isn't a column (a taxonomy name) and every page that serves drafts (edit mode, preview links) keep EmDash's own read.
2. Loaders say what they read. Each read the emitter writes carries `select`: the columns its builder reads (`emit-loader.mts`, from the query plan), and for a list `heavy`, the ones that can hold a lot (rich text and its sidecar, JSON, repeaters, lists of links). The runtime adds what conditions and sorts need.
3. A list that is cut (`size`, `from`, or a route's pick) and has heavy columns reads in two steps: the deciding and light columns for every entry, then the selected columns of the entries it keeps. Any other list reads once.
4. Item and listing pages pick. The route passes the loader a pick that finds the page in the light list (path values come from the same fields the items print), so only the page's item and its neighbors are read in full and built. A route whose path reads anything but a top-level scalar of the item keeps the whole list.

Round trips: D1 time is round trips more than rows, and `d1({ coalesce: true })` sends the SELECTs of one turn (`setTimeout(0)`) as one batch. So the field query goes out in the same turn as the first content read (that read names the loader's columns; one missing gets it made again), an earlier read of a list with more columns answers for a later one, a plain page loads its global and route contexts together, and an item or listing page starts its global context while it finds its item. On a 404 that last one reads the global context for nothing.

## What stays

- Output: every page prints what it printed. Checked by comparing the large site's old and new builds page by page, and by both shape-books e2e modes.
- Reference reads stay batched (`references.ts`), now with `select` for their targets.
- `references.ts` and `rows.ts` are the generated code that reads EmDash's tables. Both are written against EmDash 1.3.0 and tested against a database `emdash seed` builds.

## For EmDash

A column choice on `getEmDashCollection` (and `limit` with an in-memory filter) would make `rows.ts` unnecessary.
