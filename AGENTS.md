# jobs — Indeed small-company job scraper

Purpose: collect remote software job listings from Indeed, keep the ones at
**small companies (1–50 employees)**, and export resume-ready data.

Agent/internals doc. Read this before changing anything.

## Environment (verified)

- Device: Android, Termux (`u0_a200`), aarch64.
- Runtimes: `python3 3.13.12`, `bun 1.4.2`, `curl`. **`node` is NOT installed**
  (`node: command not found`); use `bun run` / `bun build --outfile /dev/null`
  for JS syntax checking.
- Outside browsers: `org.mozilla.fennec_fdroid` (Firefox) and
  `app.vanadium.browser` (Chromium-based). Chrome/Kiwi NOT installed.
- No extension support in Vanadium. Firefox is the automation target.
- Tampermonkey/Violentmonkey userscript runs inside Firefox (user chose
  Tampermonkey).
- No Termux chromium/firefox installed; do NOT rely on a Termux browser.
- No `~/storage` symlink yet; `termux-api` is partial (only `termux-open`,
  `termux-open-url` present).

## Hard constraints discovered

- Indeed is behind Cloudflare (`cf-mitigated: challenge`). Server-side fetch
  (`curl`, `fetch`) returns 403 (search) / 401 (viewjob). Only a real browser
  with JS gets through. Do NOT try to scrape Indeed from the Bun server.
- A `localhost` web page cannot read Indeed HTML (same-origin, CSP,
  Private Network Access). A plain browser page cannot drive itself across
  navigations.
- Therefore the ONLY working design: a **Tampermonkey userscript in the user's
  Firefox** scrapes Indeed and posts to a **Bun server on `127.0.0.1:8000`** in
  Termux. `GM_xmlhttpRequest` bypasses CORS/mixed-content/PNA and may POST to
  `http://127.0.0.1` from an HTTPS page.
- Bind the server to `127.0.0.1` only (not `0.0.0.0`) to avoid LAN exposure.
- Rate limiting / 5 min/day is deliberate: avoids Cloudflare blocks + CAPTCHA,
  and respects Indeed ToS (automation is against ToS; user accepts the risk).

## Decisions

- Runtime: **Bun** (`server.ts`).
- Automation transport: **Tampermonkey userscript** with
  `@grant GM_xmlhttpRequest`, `@grant GM_setValue/GM_getValue`,
  `@grant unsafeWindow`, `@connect 127.0.0.1`.
- Userscript is split into a **stable loader** (`agent.user.js`, installed
  once) and the **live logic** (`agent-core.js`, fetched with `no-store` on
  every page load and run via `new Function("GM_xmlhttpRequest",
  "GM_getValue", "GM_setValue", "unsafeWindow", coreSrc)`). Editing
  `agent-core.js` only needs a page reload; editing the loader needs a
  Tampermonkey reinstall/update.
- Debug loop: the browser posts all page `console` output plus scrape
  diagnostics to `data/web.log` (JSONL). A "Force browser reload" control
  bumps a persisted reload token; the core polls `/livereload` and calls
  `location.reload()` when the token or `agent-core.js` hash changes.
- Userscript install flow: served at `http://127.0.0.1:8000/agent.user.js`;
  opening that URL in Firefox prompts Tampermonkey to install.
- Server orchestrates: userscript calls `GET /next`, scrapes per returned
  action, `POST /ingest`, then navigates after a randomized delay.
- Budget: soft **5 minutes/day**, randomized **4–12s** between pages, plus a
  max-pages cap. State persists; next day resumes.
