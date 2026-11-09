/**
 * Maps the engine's detailed result to the UI-facing TraceResult, with
 * student-friendly messages. Raw events, compiled JS and other debugging
 * fields are dropped here; they never reach the UI.
 */
import type { TraceResult } from "../trace/tracer";
import { STDLIB_VERSION } from "./toolchainFiles";
import type { EngineResult } from "./traceGleam";

export const SUPPORTED_SUMMARY =
  "So far the tracer can step through Int, Bool, String and Nil values, let bindings (including shadowing), " +
  "arithmetic, comparisons, && and ||, string concatenation with <>, calls to functions defined in your program " +
  "(including recursion), and gleam_stdlib functions such as io.println and int.to_string.";

/** Extra help for compiler errors about imports. */
function compileHint(title: string): string {
  return title === "Unknown module" ? `. Only the Gleam standard library (gleam_stdlib ${STDLIB_VERSION}) can be imported` : "";
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

export function unsupportedMessage(feature: string): string {
  return `Step-by-step tracing doesn't support ${lowerFirst(feature)} yet. ${SUPPORTED_SUMMARY}`;
}

export function toTraceResult(r: EngineResult): TraceResult {
  switch (r.status) {
    case "ok":
      return { status: "ok", trace: r.trace };
    case "compile_error": {
      const d = r.diagnostic;
      return {
        status: "compile_error",
        message: `The Gleam compiler found a problem: ${d.title}${compileHint(d.title)}`,
        ...(d.line ? { location: { line: d.line, ...(d.column ? { column: d.column } : {}) } } : {}),
        details: d.message,
      };
    }
    case "unsupported":
      return {
        status: "unsupported",
        feature: r.feature,
        message: r.feature === "Compiled code shape" || r.feature === "Recorded value" ? `Step-by-step tracing stopped: ${r.message}. ${SUPPORTED_SUMMARY}` : unsupportedMessage(r.feature),
        ...(r.line ? { location: { line: r.line, ...(r.column ? { column: r.column } : {}) } } : {}),
      };
    case "runtime_error":
      return { status: "runtime_error", message: `Your program crashed while running: ${r.message}`, trace: r.trace };
    case "timeout":
      return { status: "timeout", message: `${r.message}. Does your program recurse forever?` };
    case "limit":
      return { status: "limit", message: `The run was stopped: ${r.message}.` };
    case "internal_error":
      return { status: "internal_error", message: `Gleam Tutor hit an internal problem (not a mistake in your code): ${r.message}` };
  }
}
