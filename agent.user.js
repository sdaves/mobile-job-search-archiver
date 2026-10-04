// ==UserScript==
// @name         Indeed Small Company Job Collector (loader)
// @namespace    http://127.0.0.1:8000/
// @version      0.3.0
// @description  Loads the live collector core from the local Termux jobs server
// @match        https://*.indeed.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addElement
// @grant        unsafeWindow
// @sandbox      JavaScript
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

  function boundCore(coreSrc) {
    return (
      "(function(GM_xmlhttpRequest,GM_getValue,GM_setValue,unsafeWindow){" +
      coreSrc +
      "\n})(__jobsGm.xhr,__jobsGm.get,__jobsGm.set,__jobsGm.uw);"
    );
  }

  // The core is fetched as text and executed with the GM_* globals. Several
  // execution strategies are tried because Indeed's CSP can block the
  // obvious ones; the first that runs wins.
  function runCore(coreSrc) {
    const strategies = [];

    // 1) Tampermonkey sandbox eval (works when @sandbox is JavaScript).
    strategies.push(() => (0, eval)(boundCore(coreSrc)));

    // 2) Blob URL via GM_addElement (Tampermonkey bypasses page CSP here).
    strategies.push(() => {
      const g = { xhr: GM_xmlhttpRequest, get: GM_getValue, set: GM_setValue, uw: unsafeWindow };
      const w = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
      w.__jobsGm = g;
      const blob = new Blob([boundCore(coreSrc)], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      if (typeof GM_addElement === "function") {
        GM_addElement(document.head || document.documentElement, "script", { src: url });
      } else {
        const s = document.createElement("script");
        s.src = url;
        (document.head || document.documentElement).appendChild(s);
      }
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });

    // 3) new Function in the sandbox.
    strategies.push(() => {
      const factory = new Function(
        "GM_xmlhttpRequest",
        "GM_getValue",
        "GM_setValue",
        "unsafeWindow",
        coreSrc,
      );
      factory(GM_xmlhttpRequest, GM_getValue, GM_setValue, unsafeWindow);
    });

    let lastErr = null;
    for (const fn of strategies) {
      try {
        fn();
        return true;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("all execution strategies failed");
  }

  async function boot() {
    const coreSrc = await getText("/agent-core.js?t=" + Date.now());
    if (!coreSrc) {
      banner("Could not load agent-core.js from " + BASE, "#b06000");
      return;
    }
    try {
      runCore(coreSrc);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      banner("agent-core error: " + msg, "#b3261e");
      sendLog({ level: "error", src: "loader", url: location.href, msg: "agent-core eval failed: " + msg, stack: e && e.stack });
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
