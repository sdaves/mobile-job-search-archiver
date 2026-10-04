// ==UserScript==
// @name         Indeed Small Company Job Collector (loader)
// @namespace    http://127.0.0.1:8000/
// @version      0.5.2
// @description  Loads the live collector core from the local Termux jobs server
// @match        https://*.indeed.com/*
// @match        https://indeed.com/*
// @match        https://*.indeed.com/m/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const BASE = "http://127.0.0.1:8000";

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

  async function getText(path) {
    try {
      const r = await gm({ method: "GET", url: BASE + path });
      if (r.status < 200 || r.status >= 300) return null;
      return r.responseText;
    } catch {
      return null;
    }
  }

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

  function sendLog(entry) {
    try {
      GM_xmlhttpRequest({
        method: "POST",
        url: BASE + "/log",
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(entry),
        timeout: 3000,
      });
    } catch {}
  }

  function runDirect(coreSrc) {
    const factory = new Function(
      "GM_xmlhttpRequest",
      "GM_getValue",
      "GM_setValue",
      "unsafeWindow",
      coreSrc,
    );
    factory(GM_xmlhttpRequest, GM_getValue, GM_setValue, unsafeWindow);
  }

  function runViaPage(coreSrc) {
    const w = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
    w.__jobsCoreSrc = coreSrc;
    w.__jobsCoreFn = { GM_xmlhttpRequest, GM_getValue, GM_setValue, unsafeWindow };
    const s = document.createElement("script");
    s.textContent =
      "(function(){" +
      "const w=window;" +
      "const src=w.__jobsCoreSrc;const g=w.__jobsCoreFn;" +
      "try{new Function('GM_xmlhttpRequest','GM_getValue','GM_setValue','unsafeWindow',src)" +
      "(g.GM_xmlhttpRequest,g.GM_getValue,g.GM_setValue,g.unsafeWindow);}" +
      "finally{try{delete w.__jobsCoreSrc;delete w.__jobsCoreFn;}catch(e){}}})();";
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }

  function whenDomReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  async function boot() {
    // Ping first so the dashboard always shows the loader is alive, even if the
    // core later fails.
    sendLog({
      level: "info",
      src: "loader",
      url: location.href,
      msg: "loader v0.5.2 alive; readyState=" + document.readyState,
    });
    const coreSrc = await getText("/agent-core.js?t=" + Date.now());
    if (!coreSrc) {
      banner("Could not load agent-core.js from " + BASE, "#b06000");
      sendLog({ level: "error", src: "loader", url: location.href, msg: "could not fetch agent-core.js" });
      return;
    }
    // The core needs the DOM, so run it once the page has parsed.
    whenDomReady(() => {
      try {
        runViaPage(coreSrc);
        sendLog({ level: "info", src: "loader", url: location.href, msg: "core injected via page script" });
        return;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        sendLog({ level: "warn", src: "loader", url: location.href, msg: "page-script injection failed, trying direct: " + msg });
      }
      try {
        runDirect(coreSrc);
        sendLog({ level: "info", src: "loader", url: location.href, msg: "core executed directly" });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        banner("agent-core error: " + msg, "#b3261e");
        sendLog({ level: "error", src: "loader", url: location.href, msg: "agent-core eval failed: " + msg, stack: e && e.stack });
      }
    });
  }

  let lastToken = null;
  let lastCoreHash = null;

  async function checkReload() {
    const data = await getText("/livereload");
    if (!data) return;
    let v;
    try {
      v = JSON.parse(data);
    } catch {
      return;
    }
    if (lastToken === null && lastCoreHash === null) {
      lastToken = v.reloadToken;
      lastCoreHash = v.coreHash;
      return;
    }
    if (v.reloadToken !== lastToken || v.coreHash !== lastCoreHash) {
      lastToken = v.reloadToken;
      lastCoreHash = v.coreHash;
      location.reload();
    }
  }

  boot();
  setInterval(checkReload, 3000);
  // Firefox Android can suspend timers while a tab is backgrounded; also check
  // whenever the tab is shown again so edits take effect without waiting.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkReload();
  });
  window.addEventListener("focus", checkReload);
  window.addEventListener("pageshow", checkReload);
})();
