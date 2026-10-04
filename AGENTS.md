# jobs — Indeed small-company job scraper

Purpose: collect remote software job listings from Indeed, keep the ones at
**small companies (1–50 employees)**, and export resume-ready data.

Agent/internals doc. Read this before changing anything.

## Environment (verified)

- Device: Android, Termux (`u0_a200`), aarch64.
- Runtimes: `python3 3.13.12`, `bun 1.4.2`, `node` present, `curl`.
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
- Automation transport: **Tampermonkey userscript** (`agent.user.js`) with
  `@grant GM_xmlhttpRequest`, `@grant GM_setValue/GM_getValue`,
  `@grant unsafeWindow`, `@connect 127.0.0.1`.
- Userscript install flow: served at `http://127.0.0.1:8000/agent.user.js`;
  opening that URL in Firefox prompts Tampermonkey to install.
- Server orchestrates: userscript calls `GET /next`, scrapes per returned
  action, `POST /ingest`, then navigates after a randomized delay.
- Budget: soft **5 minutes/day**, randomized **4–12s** between pages, plus a
  max-pages cap. State persists; next day resumes.
- Scope: **remote** software roles (`l=Remote`), any software role.
- Small company = **1–50 employees**.

## Files

```
~/jobs/
  AGENTS.md            <- this file
  server.ts            <- Bun HTTP server + dashboard + queue/state
  public/index.html    <- control panel (start/stop, terms, budget, stats)
  public/app.js
  agent.user.js        <- Tampermonkey userscript (source of truth)
  data/state.json      <- queue cursor, daily seconds used, terms, paused, stats
  data/listings.jsonl  <- one scraped job per line
  data/companies.jsonl <- company size/revenue/founded keyed by company
  data/export.json     <- generated, resume-ready
  data/export.md
  data/export.csv
```

## Server endpoints

- `GET /`                 -> dashboard HTML
- `GET /agent.user.js`    -> userscript (Tampermonkey install URL)
- `GET /next`             -> `{action: "search"|"job"|"company"|"stop",
                               url, delayMs, reason}`
- `POST /ingest`          -> body `{kind: "search"|"job"|"company", ...}`;
                             append to jsonl; update stats
- `POST /control`         -> `{cmd: "start"|"stop"|"terms"|"budget", ...}`
- `GET /events`           -> SSE live dashboard feed
- `GET /listings`         -> JSON of collected jobs
- `GET /export.md|csv|json`

Queue build order per run:
1. one search URL per term -> `https://www.indeed.com/jobs?q=<term>&l=Remote`
2. every discovered job URL (`/viewjob?jk=...`)
3. unique company pages (`/cmp/<slug>`)

## Userscript behavior (`@match https://*.indeed.com/*`)

Page-type dispatch by URL/content:

- **Search page** (`/jobs`): extract cards (job key, title, company, location,
  salary snippet). Prefer embedded JSON (`unsafeWindow._initialData` / mosaic
  data); fallback DOM selectors (`a.jcs-JobTitle[data-jk]`).
- **Job page** (`/viewjob`): parse JSON-LD `JobPosting` -> title,
  hiringOrganization, baseSalary, description (HTML), employmentType,
  datePosted, jobLocation, apply URL. JSON-LD is the stable source.
- **Company page** (`/cmp`): company size, revenue, founded.

After ingest, `GET /next`; if `stop` show "done for today" banner and idle;
otherwise `location.assign(url)` after `delayMs`.

Challenge/CAPTCHA detection: text "Just a moment", "Additional Verification",
or Cloudflare interstitials -> POST status, show banner, halt. User completes
it once; Cloudflare cookie persists.

## Data model (listings.jsonl)

```json
{"kind":"job","jk":"...","title":"...","company":"...","company_url":"...",
 "salary_raw":"...","salary_min":null,"salary_max":null,"currency":null,
 "location":"...","remote":true,"employment_type":"...","date_posted":"...",
 "description_html":"...","apply_url":"...","url":"...","scraped_at":"ISO"}
```

`companies.jsonl`: `{"name","url","size_raw","size_min","size_max","revenue",
"founded","scraped_at"}`.

Export joins job->company, flags `size_min>=1 && size_max<=50`, sorts by parsed
salary desc, and adds parsed `seniority` + `tech_tags` + a `notes` field.

## Export fields for resume building

title, company, company_size, salary_raw/min/max, location, remote,
employment_type, date_posted, url, apply_url, description (text), seniority,
tech_tags, notes.

## Run / verification

1. `bun server.ts` -> open `http://127.0.0.1:8000`.
2. Install `agent.user.js` (open its URL in Firefox; Tampermonkey prompts).
3. **Dry run with `maxPages=1`** to validate Indeed selectors (JSON-LD first;
   DOM selectors are the fragile part and may need adjustment).
4. Then full 5-min run; leave the Firefox tab foreground.

## Risks

- Indeed DOM/JSON keys change over time; JSON-LD is most stable.
- Cloudflare may show a CAPTCHA; handled by pause + manual solve.
- Automation violates Indeed ToS; low daily budget mitigates blocks only.

## Open items (defaults applied unless user says otherwise)

- Terms (default 10): software engineer, senior software engineer, backend,
  full stack, frontend, devops, data engineer, machine learning, mobile,
  site reliability.
- Budget 5 min/day, delay 4–12s.
- Include seniority/tech_tags/notes in export (default yes).
- Confirm Tampermonkey installs in Firefox; else target Violentmonkey.
