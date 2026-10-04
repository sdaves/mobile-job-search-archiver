// ==UserScript==
// @name         Indeed Small Company Job Collector (loader)
// @namespace    http://127.0.0.1:8000/
// @version      0.6.0
// @description  Loads the live collector core from the local Termux jobs server
// @match        https://*.indeed.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addElement
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
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

  // The core is fetched as text and executed with the GM_* globals. Indeed
  // serves a CSP that blocks eval/new Function and inline page scripts, so the
  // first strategy uses Tampermonkey's GM_addElement, which the extension
  // injects through a privileged channel that bypasses the page CSP.
  const RUN_MARK = "__jobsCoreRan_" + Date.now();

  function coreWrapper(coreSrc) {
    return (
      "window." + RUN_MARK + "=1;" +
      "(function(GM_xmlhttpRequest,GM_getValue,GM_setValue,unsafeWindow){" +
      coreSrc +
      "\n})(window.__jobsGm.xhr,window.__jobsGm.get,window.__jobsGm.set,window.__jobsGm.uw);"
    );
  }

  function exposeGm() {
    const w = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
    w.__jobsGm = { xhr: GM_xmlhttpRequest, get: GM_getValue, set: GM_setValue, uw: unsafeWindow };
    return w;
  }

  function pageWindow() {
    return (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
  }

  function ranInPage() {
    return !!pageWindow()[RUN_MARK];
  }

  function runCore(coreSrc) {
    const src = coreWrapper(coreSrc);
    const w = pageWindow();

    // 1) GM_addElement inline script (bypasses page CSP in Tampermonkey).
    if (typeof GM_addElement === "function") {
      try {
        exposeGm();
        GM_addElement(document.head || document.documentElement, "script", {
          textContent: src,
        });
        if (ranInPage()) return "GM_addElement";
      } catch (e) {}
    }

    // 2) Plain inline page script.
    try {
      exposeGm();
      const s = document.createElement("script");
      s.textContent = src;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
      if (ranInPage()) return "inline-script";
    } catch (e) {}

    // 3) Sandbox new Function (works when Tampermonkey runs in its sandbox).
    const factory = new Function(
      "GM_xmlhttpRequest",
      "GM_getValue",
      "GM_setValue",
      "unsafeWindow",
      coreSrc,
    );
    factory(GM_xmlhttpRequest, GM_getValue, GM_setValue, unsafeWindow);
    return "sandbox-newfunction";
  }

  async function boot() {
    const coreSrc = await getText("/agent-core.js?t=" + Date.now());
    if (!coreSrc) {
      banner("Could not load agent-core.js from " + BASE, "#b06000");
      return;
    }
    try {
      const via = runCore(coreSrc);
      sendLog({ level: "info", src: "loader", url: location.href, msg: "core executed via " + via });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      banner("agent-core error: " + msg, "#b3261e");
      sendLog({ level: "error", src: "loader", url: location.href, msg: "agent-core failed: " + msg, stack: e && e.stack });
    }
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
      location.reload();
    }
  }

  boot();
  setInterval(checkReload, 3000);
})();
