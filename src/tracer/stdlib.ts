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

/** Concrete types the tracer can display faithfully. */
const DISPLAYABLE_NAMES = new Set(["Int", "Bool", "String", "Nil"]);

/**
 * Can values of this declared result type be shown faithfully?
 *
 * Allowed: Int, Bool, String, Nil, List(...) of those, and type variables
 * (`a`, `acc`). A type variable is safe because a generic function can only
 * return values that came in through its arguments, and every value a traced
 * program can make is already displayable: Floats (indistinguishable from
 * Ints at run time), tuples, custom types and functions are refused where
 * they would be created. Everything else (Float, Result, Option, Dict, ...)
 * is refused.
 */
export function isDisplayableType(type: string): boolean {
  const compact = type.replace(/\s+/g, "");
  const toks = compact.match(/[A-Za-z_]\w*|[(),]/g) ?? [];
  if (!compact || toks.join("") !== compact) return false;
  return toks.every((t, i) => /^[(),]$/.test(t) || /^[a-z]/.test(t) || DISPLAYABLE_NAMES.has(t) || (t === "List" && toks[i + 1] === "("));
}

/**
 * Functions whose declared result type is displayable but whose result is
 * different on every run. The tracer runs each program twice and compares
 * the runs, so these cannot be traced.
 */
export const NONDETERMINISTIC_FUNCTIONS = new Set(["gleam/int.random", "gleam/float.random", "gleam/list.shuffle", "gleam/list.sample"]);

export type StdlibCallCheck = { ok: true } | { ok: false; feature: string };

/**
 * Can a call to `fn` of `module` (e.g. "gleam/int", "to_string") be traced?
 * `shown` is how the call is written in the program: "int.to_string" or,
 * for an unqualified import, "to_string".
 */
export function checkStdlibCall(info: StdlibInfo, module: string, shown: string, fn: string): StdlibCallCheck {
  const mod = info.modules[module];
  const resultType = mod?.functions[fn];
  if (resultType === undefined) return { ok: false, feature: `Using ${shown} (not a public function of ${module})` };
  if (NONDETERMINISTIC_FUNCTIONS.has(`${module}.${fn}`)) {
    return { ok: false, feature: `Calling ${shown} (its result is different on every run)` };
  }
  if (!isDisplayableType(resultType)) {
    return { ok: false, feature: `Calling ${shown} (its result type, ${resultType || "unknown"}, can't be shown yet)` };
  }
  return { ok: true };
}
