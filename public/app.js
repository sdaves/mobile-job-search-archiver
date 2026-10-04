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
setInterval(loadListings, 15000);