- Scope: **remote** software roles (`l=Remote`), any software role.
- Small company = **1–50 employees**.
- Dashboard was built in-session with these UX decisions:
  - Header is **not sticky** — it scrolls with the page.
  - Recent-listings columns: Title, Company, Size, Salary, Location,
    **Search**, **Scraped**, Desc. Title is a link to the saved listing `url`
    (`target=_blank`). Search is the term that discovered the job
    (`search_term`, joined across terms for collapsed duplicates).
  - Rows with a description/snippet are **expandable on tap**: a full-width
    detail row reveals the description (rendered HTML when available, escaped
    snippet otherwise).
  - Listings are **sorted newest-first by `scraped_at`**, deduped by `jk`,
    capped at the newest **500**. The table lives in a **vertically scrollable
    box** (~30 rows tall, sticky header). Per-`jk` merge keeps the **earliest
    (first-seen) `scraped_at`**: a later re-scrape never moves a listing's date.
    Merge also **prefers non-empty field values** so a later, poorer re-scrape
    cannot blank a field (salary/location/company) that an earlier scrape
    already filled. Records with an **identical description** are then collapsed
    into one row (locations joined).
  - `GET /listings` is served with `Cache-Control: no-store` so the dashboard
    never shows stale data.
  - The listings grid polls `/listings` every 15s but **only repaints while
    scrolled to the top** of the grid, or while a filter is active; otherwise
    the fresh data is held and the repaint is deferred so an in-progress browse
    (open description rows, scroll position) is not disturbed. Reaching the top
    flushes a deferred repaint; **Reload listings** always repaints (at the top).
  - The heading shows the number of rows currently in the grid (`N shown`,
    after the active filter and the 500 cap).
  - The Search-terms box never stays blank: if the stored term list is empty the
    server restores the 10 built-in defaults (`ensureTerms`, on load/start/terms
    save) and `/state` also carries `defaultTerms` so the box repopulates on the
    first paint.

## Files

```
~/jobs/
  AGENTS.md            <- this file
  server.ts            <- Bun HTTP server + dashboard + queue/state
  public/index.html    <- control panel (start/stop, terms, budget, stats)
  public/app.js
  public/ping.html     <- standalone websocket/SSE ping test page
  public/ping.js
  public/mermaid.min.js<- vendored Mermaid for the docs viewer
  *.md (root)          <- served in the dashboard Documentation panel
  agent.user.js        <- Tampermonkey loader (installed once; rarely changes)
  agent-core.js        <- live scraping/logging logic (edited often)
  data/state.json      <- queue cursor, daily seconds used, terms, paused, stats
  data/listings.jsonl  <- one scraped job per line
  data/companies.jsonl <- company size/revenue/founded keyed by company
  data/export.json     <- generated, resume-ready
  data/export.md
  data/export.csv
  data/web.log         <- browser console + scrape diagnostics (JSONL)
  data/web.log.1       <- rotated web log
  data/req.log         <- every HTTP request {ts,method,path,ua} (JSONL)
  data/server.log      <- bun server stdout when started detached
```

## Server endpoints

- `GET /`                 -> dashboard HTML
- `GET /agent.user.js`    -> loader (Tampermonkey install URL)
- `GET /agent-core.js`    -> live userscript logic (`Cache-Control: no-store`)
- `GET /next`             -> `{action: "search"|"job"|"company"|"stop",
                               url, delayMs, reason}`
- `POST /ingest`          -> body `{kind: "search"|"job"|"company", ...}`;
                             append to jsonl; update stats
- `POST /log`             -> body `{entries:[...]}` or one entry; append to
                             `data/web.log`
- `GET /web.log?tail=N`   -> recent browser log JSONL (default 200)
- `POST /control`         -> `{cmd: "start"|"stop"|"terms"|"budget"|"reload"|
                             "reset"|"backfill"|"pruneMissing", ...}`
  - `backfill` queues job pages for every listing that has no full description
    (deduped by title+company, keeping the earliest first-seen; skips pending
    and already-described postings). Exposed as the top **Add Listings With
    Missing Desc** button.
  - `pruneMissing` deletes every listing record with no `description_html`
    (jobs that still have a full record keep it; description-less jobs vanish
    and their pending queue tasks are dropped). Exposed as the top **Delete
    Listings Without Desc** button (confirms first).
- `GET /livereload`       -> `{reloadToken, coreHash, loaderHash}`
- `GET /events`           -> SSE live dashboard feed
- `GET /state`            -> current state payload (one-shot)
- `GET /agent-status`     -> liveness/staleness of browser/loader/ingest,
                             derived from `web.log` + `req.log`
- `GET /listings`         -> raw `listings.jsonl` lines (dupes included),
                             `Cache-Control: no-store`; the dashboard dedupes
                             by `jk` and sorts by `scraped_at`
- `GET /export.md|csv|json`
- `GET /ping`, `/ping.html`, `/ping.js` -> standalone SSE/websocket ping test
- `GET /mermaid.min.js`   -> vendored Mermaid (long cache)
- `GET /docs`             -> list of root `*.md` files
- `GET /docs/content?name=<file>.md` -> rendered markdown HTML for the
                             Documentation panel (name must be a bare filename)

