/**
 * Thin wrapper over the OFFICIAL Gleam compiler (browser/WASM build, pinned in
 * toolchain.json), run in a worker thread. Uses only its public exports:
 * write_module, compile_package, read_compiled_javascript, pop_warning.
 *
 * The WASM build exposes no AST and (unlike the CLI) emits no source maps;
 * see docs/PHASE_2_ARCHITECTURE.md.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { parseDiagnostic, type CompileOutput } from "../src/tracer/runtime";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "toolchain.json"), "utf8")) as { gleamVersion: string };
export const GLEAM_VERSION = manifest.gleamVersion;
export const TOOLCHAIN_DIR = path.join(here, ".toolchain", `gleam-${GLEAM_VERSION}`);
const COMPILE_WORKER_URL = new URL("./compile-worker.mjs", import.meta.url);
const COMPILE_TIMEOUT_MS = 15_000;

export function toolchainAvailable(): boolean {
  return fs.existsSync(path.join(TOOLCHAIN_DIR, "gleam_wasm_bg.wasm")) && fs.existsSync(path.join(TOOLCHAIN_DIR, "gleam_prelude.mjs"));
}

/** Compiles one module named `main` to JavaScript with the official compiler. */
export function compileGleam(source: string): Promise<CompileOutput> {
  if (!toolchainAvailable()) {
    return Promise.reject(new Error(`Gleam toolchain not found in ${TOOLCHAIN_DIR}. Run: npm run tracer:setup`));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(COMPILE_WORKER_URL, { workerData: { toolchainDir: TOOLCHAIN_DIR, source } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Compiler timed out"));
    }, COMPILE_TIMEOUT_MS);
    worker.once("message", (m: { ok: true; js: string; warnings: string[] } | { ok: false; error: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(m.ok ? { ok: true, js: m.js, warnings: m.warnings } : { ok: false, diagnostic: parseDiagnostic(m.error) });
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
