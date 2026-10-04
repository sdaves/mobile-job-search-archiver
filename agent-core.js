(function () {
  "use strict";

  const BASE = "http://127.0.0.1:8000";
  const MAX_DESC = 20000;
  const MAX_LOG_MSG = 4000;
  const PAGE_URL = location.href;

  const W = unsafeWindow || window;

  // ---------- transport ----------
  function gm(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        timeout: opts.timeout || 15000,
        ...opts,
        onload: (r) => resolve(r),
        onerror: (e) => reject(e),
        ontimeout: (e) => reject(e),
      });
    });
  }

  async function post(path, body) {
    try {
      const r = await gm({
        method: "POST",
        url: BASE + path,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(body),
      });
      return r.status >= 200 && r.status < 300 ? JSON.parse(r.responseText) : null;
    } catch {
      return null;
    }
  }

  async function getNext() {
    try {
      const r = await gm({ method: "GET", url: BASE + "/next" });
      if (r.status < 200 || r.status >= 300) return null;
      return JSON.parse(r.responseText);
    } catch {
      return null;
    }
  }

  // ---------- log shipping ----------
  const logQueue = [];
  const MAX_QUEUE = 500;
  let flushTimer = null;

  function safeStr(v) {
    try {
      if (v instanceof Error) return v.stack || v.message || String(v);
      if (typeof v === "object" && v !== null) return JSON.stringify(v);
      return String(v);
    } catch {
      return String(v);
    }
  }

  function log(level, msg, extra) {
    try {
      let m = typeof msg === "string" ? msg : safeStr(msg);
      if (m.length > MAX_LOG_MSG) m = m.slice(0, MAX_LOG_MSG) + "…[truncated]";
      if (logQueue.length >= MAX_QUEUE) logQueue.shift();
      logQueue.push({
        ts: new Date().toISOString(),
        level,
        src: "core",
        url: PAGE_URL,
        msg: m,
        ...(extra && typeof extra === "object" ? { extra } : {}),
      });
      scheduleFlush();
    } catch {}
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = W.setTimeout
      ? W.setTimeout(doFlush, 1500)
      : setTimeout(doFlush, 1500);
  }

  async function doFlush() {
    flushTimer = null;
    if (!logQueue.length) return;
    const batch = logQueue.splice(0, logQueue.length);
    await post("/log", { entries: batch });
  }

  async function flushLog() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await doFlush();
  }

  function flushLogSync() {
    if (!logQueue.length) return;
    const batch = logQueue.splice(0, logQueue.length);
    try {
      GM_xmlhttpRequest({
        method: "POST",
        url: BASE + "/log",
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ entries: batch }),
        timeout: 3000,
      });
    } catch {}
  }

  async function report(detail) {
    log("info", detail);
    await post("/ingest", { kind: "status", note: detail });
  }

  // ---------- console + error capture ----------
  function installCapture() {
    try {
      const c = W.console;
      if (c && !c.__jobsHooked) {
        const levels = ["log", "info", "warn", "error", "debug"];
        for (const lvl of levels) {
          const orig = c[lvl];
          if (typeof orig !== "function") continue;
          c[lvl] = function () {
            try {
              const parts = [];
              for (let i = 0; i < arguments.length; i++) parts.push(safeStr(arguments[i]));
              log(lvl, parts.join(" "));
            } catch {}
            try {
              return orig.apply(c, arguments);
            } catch {}
          };
        }
        try {
          c.__jobsHooked = true;
        } catch {}
      }
    } catch {}
    try {
      W.addEventListener("error", (e) => {
        try {
          log("error", `window.error: ${(e && e.message) || ""} @ ${(e && e.filename) || ""}:${(e && e.lineno) || 0}`, {
            stack: e && e.error && e.error.stack,
          });
        } catch {}
      });
      W.addEventListener("unhandledrejection", (e) => {
        try {
          log("error", "unhandledrejection: " + safeStr(e && e.reason));
        } catch {}
      });
    } catch {}
    try {
      W.addEventListener("beforeunload", flushLogSync);
      W.document.addEventListener("visibilitychange", () => {
        if (W.document.visibilityState === "hidden") flushLogSync();
      });
    } catch {}
  }

  if (W.__jobsCoreLoaded === location.href) {
    return;
  }
  W.__jobsCoreLoaded = location.href;

  installCapture();
  log("info", `core loaded on ${location.href}`, { title: document.title });

  // ---------- ui ----------
  function banner(text, color) {
    let el = document.getElementById("jobs-collector-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "jobs-collector-banner";
      el.style.cssText =
        "position:fixed;z-index:2147483647;left:0;right:0;bottom:0;padding:10px 14px;" +
        "font:14px/1.4 system-ui,sans-serif;color:#fff;text-align:center;box-shadow:0 -2px 8px rgba(0,0,0,.3)";
      document.documentElement.appendChild(el);
    }
    el.style.background = color || "#1a73e8";
    el.textContent = text;
  }

  // ---------- page type ----------
  function pageType() {
    const path = location.pathname;
    const params = new URLSearchParams(location.search);
    if (/\/viewjob/.test(path) || /\/rc\/clk/.test(path) || params.get("vjk") || params.get("jk")) {
      return "job";
    }
    if (/\/cmp(\/|$)/.test(path) || /\/companies\//.test(path)) return "company";
    if (
      /\/jobs(\/|$)/.test(path) ||
      /\/m\/jobs/.test(path) ||
      /\/q-/.test(path) ||
      params.has("q")
    ) {
      return "search";
    }
    if (document.querySelector("a[data-jk], a[href*='viewjob?jk='], a[href*='jk=']")) return "search";
    return "other";
  }

  function isChallenge() {
    const t = (document.title || "").toLowerCase();
    const b = (document.body ? document.body.innerText : "").slice(0, 2000).toLowerCase();
    if (/just a moment|additional verification|checking your browser|attention required|verify you are human/.test(t + " " + b)) {
      return true;
    }
    if (document.querySelector("#challenge-form, #cf-chl-widget, .cf-turnstile, [id*='captcha']")) return true;
    return false;
  }

  // ---------- helpers ----------
  function text(el) {
    return el ? (el.innerText || el.textContent || "").trim() : "";
  }
  function abs(href) {
    if (!href) return "";
    try {
      return new URL(href, location.origin).href;
    } catch {
      return href;
    }
  }
  function firstSel(sels, root) {
    const r = root || document;
    for (const s of sels) {
      const el = r.querySelector(s);
      if (el) return el;
    }
    return null;
  }
  function jkFromHref(href) {
    if (!href) return null;
    const m = href.match(/[?&]jk=([a-f0-9]+)/i) || href.match(/viewjob\?jk=([a-f0-9]+)/i);
    return m ? m[1] : null;
  }
  function countSel(s) {
    try {
      return document.querySelectorAll(s).length;
    } catch {
      return -1;
    }
  }

  function diagSearch() {
    return {
      title: document.title.slice(0, 120),
      anchorJk: countSel("a[data-jk]"),
      jcsTitle: countSel("a.jcs-JobTitle"),
      beacons: countSel(".job_seen_beacon"),
      mosaicItems: countSel("[data-testid='slider_item']"),
      initialData: !!(W._initialData || W.mosaic),
      jobKeys: !!(W._initialData && W._initialData.jobKeys),
      anchorText: text(document.querySelector("a.jcs-JobTitle")).slice(0, 80),
    };
  }

  // ---------- embedded JSON search data ----------
  function findJobKeyArray(root, depth) {
    const seen = new Set();
    const queue = [{ node: root, d: 0 }];
    while (queue.length) {
      const { node, d } = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node) || d > 6) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        if (node.length && node.every((it) => it && typeof it === "object")) {
          const withKey = node.filter((it) => it.jobkey || it.jk || it.jobKey);
          if (withKey.length >= Math.max(3, node.length * 0.6)) return withKey;
        }
        for (const it of node) queue.push({ node: it, d: d + 1 });
      } else {
        for (const k of Object.keys(node)) queue.push({ node: node[k], d: d + 1 });
      }
    }
    return null;
  }

  function scrapeSearchJson() {
    try {
      const roots = [
        W._initialData,
        W.mosaic && W.mosaic.providerData,
        W._initialData && W._initialData.jobKeys,
      ];
      for (const root of roots) {
        if (!root) continue;
        const arr = findJobKeyArray(root, 0);
        if (arr && arr.length) {
          return arr.map((it) => {
            const jk = it.jobkey || it.jk || it.jobKey;
            const sal =
              (it.salarySnippet && (it.salarySnippet.text || it.salarySnippet.salaryText)) ||
              it.extractedSalary?.text ||
              it.salaryText ||
              "";
            return {
              jk: String(jk),
              title: it.title || it.displayTitle || it.jobTitle || "",
              company: it.company || it.companyName || it.employerName || "",
              location: it.formattedLocation || it.location || it.jobLocation || "",
              salary_raw: typeof sal === "string" ? sal : "",
              remote: /remote/i.test(
                String(it.formattedLocation || it.location || it.remoteLocation || ""),
              ),
              url: "https://www.indeed.com/viewjob?jk=" + jk,
            };
          });
        }
      }
    } catch (e) {
      log("warn", "scrapeSearchJson threw: " + safeStr(e));
    }
    return null;
  }

  function scrapeSearchDom() {
    const out = [];
    const seen = new Set();
    const anchors = document.querySelectorAll(
      "a[data-jk], a.jcs-JobTitle, a[href*='viewjob?jk='], a[href*='/rc/clk?jk='], a[href*='jk=']",
    );
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const jk = a.getAttribute("data-jk") || jkFromHref(href) || jkFromHref(a.href);
      if (!jk || seen.has(jk)) continue;
      seen.add(jk);
      let card = a.closest("li, .job_seen_beacon, [data-jk], .cardOutline, .slider_container, div");
      for (let i = 0; i < 4 && card && card.parentElement; i++) {
        if (card.querySelector("[data-testid='company-name'], .companyName, .companyLocation")) break;
        card = card.parentElement;
      }
      const title =
        text(a).replace(/\s+/g, " ") ||
        text(firstSel(["h2.jobTitle", ".jobTitle"], card)) ||
        "";
      const company = text(
        firstSel(["span[data-testid='company-name']", "[data-testid='company-name']", ".companyName", ".company_location .companyName"], card),
      );
      const location_ = text(
        firstSel(["div[data-testid='text-location']", "[data-testid='text-location']", ".companyLocation"], card),
      );
      const salary = text(
        firstSel(
          ["div[data-testid='attribute_snippet_testid']", ".salary-snippet-container", ".metadata.salary-snippet-container", "[class*='salary-snippet']"],
          card,
        ),
      );
      out.push({
        jk: String(jk),
        title,
        company,
        location: location_,
        salary_raw: salary,
        remote: /remote/i.test(location_),
        url: "https://www.indeed.com/viewjob?jk=" + jk,
      });
    }
    return out;
  }

  // ---------- job page ----------
  function getJsonLd() {
    const nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (const n of nodes) {
      let data;
      try {
        data = JSON.parse(n.textContent);
      } catch {
        continue;
      }
      const arr = Array.isArray(data) ? data : data["@graph"] || [data];
      for (const d of arr) {
        const type = d && d["@type"];
        if (d && (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting")))) {
          return d;
        }
      }
    }
    return null;
  }

  function formatAddress(addr) {
    if (!addr) return "";
    if (typeof addr === "string") return addr;
    const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
      .filter(Boolean)
      .map((x) => (typeof x === "object" ? x.name || "" : x));
    return parts.filter(Boolean).join(", ");
  }

  function salaryFromLd(ld) {
    const bs = ld.baseSalary;
    if (!bs) return "";
    const v = bs.value || bs;
    if (typeof v === "number") return `$${v.toLocaleString()}`;
    const min = v.minValue ?? v.min;
    const max = v.maxValue ?? v.max;
    const unit = v.unitText || "";
    const cur = typeof bs.currency === "string" ? bs.currency : "";
    if (min == null && max == null) return "";
    const fmt = (n) => Number(n).toLocaleString();
    const range = min != null && max != null && min !== max ? `$${fmt(min)} - $${fmt(max)}` : `$${fmt(min ?? max)}`;
    return `${range} ${unit ? "a " + unit.toLowerCase() : ""} ${cur === "USD" ? "" : cur}`.trim();
  }

  function scrapeJob() {
    const ld = getJsonLd() || {};
    const params = new URLSearchParams(location.search);
    const jk = params.get("jk") || params.get("vjk") || document.querySelector("[data-jk]")?.getAttribute("data-jk") || "";
    const org = ld.hiringOrganization || {};
    const domCompany = text(firstSel(["[data-testid='inlineHeader-companyName']", ".jobsearch-CompanyInfoContainer a", "div[data-company-name='true']", "[data-testid='companyName']"]));
    const company = org.name || domCompany || "";
    const companyAnchor = firstSel(["a[href*='/cmp/']", "[data-testid='inlineHeader-companyName'] a"]);
    const descriptionHtml = ld.description || text(firstSel(["#jobDescriptionText", ".jobsearch-JobComponent-description"]));
    const loc =
      formatAddress(ld.jobLocation && ld.jobLocation.address) ||
      (ld.jobLocation && ld.jobLocation.name) ||
      text(firstSel(["[data-testid='inlineHeader-companyLocation']", ".jobsearch-JobInfoHeader-subtitle", "[data-testid='job-location']"]));
    const applyEl = firstSel(["a[data-testid='applyButtonLinkContainer']", "#applyButtonLinkContainer a", "a[href*='apply']"]);
    const applyUrl = ld.url || abs(applyEl && applyEl.getAttribute("href"));
    return {
      kind: "job",
      jk: String(jk || ld.identifier?.value || ""),
      title: ld.title || text(firstSel(["h1.jobsearch-JobInfoHeader-title", "h1", "[data-testid='jobsearch-JobInfoHeader-title']"])),
      company,
      company_url: companyAnchor ? abs(companyAnchor.getAttribute("href")) : "",
      salary_raw: salaryFromLd(ld) || text(firstSel(["#salaryInfoAndJobType", "[data-testid='attribute_snippet_testid']"])),
      location: loc,
      remote: ld.jobLocationType === "TELECOMMUTE" || /remote/i.test(loc),
      employment_type: Array.isArray(ld.employmentType) ? ld.employmentType.join(", ") : ld.employmentType || "",
      date_posted: ld.datePosted || "",
      description_html: String(descriptionHtml || "").slice(0, MAX_DESC),
      apply_url: applyUrl,
      url: location.origin + "/viewjob?jk=" + (jk || ""),
    };
  }

  // ---------- company page ----------
  function findLabelValue(labels) {
    const all = document.querySelectorAll("div,span,li,dt,dd,p");
    for (const el of all) {
      const t = text(el);
      if (!t || t.length > 40) continue;
      for (const label of labels) {
        if (t.toLowerCase().replace(/[:\s]+$/, "") === label) {
          const sib = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
          const v = text(sib);
          if (v) return v;
        }
      }
    }
    return "";
  }

  function sizeFromText(s) {
    const m =
      s.match(/([\d,]+)\s*(?:to|-|–)\s*([\d,]+)\s*employees/i) ||
      s.match(/([\d,]+)\+?\s*employees/i);
    if (!m) return { raw: "", min: null, max: null };
    const toNum = (x) => parseInt(String(x).replace(/,/g, ""), 10);
    if (m[2] != null) {
      return { raw: m[0], min: toNum(m[1]), max: toNum(m[2]) };
    }
    return { raw: m[0], min: toNum(m[1]), max: null };
  }

  function scrapeCompany() {
    const name =
      text(firstSel(["h1", "[data-testid='company-name']", "[data-testid='CompanyHeader-name']"])) ||
      document.title.replace(/ - .*$/, "").trim();
    let sizeRaw =
      text(firstSel(["[data-testid*='companySize' i]", "[data-testid*='CompanySize']", "[class*='companySize']"])) ||
      findLabelValue(["company size", "size"]);
    if (!sizeRaw) {
      const body = document.body ? document.body.innerText : "";
      const m = body.match(/([\d,]+\s*(?:to|-|–)\s*[\d,]+\s*employees|[\d,]+\+?\s*employees)/i);
      if (m) sizeRaw = m[1];
    }
    const parsed = sizeFromText(sizeRaw);
    const revenue = text(firstSel(["[data-testid*='revenue' i]"])) || findLabelValue(["revenue"]);
    const founded = text(firstSel(["[data-testid*='founded' i]", "[data-testid*='founded']"])) || findLabelValue(["founded"]);
    return {
      kind: "company",
      name,
      url: location.origin + location.pathname,
      size_raw: parsed.raw || sizeRaw,
      size_min: parsed.min,
      size_max: parsed.max,
      revenue,
      founded,
    };
  }

  // ---------- main ----------
  let advancing = false;

  async function advance() {
    if (advancing) return;
    advancing = true;
    const next = await getNext();
    if (!next || next.action === "stop") {
      const why =
        next && next.reason === "budget"
          ? "Daily budget reached — done for today"
          : next && next.reason === "challenge"
            ? "Paused: solve the Cloudflare check, then restart"
            : "Done for today";
      banner(why, "#137333");
      await flushLog();
      return;
    }
    if (next.url === location.href) {
      banner("Server returned the same page; stopping to avoid a loop.", "#b06000");
      await flushLog();
      return;
    }
    banner(`Next (${next.action}): navigating in ${Math.round((next.delayMs || 0) / 1000)}s…`, "#1a73e8");
    await flushLog();
    setTimeout(() => location.assign(next.url), next.delayMs || 5000);
  }

  async function run() {
    if (isChallenge()) {
      log("warn", "cloudflare challenge detected", diagSearch());
      await post("/ingest", { kind: "status", challenge: true, reason: "cloudflare-challenge" });
      banner("Cloudflare check detected. Solve it, then press Start again.", "#b06000");
      return;
    }
    const type = pageType();
    log("info", `page type=${type}`, { url: location.href, title: document.title.slice(0, 120) });
    try {
      if (type === "job") {
        const rec = scrapeJob();
        await post("/ingest", rec);
        log("info", `job scraped jk=${rec.jk}`, {
          title: rec.title,
          company: rec.company,
          descLen: rec.description_html ? rec.description_html.length : 0,
          salary: rec.salary_raw,
          location: rec.location,
        });
        await report(`job ${rec.jk} "${rec.title}" @ ${rec.company} attrs=${rec.description_html ? rec.description_html.length : 0}`);
      } else if (type === "search") {
        const term = (new URLSearchParams(location.search).get("q") || "").trim();
        let via = "json";
        let jobs = scrapeSearchJson();
        if (!jobs || !jobs.length) {
          via = "dom";
          jobs = scrapeSearchDom();
        }
        await post("/ingest", { kind: "search", term, jobs });
        log("info", `search scraped "${term}" via=${via} found=${jobs.length}`, diagSearch());
        await report(`search "${term}" via=${via} found=${jobs.length} title="${document.title.slice(0, 50)}"`);
        if (!jobs.length) log("warn", "search returned 0 jobs", diagSearch());
      } else if (type === "company") {
        const rec = scrapeCompany();
        await post("/ingest", rec);
        log("info", `company scraped "${rec.name}" size=${rec.size_raw}`, { revenue: rec.revenue, founded: rec.founded });
        await report(`company "${rec.name}" size=${rec.size_raw}`);
      } else {
        log("warn", `unhandled page type=${type} url=${location.href.slice(0, 120)}`);
        await report(`unhandled page type=${type} url=${location.href.slice(0, 80)}`);
      }
    } catch (e) {
      log("error", "scrape-error: " + safeStr(e), { stack: e && e.stack });
      await post("/ingest", { kind: "status", note: "scrape-error " + String(e) });
    }
    await advance();
  }

  run();
})();
