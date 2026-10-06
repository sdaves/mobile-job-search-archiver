"use strict";

const $ = (id) => document.getElementById(id);

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function control(body) {
  await fetch("/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function renderState(st) {
  const running = st.running;
  const status = $("status");
  status.textContent = st.paused ? "paused" : running ? "running" : "stopped";
  status.className = "pill " + (st.paused ? "warn" : running ? "on" : "off");
  $("pause").textContent = st.paused && st.pauseReason ? "(" + st.pauseReason + ")" : "";

  $("usedLabel").textContent = fmtTime(st.secondsUsed);
  $("budgetLabel").textContent = fmtTime(st.budgetSeconds);
  $("budgetBar").max = st.budgetSeconds || 300;
  $("budgetBar").value = Math.min(st.secondsUsed, st.budgetSeconds || 300);

  $("sQueue").textContent = st.queueLength;
  $("sPages").textContent = st.pagesThisRun;
  $("sSearches").textContent = st.stats.searches;
  $("sJobs").textContent = st.stats.jobs;
  $("sCompanies").textContent = st.stats.companies;

  if (document.activeElement !== $("terms")) {
    $("terms").value = (st.terms || []).join("\n");
  }
  $("budget").value = st.budgetMinutes;
  $("maxPages").value = st.maxPages;
  $("delayMin").value = st.delayMinMs;
  $("delayMax").value = st.delayMaxMs;

  $("log").textContent = (st.log || []).join("\n");
}

$("start").onclick = () => control({ cmd: "start" });
$("stop").onclick = () => control({ cmd: "stop" });
$("reset").onclick = () => {
  if (confirm("Clear the queue and stats? Collected listings are kept.")) control({ cmd: "reset" });
};
$("save").onclick = () => {
  const terms = $("terms").value.split("\n").map((t) => t.trim()).filter(Boolean);
  control({ cmd: "terms", terms });
  control({
    cmd: "budget",
    budgetMinutes: Number($("budget").value),
    maxPages: Number($("maxPages").value),
    delayMinMs: Number($("delayMin").value),
    delayMaxMs: Number($("delayMax").value),
  });
};

let listingRows = [];

async function loadListings() {
  try {
    const r = await fetch("/listings", { cache: "no-store" });
    const rows = await r.json();
    const byJk = new Map();
    for (const j of rows) {
      if (!j.jk) continue;
      const prev = byJk.get(j.jk) || {};
      const merged = { ...prev };
      for (const [k, v] of Object.entries(j)) {
        if (v !== null && v !== undefined && v !== "") merged[k] = v;
      }
      merged.scraped_at = [prev.scraped_at, j.scraped_at].filter(Boolean).sort().pop() || "";
      byJk.set(j.jk, merged);
    }
    listingRows = [...byJk.values()].sort((a, b) =>
      (b.scraped_at || "").localeCompare(a.scraped_at || ""),
    );
    renderListings();
  } catch {}
}

function renderListings() {
  const filter = ($("listingFilter")?.value || "").trim().toLowerCase();
  const list = (filter
    ? listingRows.filter((j) => listingHaystack(j).includes(filter))
    : listingRows
  ).slice(0, 50);

  const tb = $("listings").querySelector("tbody");
  tb.innerHTML = "";
  for (const j of list) {
    const tr = document.createElement("tr");
    const size = j.size_raw ? `<span class="small-badge">${escapeHtml(j.size_raw)}</span>` : "";
    const hasFull = j.description_html && j.description_html.length > 0;
    const desc = hasFull
      ? '<span class="small-badge">desc</span>'
      : j.description_snippet
        ? '<span class="muted">snippet</span>'
        : '<span class="muted">—</span>';
    const title = j.url
      ? `<a href="${escapeHtml(j.url)}" target="_blank" rel="noopener">${escapeHtml(j.title || "")}</a>`
      : escapeHtml(j.title || "");
    const hasDesc = !!(j.description_html || j.description_snippet);
    tr.className = "job-row" + (hasDesc ? " expandable" : "");
    tr.innerHTML = `<td>${title}</td><td>${escapeHtml(j.company || "")}</td><td>${size}</td><td>${escapeHtml(j.salary_raw || "")}</td><td>${escapeHtml(j.location || "")}</td><td class="muted">${escapeHtml(fmtScraped(j.scraped_at))}</td><td>${desc}</td>`;
    tb.appendChild(tr);

    if (hasDesc) {
      const exp = document.createElement("tr");
      exp.className = "desc-row";
      exp.hidden = true;
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "desc-cell";
      cell.innerHTML = j.description_html
        ? `<div class="desc-body">${j.description_html}</div>`
        : `<div class="desc-body">${escapeHtml(j.description_snippet)}</div>`;
      exp.appendChild(cell);
      tb.appendChild(exp);
      tr.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        exp.hidden = !exp.hidden;
        tr.classList.toggle("open", !exp.hidden);
      });
    }
  }
}

