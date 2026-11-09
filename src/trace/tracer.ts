/**
 * The boundary between the UI and whatever produces traces.
 *
 * `demoTracer` returns the predefined fixture for the exact demo source and
 * reports everything else as unsupported. The Phase 2B real tracing engine
 * (src/tracer/) produces the same TraceResult; see src/tracer/toTraceResult.ts.
 */
import { DEMO_TRACE } from "./demoTrace";
import { hashSource } from "./source";
import type { ExecutionTrace, SourceLocation } from "./types";
import { validateTrace } from "./validate";

export type TraceResult =
  | { status: "ok"; trace: ExecutionTrace }
  /** `details` is the official compiler's full diagnostic text. */
  | { status: "compile_error"; message: string; location?: SourceLocation; details?: string }
  /** `feature` is set when a real tracer names the construct it cannot trace yet. */
  | { status: "unsupported"; message: string; feature?: string; location?: SourceLocation }
  /** The program crashed while running. `trace` holds the steps up to the crash, if any. */
  | { status: "runtime_error"; message: string; trace: ExecutionTrace | null }
  | { status: "timeout"; message: string }
  /** A resource limit (steps, call depth, memory, trace size) stopped the run. */
  | { status: "limit"; message: string }
  /** A bug in Gleam Tutor itself, not in the student's program. */
  | { status: "internal_error"; message: string };

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

/**
 * Uses the predefined Demo trace for the exact demo source and `real` for
 * everything else, so the fixture is never used for edited code.
 */
export function withDemoFixture(real: Tracer): Tracer {
  return {
    trace(source) {
      return hashSource(source) === DEMO_TRACE.sourceHash ? demoTracer.trace(source) : real.trace(source);
    },
  };
}
