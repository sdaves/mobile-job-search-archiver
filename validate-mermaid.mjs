import { readFileSync, existsSync } from "fs";
import { JSDOM } from "jsdom";

const mdPath = process.argv[2] || "ARCHITECTURE.md";
const candidates = [process.argv[3], "public/mermaid.min.js"].filter(Boolean);
const mermaidPath = candidates.find((p) => existsSync(p));
if (!mermaidPath) { console.error("mermaid bundle not found"); process.exit(2); }

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["window","document","navigator","location","DOMParser","Node","Element","SVGElement","HTMLElement","Event","CustomEvent"]) globalThis[k] = window[k];
globalThis.window = window;

let src = readFileSync(mermaidPath, "utf8").replace(/^\s*"use strict";/, "");
(0, eval)(src);
globalThis.mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: "dark" });

const md = readFileSync(mdPath, "utf8");
const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
let bad = 0;
for (let i = 0; i < blocks.length; i++) {
  const first = blocks[i].trim().split("\n")[0];
  try { await globalThis.mermaid.parse(blocks[i]); console.log(`#${i+1} OK   (${first})`); }
  catch (e) { bad++; console.log(`#${i+1} FAIL (${first}) -> ${String(e?.message ?? e).split("\n")[0]}`); }
}
console.log(`\n${blocks.length - bad}/${blocks.length} diagrams parse`);
process.exit(bad ? 1 : 0);
