/**
 * The boundary between the UI and whatever produces traces.
 *
 * Phase 1 ships only `demoTracer`, which returns the fixture for the exact
 * demo source and reports everything else as unsupported. Phase 2 can add a
 * real tracer (compile + instrumented run in a Worker) that implements the
 * same interface; the UI does not need to change.
 */
import { DEMO_TRACE } from "./demoTrace";
import { hashSource } from "./source";
import type { ExecutionTrace, SourceLocation } from "./types";
import { validateTrace } from "./validate";

export type TraceResult =
  | { status: "ok"; trace: ExecutionTrace }
  | { status: "compile_error"; message: string; location?: SourceLocation }
  | { status: "unsupported"; message: string };

export interface Tracer {
  trace(source: string): Promise<TraceResult>;
}

export const UNSUPPORTED_MESSAGE =
  "Gleam Tutor cannot trace this program yet. Real Gleam execution tracing is not implemented; " +
  "only the built-in demo example has a (predefined) Demo trace.";

export const demoTracer: Tracer = {
  async trace(source) {
    if (hashSource(source) !== DEMO_TRACE.sourceHash) {
      return { status: "unsupported", message: UNSUPPORTED_MESSAGE };
    }
    const problems = validateTrace(DEMO_TRACE, source);
    if (problems.length > 0) {
      return { status: "unsupported", message: "Demo trace is invalid: " + problems.join("; ") };
    }
    return { status: "ok", trace: DEMO_TRACE };
  },
};