function listingHaystack(j) {
  return [
    j.title,
    j.company,
    j.size_raw,
    j.salary_raw,
    j.location,
    j.employment_type,
    j.date_posted,
    j.scraped_at,
    j.description_snippet,
    stripTags(j.description_html),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function stripTags(html) {
  if (!html) return "";
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.textContent || "";
}

function fmtScraped(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

$("reload").onclick = loadListings;
$("reloadBrowser").onclick = () => control({ cmd: "reload" });
$("listingFilter").oninput = renderListings;

async function loadWebLog() {
  const el = $("weblog");
  if (!el) return;
  try {
    const r = await fetch("/web.log?tail=100");
    const txt = await r.text();
    const lines = txt
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          const e = JSON.parse(l);
          return `${(e.ts || "").slice(11, 19)} [${e.level}] ${e.src}: ${e.msg}`;
        } catch {
          return l;
        }
      });
    el.textContent = lines.join("\n");
  } catch {}
}

async function loadAgentStatus() {
  const el = $("agentStatus");
  if (!el) return;
  try {
    const r = await fetch("/agent-status");
    const s = await r.json();
    const fmt = (sec) => (sec == null ? "never" : sec < 90 ? sec + "s ago" : Math.round(sec / 60) + "m ago");
    const browser = s.lastBrowserAgeSec != null ? fmt(s.lastBrowserAgeSec) : "never";
    const loader = s.lastLoaderAgeSec != null ? fmt(s.lastLoaderAgeSec) : "never";
    const ing = s.lastIngestAgeSec != null ? fmt(s.lastIngestAgeSec) : "never";
    const msg = s.lastLoaderLog ? (s.lastLoaderLog.msg || "").slice(0, 40) : "";
    el.textContent = `browser ${browser} · loader ${loader} · next/ingest ${ing}${msg ? " · " + msg : ""}`;
  } catch {}
}

let mermaidLoading = null;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoading) return mermaidLoading;
  mermaidLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/mermaid.min.js";
    s.async = true;
    s.onload = () => {
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "loose",
          c4: {
            useMaxWidth: true,
            c4ShapeInRow: 3,
            c4BoundaryInRow: 1,
            c4ShapeMargin: 120,
            diagramMarginX: 120,
            diagramMarginY: 60,
          },
          flowchart: { useMaxWidth: true, nodeSpacing: 60, rankSpacing: 80 },
          sequence: {
            useMaxWidth: true,
            actorMargin: 60,
            messageMargin: 50,
            boxMargin: 16,
            mirrorActors: false,
            wrap: true,
          },
          class: { useMaxWidth: true },
        });
      } catch {}
      resolve(window.mermaid);
    };
    s.onerror = () => reject(new Error("mermaid load failed"));
    document.head.appendChild(s);
  });
  return mermaidLoading;
}

async function renderMermaid(root) {
  const blocks = root.querySelectorAll("pre > code.language-mermaid");
  if (!blocks.length) return;
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return;
  }
  const nodes = [];
  for (const code of blocks) {
    const div = document.createElement("div");
    div.className = "mermaid";
    div.textContent = code.textContent;
    code.parentElement.replaceWith(div);
    nodes.push(div);
  }
  try {
    await mermaid.run({ nodes, suppressErrors: true });
  } catch (e) {
    if (window.console) console.warn("mermaid render failed", e);
  }
}

async function loadDoc(name) {
  const view = $("docView");
  const status = $("docStatus");
  if (!view) return;
  view.innerHTML = '<p class="muted">Loading ' + escapeHtml(name) + "…</p>";
  if (status) status.textContent = name;
  try {
    const r = await fetch("/docs/content?name=" + encodeURIComponent(name), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    view.innerHTML = data.html || '<p class="muted">empty</p>';
    renderMermaid(view);
  } catch {
    view.innerHTML = '<p class="muted">Could not load ' + escapeHtml(name) + "</p>";
  }
}

async function loadDocs() {
  const sel = $("docSelect");
  if (!sel) return;
  try {
    const r = await fetch("/docs", { cache: "no-store" });
    const data = await r.json();
    const files = data.files || [];
    sel.innerHTML = "";
    if (!files.length) {
      if ($("docStatus")) $("docStatus").textContent = "no .md files found";
      return;
    }
    for (const f of files) {
      const o = document.createElement("option");
      o.value = f;
      o.textContent = f;
      sel.appendChild(o);
    }
    const preferred = files.find((f) => f.toLowerCase() === "readme.md");
    sel.value = preferred || files[0];
    await loadDoc(sel.value);
  } catch {
    if ($("docStatus")) $("docStatus").textContent = "could not list docs";
  }
}

$("docSelect").onchange = (e) => loadDoc(e.target.value);

function connect() {
  const es = new EventSource("/events");
  es.onmessage = (e) => {
    try {
      renderState(JSON.parse(e.data));
    } catch {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connect, 2000);
  };
}

connect();
loadListings();
loadWebLog();
loadDocs();
loadAgentStatus();
setInterval(loadListings, 15000);
setInterval(loadWebLog, 4000);
setInterval(loadAgentStatus, 5000);
