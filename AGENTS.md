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
    **Scraped**, Desc. Title is a link to the saved listing `url`
    (`target=_blank`).
  - Rows with a description/snippet are **expandable on tap**: a full-width
    detail row reveals the description (rendered HTML when available, escaped
    snippet otherwise).
  - Listings are **sorted newest-first by `scraped_at`**, deduped by `jk`,
    capped at 50. Per-`jk` merge keeps the **max `scraped_at`**, not the
    first-seen position — fixes a bug where a job's early search-stub position
    buried its later full scrape outside the top 50. Merge also **prefers
    non-empty field values** so a later, poorer re-scrape cannot blank a field
    (salary/location/company) that an earlier scrape already filled.
  - `GET /listings` is served with `Cache-Control: no-store` so the dashboard
    never shows stale data.

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
                             "reset", ...}`
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
otherwise `location.assign(url)` after `delayMs`.

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
 "url":"...","source":"search|jobpage","scraped_at":"ISO"}
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

`norm` (`queued.jobs`/`queued.companies`) still gates search-task, job-task,
and company-page queueing. On `start`, the search queue is rebuilt from terms
**only when the whole scheduler is empty** (`searchQueue`, all `jobBuckets`,
`companyQueue`); otherwise the persisted scheduler resumes.

Export joins job->company, flags `size_min>=1 && size_max<=50`, sorts by parsed
salary desc, and adds parsed `seniority` + `tech_tags` + a `notes` field.

## Export fields for resume building

title, company, company_size, small_company, salary_raw/min/max,
salary_currency, salary_period, salary_annual_max, location, remote,
employment_type, date_posted, url, apply_url, description, description_full,
seniority, tech_tags, notes, scraped_at.

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
