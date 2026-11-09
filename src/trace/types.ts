/**
 * Execution trace contract (schema version 1).
 *
 * A trace is a recorded sequence of snapshots. The UI never re-runs a
 * program to step backward; it only reads earlier snapshots. Every pane
 * (source arrows, Print Output, Frames, Objects) derives from one step.
 *
 * This file is UI-independent so a Phase 2 tracer can emit the same shape.
 */

export const TRACE_SCHEMA_VERSION = 1 as const;

/** `fixture` = predefined Demo trace; `real` = produced by a genuine tracer. */
export type TraceKind = "fixture" | "real";

/**
 * A source position. Lines and columns are 1-based. `endLine`/`endColumn`
 * (exclusive end) are optional and describe the expression's range.
 */
export interface SourceLocation {
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * Pedagogical event kinds. A step is a source-level teaching event, not a
 * machine instruction.
 *  - call:   a user function is entered (its frame now exists)
 *  - bind:   a `let` binding has been created after its initializer evaluated
 *  - eval:   an expression was evaluated without creating a binding
 *  - return: a function produced the value of its last expression
 */
export type TraceEventKind = "call" | "bind" | "eval" | "return";

/** Values shown in a binding cell. Primitives are inline; compound values are references. */
export type TraceValue =
  | { kind: "int"; value: string } // string so large Gleam/JS ints are not rounded
  | { kind: "float"; value: string }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "nil" }
  | { kind: "ref"; id: string }; // points at a TraceObject by logical id

/**
 * Compound values, rendered in the Objects region. `id` is a tracer label,
 * not a physical memory address.
 */
export type TraceObject =
  | { id: string; kind: "function"; name: string; signature: string; module?: string }
  | { id: string; kind: "list"; items: TraceValue[] }
  | { id: string; kind: "tuple"; items: TraceValue[] }
  | { id: string; kind: "record"; typeName: string; constructor: string; fields: { label?: string; value: TraceValue }[] };

export interface TraceBinding {
  name: string;
  value: TraceValue;
  /** Distinguishes a re-bound (shadowed) name; optional until shadowing is supported. */
  bindingId?: string;
}

/**
 * - module:  module-level definitions (functions/constants). This is NOT a
 *            mutable Python-style globals dictionary.
 * - active:  a call currently being evaluated.
 * - exited:  a call that has produced its value and is no longer active.
 */
export type FrameStatus = "module" | "active" | "exited";

export interface TraceFrame {
  id: string;
  functionName: string;
  parentId: string | null;
  status: FrameStatus;
  bindings: TraceBinding[];
  /** Present once the call has produced its result. */
  returnValue?: TraceValue;
}

export interface TraceError {
  kind: "compile" | "runtime" | "limit";
  message: string;
  location?: SourceLocation;
}

export interface TraceStep {
  index: number;
  event: TraceEventKind;
  /** Location of the operation this step records. */
  source: SourceLocation;
  /** Green arrow: location just evaluated, or null when nothing has run yet. */
  justExecuted: SourceLocation | null;
  /** Red arrow: next location to evaluate, or null when evaluation is finished. */
  nextToExecute: SourceLocation | null;
  /** Cumulative output printed so far. */
  stdout: string;
  /** Frames in creation order (module first). */
  frames: TraceFrame[];
  objects: TraceObject[];
  error: TraceError | null;
  /** Short note for tooling/tests; not displayed as a teaching panel. */
  note?: string;
}

export interface ExecutionTrace {
  schemaVersion: typeof TRACE_SCHEMA_VERSION;
  traceKind: TraceKind;
  /** Hash of the exact source text this trace belongs to. */
  sourceHash: string;
  source: string;
  target: "javascript";
  steps: TraceStep[];
}
