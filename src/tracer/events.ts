/** Raw execution events recorded while the compiled program runs (before normalization). */

/** [line, column, endLine, endColumn]: 1-based, endColumn exclusive. */
export type RawLoc = [number, number, number, number];

/** A value copied out of the running program at the moment it was observed. */
export type RawValue =
  | { kind: "int"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "nil" }
  /** A Gleam list: the id of its first cell (see the `node` event), or null for []. */
  | { kind: "list"; node: number | null }
  /** A value the tracer cannot display yet; `jsType` describes it (e.g. "List"). */
  | { kind: "unsupported"; jsType: string };

/** Longest string value copied out of a run (longer ones stop the run with a limit). */
export const MAX_STRING_VALUE = 10_000;
/** Budget for all String values recorded in one run, together. */
export const MAX_RECORDED_STRING_CHARS = 1_000_000;

/** Name of the per-run recorder object on globalThis (Symbol.for). */
export const RECORDER_SYMBOL = "gleam-tutor.tracer";

export type RawEvent =
  /**
   * A function was entered; args are its parameter bindings. `tail`: a self
   * tail call that the compiled program runs as a loop (a logical frame).
   */
  | { t: "call"; frame: number; fn: string; loc: RawLoc; args: [string, RawValue][]; tail?: boolean }
  /** A statement is about to be evaluated. */
  | { t: "line"; frame: number; loc: RawLoc }
  /** A `let` initializer finished; the name is now bound. */
  | { t: "bind"; frame: number; name: string; value: RawValue; loc: RawLoc }
  /** The function produced the value of its final expression. */
  | { t: "return"; frame: number; value: RawValue; loc: RawLoc }
  /** An expression statement (e.g. `io.println(x)`) finished. */
  | { t: "done"; frame: number; loc: RawLoc }
  /** The program printed `text` (exactly what the stdlib wrote, newline included). */
  | { t: "out"; text: string }
  /** A `case` clause was selected; `binds` are its pattern variables. */
  | { t: "match"; frame: number; caseId: number; loc: RawLoc; binds: [string, RawValue][] }
  /** The case expression or block `caseId` produced its value; its bindings go out of scope. */
  | { t: "close"; frame: number; caseId: number }
  /** A block started; its bindings belong to it until the matching `close`. */
  | { t: "open"; frame: number; scopeId: number }
  /**
   * A list cell seen for the first time. Cells are immutable, so each is
   * recorded once and referred to by id (shared tails stay shared).
   */
  | { t: "node"; id: number; head: RawValue; tail: number | null };

export type RunOutcome =
  | {
      status: "ok";
      events: RawEvent[];
      result: RawValue;
      /** Structural description of main()'s value, comparable across runs. */
      resultKey: string;
      /** The same for the uninstrumented run; must equal `resultKey`. */
      baselineKey: string;
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