Queue build order per run:
1. one search URL per term -> `https://www.indeed.com/jobs?q=<term>&l=Remote&sort=date`
   (all terms are searched first, each accumulating a per-term job bucket)
2. discovered job URLs (`/viewjob?jk=...`), visited **round-robin**: one job
   per term per round (job #1 of every term, then job #2 of every term, ...)
3. unique company pages (`/cmp/<slug>`), after the job buckets drain
The run ends for the day (`action:"stop"`, reason `done`) once the search
queue, all job buckets, and the company queue are empty.

## Userscript behavior (`@match https://*.indeed.com/*`)

**Loader** (`agent.user.js`) is stable: it fetches `/agent-core.js` with
`no-store` and runs it via `new Function("GM_xmlhttpRequest", "GM_getValue",
"GM_setValue", "unsafeWindow", coreSrc)` so the core sees the same globals. It
also polls `/livereload` every few seconds and calls `location.reload()` when
`reloadToken` or `coreHash` changes.

**Core** (`agent-core.js`) dispatches by page type:

- **Search page** (`/jobs`): extract cards (job key, title, company, location,
  salary snippet). Prefer embedded JSON (`unsafeWindow._initialData` / mosaic
  data); fallback DOM selectors (`a.jcs-JobTitle[data-jk]`).
- **Job page** (`/viewjob`): parse JSON-LD `JobPosting` -> title,
  hiringOrganization, baseSalary, description (HTML), employmentType,
  datePosted, jobLocation, apply URL. JSON-LD is the stable source.
- **Company page** (`/cmp`): company size, revenue, founded.

Every page `console` level plus `window` `error`/`unhandledrejection` is
captured and posted to `/log` in batches (flushed on navigation/unload), along
with scrape diagnostics (page type, challenge result, embedded-JSON/JSON-LD
presence, selector counts, jobs found, DOM snapshot when 0).

After ingest, `GET /next`; if `stop` show "done for today" banner and idle;
otherwise `location.assign(url)` after `delayMs`. The core shows an immediate
"Checking page…" / "Scraping <type> page…" banner as soon as it runs, before the
content wait, so a slow SPA render never leaves the page blank. Job-page
readiness keys off the `JobPosting` JSON-LD (the stable/earliest signal on the
`/m/` mobile page); the desktop-only description selectors never match there and
would otherwise force the poll to run long, so the content wait is capped at
**2s**. The diagnostic `report()`
status POSTs are fire-and-forget so they cannot delay the next-page banner.

Challenge/CAPTCHA detection: text "Just a moment", "Additional Verification",
or Cloudflare interstitials -> POST status, show banner, halt. User completes
it once; Cloudflare cookie persists.

## Browser log + debug loop (`data/web.log`)

The browser is otherwise a black box: the page is driven by the userscript and
Firefox DevTools are inconvenient from Termux. So the loader/core pipes all
page `console` output, uncaught errors/rejections, and scrape diagnostics to
`POST /log`, which appends one JSON object per line:

```json
{"ts":"ISO","level":"log|info|warn|error","src":"page|loader|core",
 "url":"https://...","msg":"...","stack":"...","extra":{}}
```

`GET /web.log?tail=N` returns the recent lines; rotate to `web.log.1` at
~2MB. Poll this file to see why a page parsed (or failed) and adjust
`agent-core.js`. The "Force browser reload" control bumps `reloadToken`;
the core polls `/livereload` and reloads, re-fetching the edited core.

## Data model (listings.jsonl)

```json
{"kind":"job","jk":"...","title":"...","company":"...","company_url":"...",
 "salary_raw":"...","salary_min":null,"salary_max":null,"currency":null,
 "location":"...","remote":true,"employment_type":"...","date_posted":"...",
 "description_html":"...","description_snippet":"...","apply_url":"...",
 "url":"...","source":"search|jobpage","search_term":"...","scraped_at":"ISO"}
```

`companies.jsonl`: `{"name","url","size_raw","size_min","size_max","revenue",
"founded","scraped_at"}`.

`req.log`: one line per HTTP request, `{"ts","method","path","ua"}`.

### Ingest dedupe (`seenJobs`)

State keeps `seenJobs: { [jk]: {full, salary, company} }`, rebuilt from
`listings.jsonl` on load (disk is source of truth) and cleared/rebuilt on
`reset`. A job record is appended only if it adds information: first time
seen, or it gains `description_html` / `salary_raw` / `company` that the prior
record lacked. A repeat job-page scrape with nothing new is **skipped** (counted,
not written), so resuming a run cannot bloat `listings.jsonl`. Search stubs
(no `description_html`) still append once per new `jk`; the later job-page
record appends again because it adds the description. Export merges by `jk`
anyway, so this only reduces redundant lines.

State also keeps `firstScraped: { [jk]: ISO }`, the earliest `scraped_at` seen
for a `jk`, rebuilt from `listings.jsonl` on load and on `reset`. Every appended
job record is stamped with that first-seen time (`firstScrapedAt`), so a later
re-scrape that adds a description/salary keeps the original date; export and the
dashboard's `jk` merge likewise keep the earliest `scraped_at`.

A job page whose `jk` already has a full `description_html` (per `seenJobs`) is
**never queued again**: search discovery skips enqueuing it, and `pickNextTask`
drops any stale bucket task for it. This holds even if salary/company are still
missing, so a `reset` cannot make the crawler re-visit already-downloaded pages.

Indeed also lists the *same* posting under different `jk`s (e.g. one per city),
so dedupe is not only by `jk`. A **content index** (rebuilt from
`listings.jsonl`, not persisted) maps `title+company` (`contentKey`) to whether a
full description exists (`contentFull`) and maps each `jk` to its content key
(`jkContent`). Search discovery skips a card whose `title+company` already has a
full description (never fetched, counted in the search log as
`already-downloaded`), and `pickNextTask` drops such stale bucket tasks. The
accepted tradeoff: two genuinely different same-title/company roles are only
distinguished later, by their (differing) descriptions.

`norm` (`queued.jobs`/`queued.companies`) still gates search-task, job-task,
and company-page queueing. On `start`, the search queue is rebuilt from terms
**only when the whole scheduler is empty** (`searchQueue`, all `jobBuckets`,
`companyQueue`); otherwise the persisted scheduler resumes.

Export and the dashboard further **collapse records with an identical
description**: full records group by a whitespace-normalized description hash
(each group keeps the earliest `scraped_at` and non-empty fields) and their
distinct locations are joined (`"Boston, MA, US / New York, NY, US"`); records
without a description stay separate.

Export joins job->company, flags `size_min>=1 && size_max<=50`, sorts by parsed
salary desc, and adds parsed `seniority` + `tech_tags` + a `notes` field.

## Export fields for resume building

title, company, company_size, small_company, salary_raw/min/max,
salary_currency, salary_period, salary_annual_max, location, search_term,
remote, employment_type, date_posted, url, apply_url, description,
description_full, seniority, tech_tags, notes, scraped_at.

## Run / verification

1. `bun server.ts` -> open `http://127.0.0.1:8000`.
2. Install `agent.user.js` (open its URL in Firefox; Tampermonkey prompts).
3. **Dry run with `maxPages=1`** to validate Indeed selectors (JSON-LD first;
   DOM selectors are the fragile part and may need adjustment).
4. Watch `data/web.log` (`GET /web.log?tail=200`); after editing
   `agent-core.js`, hit "Force browser reload" (or `POST /control
   {cmd:"reload"}`) so the core is re-fetched. Editing the loader needs a
   Tampermonkey update.
5. Then full 5-min run; leave the Firefox tab foreground.

## Risks

- Indeed DOM/JSON keys change over time; JSON-LD is most stable.
- Cloudflare may show a CAPTCHA; handled by pause + manual solve.
- Automation violates Indeed ToS; low daily budget mitigates blocks only.
- Tampermonkey's sandbox may block `new Function`/eval; if the core does not
  run, change the loader's execution/inject strategy.
- Capturing all page console output is intentionally noisy; `data/web.log` is
  capped and rotated so it stays bounded.

## Open items (defaults applied unless user says otherwise)

- Terms (default 10): software engineer, senior software engineer, backend
  engineer, full stack engineer, frontend engineer, devops engineer, data
  engineer, machine learning engineer, mobile engineer, site reliability
  engineer.
- Budget 5 min/day, delay 4–12s.
- Include seniority/tech_tags/notes in export (default yes).
- Confirm Tampermonkey installs in Firefox; else target Violentmonkey.
