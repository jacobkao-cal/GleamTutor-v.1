/**
 * The official Gleam standard library (gleam_stdlib, pinned in
 * tracer-node/toolchain.json) as the tracer sees it.
 *
 * - At compile time, the official compiler gets the stdlib's real Gleam sources.
 * - At run time, programs link against the stdlib precompiled by that same
 *   compiler and bundled into ONE ES module (stdlib.bundle.mjs, built by
 *   tracer-node/setup.mjs). The stdlib's modules import each other in cycles,
 *   which blob: URLs cannot express, so each module a program imports is
 *   reached through a small generated "facade" that re-exports one namespace
 *   of the bundle. The program and the stdlib share one prelude instance.
 * - Metadata (stdlib.json) lists each module's exports and each public
 *   function's declared result type, read from the stdlib's own sources.
 *
 * Stdlib calls are atomic for the tracer: stdlib code is never instrumented.
 * Linking a program to the bundle is in link.ts (it needs the JS parser, which
 * this small module must not pull into the main page bundle).
 */
export interface StdlibModuleInfo {
  /** Namespace export of the bundle holding this module, e.g. "m10". */
  ns: string;
  exports: string[];
  /** Public function name -> declared result type ("" when not declared). */
  functions: Record<string, string>;
}

export interface StdlibInfo {
  gleamVersion: string;
  stdlibVersion: string;
  prelude: { ns: string; exports: string[] };
  modules: Record<string, StdlibModuleInfo>;
}

/**
 * Result types the tracer can display faithfully. Int and Float are both JS
 * numbers at run time, so anything that could produce a Float is excluded
 * (a declared `Float`, and generic results such as `a`).
 */
export const DISPLAYABLE_RESULT_TYPES = new Set(["Int", "Bool", "String", "Nil"]);

/**
 * Functions whose declared result type is displayable but whose result is
 * different on every run. The tracer runs each program twice and compares
 * the runs, so these cannot be traced.
 */
export const NONDETERMINISTIC_FUNCTIONS = new Set(["gleam/int.random"]);

export type StdlibCallCheck = { ok: true } | { ok: false; feature: string };

/** Can a call to `module.fn` (e.g. "gleam/int", "to_string") be traced? */
export function checkStdlibCall(info: StdlibInfo, module: string, alias: string, fn: string): StdlibCallCheck {
  const mod = info.modules[module];
  const resultType = mod?.functions[fn];
  if (resultType === undefined) return { ok: false, feature: `Using ${alias}.${fn} (not a public function of ${module})` };
  if (NONDETERMINISTIC_FUNCTIONS.has(`${module}.${fn}`)) {
    return { ok: false, feature: `Calling ${alias}.${fn} (its result is different on every run)` };
  }
  if (!DISPLAYABLE_RESULT_TYPES.has(resultType)) {
    return { ok: false, feature: `Calling ${alias}.${fn} (its result type, ${resultType || "unknown"}, can't be shown yet)` };
  }
  return { ok: true };
}
