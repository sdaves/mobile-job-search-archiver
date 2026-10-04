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

async function loadListings() {
  try {
    const r = await fetch("/listings");
    const rows = await r.json();
    const byJk = new Map();
    for (const j of rows) {
      if (!j.jk) continue;
      const prev = byJk.get(j.jk) || {};
      byJk.set(j.jk, { ...prev, ...j, description_html: j.description_html || prev.description_html });
    }
    const list = [...byJk.values()].reverse().slice(0, 50);
    const tb = $("listings").querySelector("tbody");
    tb.innerHTML = "";
    for (const j of list) {
      const tr = document.createElement("tr");
      const size = j.size_raw ? `<span class="small-badge">${escapeHtml(j.size_raw)}</span>` : "";
      tr.innerHTML = `<td>${escapeHtml(j.title || "")}</td><td>${escapeHtml(j.company || "")}</td><td>${size}</td><td>${escapeHtml(j.salary_raw || "")}</td><td>${escapeHtml(j.location || "")}</td>`;
      tb.appendChild(tr);
    }
  } catch {}
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

$("reload").onclick = loadListings;
$("reloadBrowser").onclick = () => control({ cmd: "reload" });

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
            useMaxWidth: false,
            c4ShapeInRow: 2,
            c4BoundaryInRow: 1,
            c4ShapeMargin: 80,
            diagramMarginX: 60,
            diagramMarginY: 20,
          },
          flowchart: { useMaxWidth: false },
          sequence: { useMaxWidth: false },
          class: { useMaxWidth: false },
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
setInterval(loadListings, 15000);
setInterval(loadWebLog, 4000);
