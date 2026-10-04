import { join } from "path";
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
} from "fs";

const ROOT = import.meta.dir;
const DATA = join(ROOT, "data");
const PUBLIC = join(ROOT, "public");
const STATE_FILE = join(DATA, "state.json");
const LISTINGS_FILE = join(DATA, "listings.jsonl");
const COMPANIES_FILE = join(DATA, "companies.jsonl");

mkdirSync(DATA, { recursive: true });

const DEFAULT_TERMS = [
  "software engineer",
  "senior software engineer",
  "backend engineer",
  "full stack engineer",
  "frontend engineer",
  "devops engineer",
  "data engineer",
  "machine learning engineer",
  "mobile engineer",
  "site reliability engineer",
];

type TaskType = "search" | "job" | "company";
type Task = { type: TaskType; url: string; term?: string; jk?: string; company?: string };

type State = {
  date: string;
  running: boolean;
  paused: boolean;
  pauseReason?: string;
  secondsUsed: number;
  runStart: number | null;
  terms: string[];
  budgetMinutes: number;
  delayMinMs: number;
  delayMaxMs: number;
  maxPages: number;
  queue: Task[];
  queued: { jobs: string[]; companies: string[] };
  pagesThisRun: number;
  stats: { searches: number; jobs: number; companies: number };
  log: string[];
};

function nowIso() {
  return new Date().toISOString();
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function rand(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min));
}

function defaultState(): State {
  return {
    date: today(),
    running: false,
    paused: false,
    secondsUsed: 0,
    runStart: null,
    terms: [...DEFAULT_TERMS],
    budgetMinutes: 5,
    delayMinMs: 4000,
    delayMaxMs: 12000,
    maxPages: 40,
    queue: [],
    queued: { jobs: [], companies: [] },
    pagesThisRun: 0,
    stats: { searches: 0, jobs: 0, companies: 0 },
    log: [],
  };
}

let _state: State = defaultState();

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      _state = { ...defaultState(), ...raw };
      _state.queued = { jobs: [], companies: [], ...(raw.queued || {}) };
      _state.stats = { searches: 0, jobs: 0, companies: 0, ...(raw.stats || {}) };
    }
  } catch {
    _state = defaultState();
  }
}

function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2));
}

function rollover() {
  const t = today();
  if (_state.date !== t) {
    _state.date = t;
    _state.secondsUsed = 0;
    _state.runStart = null;
    _state.pagesThisRun = 0;
    addLog(`new day ${t}: budget reset`);
    saveState();
  }
}

function addLog(msg: string) {
  _state.log.unshift(`${nowIso()} ${msg}`);
  if (_state.log.length > 200) _state.log.length = 200;
}

function elapsedMs() {
  return _state.running && _state.runStart ? Date.now() - _state.runStart : 0;
}
function remainingMs() {
  return _state.budgetMinutes * 60000 - (_state.secondsUsed * 1000 + elapsedMs());
}

function finalizeRun(reason: string) {
  if (_state.running && _state.runStart) {
    _state.secondsUsed += (Date.now() - _state.runStart) / 1000;
  }
  _state.running = false;
  _state.runStart = null;
  addLog(`run ended: ${reason}`);
  saveState();
}

function buildQueue() {
  for (const term of _state.terms) {
    const q = encodeURIComponent(term);
    _state.queue.push({
      type: "search",
      url: `https://www.indeed.com/jobs?q=${q}&l=Remote`,
      term,
    });
  }
  addLog(`queued ${_state.terms.length} search tasks`);
}

function appendJsonl(file: string, obj: any) {
  appendFileSync(file, JSON.stringify(obj) + "\n");
}

