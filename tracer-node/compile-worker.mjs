// Runs the official Gleam WASM compiler in a worker thread (as the browser
// runtime runs it in a Web Worker). Input: { toolchainDir, source }.
// The pinned gleam_stdlib's Gleam sources are written next to the program so
// stdlib imports type-check; only `main` is read back.
// Output: { ok: true, js, warnings } | { ok: false, error }.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

const { toolchainDir, source } = workerData;
const wasm = await import(pathToFileURL(path.join(toolchainDir, "gleam_wasm.js")).href);
wasm.initSync({ module: fs.readFileSync(path.join(toolchainDir, "gleam_wasm_bg.wasm")) });
wasm.initialise_panic_hook(false);
const stdlibSources = JSON.parse(fs.readFileSync(path.join(toolchainDir, "stdlib.sources.json"), "utf8"));

const id = 0;
for (const [name, code] of Object.entries(stdlibSources)) wasm.write_module(id, name, code);
wasm.write_module(id, "main", source);
try {
  wasm.compile_package(id, "javascript");
  const warnings = [];
  for (let w = wasm.pop_warning(id); w; w = wasm.pop_warning(id)) warnings.push(w.trim());
  parentPort.postMessage({ ok: true, js: wasm.read_compiled_javascript(id, "main"), warnings });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e) });
}
