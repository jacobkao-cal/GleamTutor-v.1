/** Raw execution events recorded while the compiled program runs (before normalization). */

/** [line, column, endLine, endColumn]: 1-based, endColumn exclusive. */
export type RawLoc = [number, number, number, number];

/** A value copied out of the running program at the moment it was observed. */
export type RawValue =
  | { kind: "int"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "nil" }
  /** A value the tracer cannot display yet; `jsType` describes it (e.g. "List"). */
  | { kind: "unsupported"; jsType: string };

/** Longest string value copied out of a run (longer ones stop the run with a limit). */
export const MAX_STRING_VALUE = 10_000;
/** Budget for all String values recorded in one run, together. */
export const MAX_RECORDED_STRING_CHARS = 1_000_000;

export type RawEvent =
  /** A function was entered; args are its parameter bindings. */
  | { t: "call"; frame: number; fn: string; loc: RawLoc; args: [string, RawValue][] }
  /** A statement is about to be evaluated. */
  | { t: "line"; frame: number; loc: RawLoc }
  /** A `let` initializer finished; the name is now bound. */
  | { t: "bind"; frame: number; name: string; value: RawValue; loc: RawLoc }
  /** The function produced the value of its final expression. */
  | { t: "return"; frame: number; value: RawValue; loc: RawLoc }
  /** An expression statement (e.g. `io.println(x)`) finished. */
  | { t: "done"; frame: number; loc: RawLoc }
  /** The program printed `text` (exactly what the stdlib wrote, newline included). */
  | { t: "out"; text: string };

export type RunOutcome =
  | {
      status: "ok";
      events: RawEvent[];
      result: RawValue;
      baselineResult: RawValue;
      stdout: string;
      /** Output of the uninstrumented run; must equal `stdout`. */
      baselineStdout: string;
    }
  | { status: "runtime_error"; events: RawEvent[]; message: string; stdout: string }
  | { status: "limit"; events: RawEvent[]; message: string }
  | { status: "timeout"; message: string }
  | { status: "internal_error"; message: string };

export interface RunLimits {
  /** Wall-clock budget for the worker (ms); the worker is terminated after this. */
  timeoutMs: number;
  /** Maximum recorded events. */
  maxEvents: number;
  /** Maximum logical call depth. */
  maxDepth: number;
  /** Maximum captured stdout characters. */
  maxStdout: number;
  /** V8 heap limit for the worker (MB). */
  maxHeapMb: number;
}

/** Hard ceilings: callers may lower limits but never raise them past these. */
export const MAX_LIMITS: RunLimits = {
  timeoutMs: 10_000,
  maxEvents: 50_000,
  maxDepth: 2_000,
  maxStdout: 100_000,
  maxHeapMb: 256,
};

export function clampLimits(limits: Partial<RunLimits>): RunLimits {
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(out) as (keyof RunLimits)[]) {
    const v = limits[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.min(v, MAX_LIMITS[k]);
    else if (v !== undefined) out[k] = MAX_LIMITS[k];
  }
  return out;
}

export const DEFAULT_LIMITS: RunLimits = {
  timeoutMs: 2000,
  maxEvents: 5000,
  maxDepth: 500,
  maxStdout: 10_000,
  maxHeapMb: 64,
};