function norm(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(
      /\b(inc|llc|ltd|limited|corp|corporation|company|co|holdings|group|technologies|technology|labs|software|the)\b/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- salary ----------
function parseSalary(raw: string) {
  if (!raw) return { min: null as number | null, max: null as number | null, currency: null as string | null, period: null as string | null };
  let currency: string | null = null;
  if (/\$/.test(raw)) currency = "USD";
  else if (/£/.test(raw)) currency = "GBP";
  else if (/€/.test(raw)) currency = "EUR";
  const period = /hour|hr|hourly/i.test(raw)
    ? "hour"
    : /month|mo|monthly/i.test(raw)
      ? "month"
      : /year|yr|annual|annum/i.test(raw)
        ? "year"
        : null;
  const nums: number[] = [];
  for (const m of raw.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([kK])?/g)) {
    let n = parseFloat(m[1].replace(/,/g, ""));
    if (isNaN(n)) continue;
    if (m[2]) n *= 1000;
    if (n >= 100) nums.push(n);
  }
  if (!nums.length) return { min: null, max: null, currency, period };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { min, max: max !== min ? max : min, currency, period };
}

function annualize(n: number | null, period: string | null) {
  if (n == null) return null;
  if (period === "hour") return n * 2080;
  if (period === "month") return n * 12;
  return n;
}

// ---------- tags / seniority ----------
const TAGS = [
  "typescript", "javascript", "python", "java", "golang", "go", "rust", "ruby",
  "php", "c++", "c#", "kotlin", "swift", "scala", "elixir", "node", "react",
  "vue", "angular", "svelte", "next.js", "django", "flask", "rails", "spring",
  "postgres", "postgresql", "mysql", "mongodb", "redis", "kafka", "graphql",
  "rest", "aws", "gcp", "azure", "docker", "kubernetes", "terraform", "ci/cd",
  "machine learning", "pytorch", "tensorflow", "llm", "nlp", "react native",
  "flutter", "ios", "android", "swiftui", "dbt", "spark", "airflow", "snowflake",
];

function extractTags(text: string) {
  const hay = ` ${(text || "").toLowerCase().replace(/[^a-z0-9+#./]+/g, " ")} `;
  const out: string[] = [];
  for (const tag of TAGS) {
    if (hay.includes(` ${tag} `)) out.push(tag);
  }
  return out;
}

function extractSeniority(title: string) {
  const t = (title || "").toLowerCase();
  if (/\bintern(ship)?\b/.test(t)) return "intern";
  if (/\bjunior\b|\bjr\b|\bentry\b/.test(t)) return "junior";
  if (/\bprincipal\b/.test(t)) return "principal";
  if (/\bstaff\b/.test(t)) return "staff";
  if (/\blead\b|\bmanager\b|\bdirector\b|\bhead\b/.test(t)) return "lead";
  if (/\bsenior\b|\bsr\b/.test(t)) return "senior";
  return "mid";
}

function stripHtml(html: string) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- export ----------
function readJsonl(file: string) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

type Job = any;

function buildExport() {
  const rows = readJsonl(LISTINGS_FILE) as Job[];
  const byJk = new Map<string, Job>();
  for (const r of rows) {
    if (!r.jk) continue;
    const prev = byJk.get(r.jk);
    if (!prev) {
      byJk.set(r.jk, r);
    } else {
      const merged = { ...prev, ...r };
      if (!r.description_html && prev.description_html) merged.description_html = prev.description_html;
      if (!r.salary_raw && prev.salary_raw) merged.salary_raw = prev.salary_raw;
      byJk.set(r.jk, merged);
    }
  }
  const companies = readJsonl(COMPANIES_FILE);
  const cMap = new Map<string, any>();
  for (const c of companies) cMap.set(norm(c.name), c);

  const out: any[] = [];
  for (const j of byJk.values()) {
    const c = cMap.get(norm(j.company)) || null;
    const sal = parseSalary(j.salary_raw || "");
    const descText = stripHtml(j.description_html || "");
    const small =
      c && c.size_min != null && c.size_max != null
        ? c.size_min >= 1 && c.size_max <= 50
        : false;
    out.push({
      title: j.title || "",
      company: j.company || "",
      company_size: c ? c.size_raw || "" : "",
      small_company: small,
      salary_raw: j.salary_raw || "",
      salary_min: sal.min,
      salary_max: sal.max,
      salary_currency: sal.currency,
      salary_period: sal.period,
      salary_annual_max: annualize(sal.max, sal.period),
      location: j.location || "",
      remote: j.remote ?? /remote/i.test(j.location || ""),
      employment_type: j.employment_type || "",
      date_posted: j.date_posted || "",
      url: j.url || "",
      apply_url: j.apply_url || "",
      description: descText,
      seniority: extractSeniority(j.title || ""),
      tech_tags: extractTags(`${j.title || ""} ${descText}`),
      notes: "",
      scraped_at: j.scraped_at || "",
    });
  }
  out.sort((a, b) => {
    if (a.small_company !== b.small_company) return a.small_company ? -1 : 1;
    return (b.salary_annual_max || 0) - (a.salary_annual_max || 0);
  });
  return out;
}

function toCsv(rows: any[]) {
  const cols = [
    "title", "company", "company_size", "small_company", "salary_raw",
    "salary_min", "salary_max", "salary_currency", "salary_period",
    "salary_annual_max", "location", "remote", "employment_type",
    "date_posted", "url", "apply_url", "seniority", "tech_tags", "notes",
  ];
  const esc = (v: any) => {
    let s = Array.isArray(v) ? v.join("; ") : v == null ? "" : String(v);
    s = s.replace(/"/g, '""');
    return `"${s}"`;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(","));
  return lines.join("\n");
}

function toMarkdown(rows: any[]) {
  const lines: string[] = ["# Job listings", "", `${rows.length} roles`, ""];
  for (const r of rows) {
    lines.push(`## ${r.title} — ${r.company}${r.small_company ? " (small)" : ""}`);
    lines.push("");
    if (r.salary_raw || r.salary_annual_max) {
      lines.push(`- Salary: ${r.salary_raw || ""}${r.salary_annual_max ? ` (~$${Math.round(r.salary_annual_max).toLocaleString()}/yr)` : ""}`);
    }
    lines.push(`- Location: ${r.location}${r.remote ? " (remote)" : ""}`);
    if (r.company_size) lines.push(`- Company size: ${r.company_size}`);
    if (r.employment_type) lines.push(`- Type: ${r.employment_type}`);
    if (r.date_posted) lines.push(`- Posted: ${r.date_posted}`);
    if (r.seniority) lines.push(`- Seniority: ${r.seniority}`);
    if (r.tech_tags?.length) lines.push(`- Tags: ${r.tech_tags.join(", ")}`);
    lines.push(`- URL: ${r.url}`);
    if (r.apply_url && r.apply_url !== r.url) lines.push(`- Apply: ${r.apply_url}`);
    if (r.description) lines.push("", r.description.slice(0, 1200));
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- SSE ----------
const sseClients = new Set<any>();

function statePayload() {
  rollover();
  return {
    running: _state.running,
    paused: _state.paused,
    pauseReason: _state.pauseReason,
    terms: _state.terms,
    budgetMinutes: _state.budgetMinutes,
    delayMinMs: _state.delayMinMs,
    delayMaxMs: _state.delayMaxMs,
    maxPages: _state.maxPages,
    secondsUsed: Math.round(_state.secondsUsed + elapsedMs() / 1000),
    budgetSeconds: _state.budgetMinutes * 60,
    queueLength: _state.queue.length,
    pagesThisRun: _state.pagesThisRun,
    stats: _state.stats,
    log: _state.log.slice(0, 40),
    date: _state.date,
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(statePayload())}\n\n`;
  for (const c of sseClients) {
    try {
      c.write(payload);
    } catch {
      sseClients.delete(c);
    }
  }
}

// ---------- HTTP ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function stopResponse(reason: string) {
  return json({ action: "stop", reason, url: null, delayMs: 0 });
}

async function handleNext() {
  rollover();
  if (_state.paused) return stopResponse("paused");
  if (!_state.running) return stopResponse("stopped");
  if (remainingMs() <= 0) {
    finalizeRun("budget exhausted");
    return stopResponse("budget");
  }
  if (_state.pagesThisRun >= _state.maxPages) {
    finalizeRun("max pages");
    return stopResponse("maxpages");
  }
  if (_state.queue.length === 0) buildQueue();
  if (_state.queue.length === 0) {
    finalizeRun("done");
    return stopResponse("done");
  }
  const task = _state.queue.shift()!;
  _state.pagesThisRun++;
  const delayMs = rand(_state.delayMinMs, _state.delayMaxMs);
  saveState();
  broadcast();
  return json({
    action: task.type,
    url: task.url,
    delayMs,
    reason: task.term || task.jk || task.company || "",
    remainingMs: Math.round(remainingMs()),
  });
}

async function handleIngest(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }
  const kind = body.kind;
  const scraped_at = nowIso();

  if (kind === "status") {
    if (body.challenge) {
      _state.paused = true;
      _state.pauseReason = body.reason || "challenge";
      addLog(`PAUSED: ${_state.pauseReason}`);
    } else if (body.challenge === false) {
      _state.paused = false;
      _state.pauseReason = undefined;
      addLog("resumed");
    } else if (body.note) {
      addLog(`agent: ${body.note}`);
    }
    saveState();
    broadcast();
    return json({ ok: true });
  }

  if (kind === "search") {
    const jobs = Array.isArray(body.jobs) ? body.jobs : [];
    let added = 0;
    for (const j of jobs) {
      if (!j.jk) continue;
      if (_state.queued.jobs.includes(j.jk)) continue;
      _state.queued.jobs.push(j.jk);
      appendJsonl(LISTINGS_FILE, { kind: "job", ...j, source: "search", scraped_at });
      if (j.url) {
        _state.queue.push({ type: "job", url: j.url, jk: j.jk, company: j.company });
      }
      added++;
    }
    _state.stats.searches++;
    addLog(`search "${body.term || ""}": +${added} jobs (queue ${_state.queue.length})`);
  } else if (kind === "job") {
    appendJsonl(LISTINGS_FILE, { kind: "job", ...body, scraped_at });
    _state.stats.jobs++;
    const cname = norm(body.company);
    if (body.company_url && cname && !_state.queued.companies.includes(cname)) {
      _state.queued.companies.push(cname);
      _state.queue.push({ type: "company", url: body.company_url, company: body.company });
    }
    addLog(`job "${body.title || ""}" @ ${body.company || ""}`);
  } else if (kind === "company") {
    appendJsonl(COMPANIES_FILE, { ...body, scraped_at });
    _state.stats.companies++;
    addLog(`company "${body.name || ""}" size=${body.size_raw || "?"}`);
  } else {
    return json({ ok: false, error: "unknown kind" }, 400);
  }
  saveState();
  broadcast();
  return json({ ok: true });
}

async function handleControl(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad json" }, 400);
  }
  const cmd = body.cmd;
  if (cmd === "start") {
    rollover();
    _state.running = true;
    _state.paused = false;
    _state.pauseReason = undefined;
    _state.runStart = Date.now();
    _state.pagesThisRun = 0;
    if (_state.queue.length === 0) buildQueue();
    addLog("started");
  } else if (cmd === "stop") {
    finalizeRun("manual stop");
  } else if (cmd === "terms") {
    if (Array.isArray(body.terms)) {
      _state.terms = body.terms.map((t: string) => String(t).trim()).filter(Boolean);
      addLog(`terms set (${_state.terms.length})`);
    }
  } else if (cmd === "budget") {
    if (body.budgetMinutes != null) _state.budgetMinutes = Math.max(1, Number(body.budgetMinutes));
    if (body.maxPages != null) _state.maxPages = Math.max(1, Number(body.maxPages));
    if (body.delayMinMs != null) _state.delayMinMs = Math.max(500, Number(body.delayMinMs));
    if (body.delayMaxMs != null) _state.delayMaxMs = Math.max(500, Number(body.delayMaxMs));
  } else if (cmd === "reset") {
    _state.queue = [];
    _state.queued = { jobs: [], companies: [] };
    _state.stats = { searches: 0, jobs: 0, companies: 0 };
    _state.secondsUsed = 0;
    _state.pagesThisRun = 0;
    addLog("reset queue/stats");
  } else {
    return json({ ok: false, error: "unknown cmd" }, 400);
  }
  saveState();
  broadcast();
  return json({ ok: true, state: statePayload() });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 8000,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (p === "/" || p === "/index.html") {
      return new Response(Bun.file(join(PUBLIC, "index.html")));
    }
    if (p === "/app.js") return new Response(Bun.file(join(PUBLIC, "app.js")));
    if (p === "/agent.user.js") {
      return new Response(Bun.file(join(ROOT, "agent.user.js")), {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
      });
    }
    if (p === "/next") return handleNext();
    if (p === "/state") return json(statePayload());
    if (p === "/ingest" && req.method === "POST") return handleIngest(req);
    if (p === "/control" && req.method === "POST") return handleControl(req);

    if (p === "/events") {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const client = {
            write(chunk: string) {
              controller.enqueue(enc.encode(chunk));
            },
          };
          sseClients.add(client);
          client.write(`data: ${JSON.stringify(statePayload())}\n\n`);
          const iv = setInterval(() => {
            try {
              client.write(`data: ${JSON.stringify(statePayload())}\n\n`);
            } catch {
              clearInterval(iv);
              sseClients.delete(client);
            }
          }, 1500);
          (client as any).iv = iv;
        },
        cancel() {},
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...CORS,
        },
      });
    }

    if (p === "/listings") {
      const jobs = readJsonl(LISTINGS_FILE);
      return json(jobs);
    }
    if (p === "/export" || p === "/export.json") {
      const rows = buildExport();
      writeFileSync(join(DATA, "export.json"), JSON.stringify(rows, null, 2));
      return json(rows);
    }
    if (p === "/export.csv") {
      const rows = buildExport();
      const csv = toCsv(rows);
      writeFileSync(join(DATA, "export.csv"), csv);
      return new Response(csv, { headers: { "Content-Type": "text/csv", ...CORS } });
    }
    if (p === "/export.md") {
      const rows = buildExport();
      const md = toMarkdown(rows);
      writeFileSync(join(DATA, "export.md"), md);
      return new Response(md, { headers: { "Content-Type": "text/markdown; charset=utf-8", ...CORS } });
    }

    return new Response("not found", { status: 404 });
  },
});

loadState();
saveState();
console.log(`jobs server listening on http://127.0.0.1:${server.port}`);
console.log(`userscript: http://127.0.0.1:${server.port}/agent.user.js`);
