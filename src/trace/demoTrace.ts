/**
 * DEMO TRACE: a hand-written fixture, NOT produced by executing Gleam.
 *
 * It is valid only for DEMO_SOURCE (GT-01 in PROJECT_SPEC.md). The demo tracer
 * refuses to return it for any other source text.
 *
 * Arrow convention (shared with Phase 2): for each step,
 *  - justExecuted (green) = the source range whose evaluation produced this snapshot
 *  - nextToExecute (red) = the source range that will be evaluated next
 * A snapshot shows state AFTER justExecuted and BEFORE nextToExecute.
 * A `return` step points at the function's closing brace: the function has
 * produced the value of its last expression and its frame is now exited.
 *
 * Frames are logical evaluation frames for teaching, not the JavaScript call stack.
 */
import { hashSource, normalizeSource } from "./source";
import {
  TRACE_SCHEMA_VERSION,
  type ExecutionTrace,
  type TraceFrame,
  type TraceObject,
  type TraceStep,
  type TraceValue,
} from "./types";

export const DEMO_SOURCE = `pub fn square(x: Int) -> Int {
  x * x
}

pub fn main() {
  let a = 5
  let b = square(a)
  b
}
`;

const int = (n: number): TraceValue => ({ kind: "int", value: String(n) });
const ref = (id: string): TraceValue => ({ kind: "ref", id });

const OBJECTS: TraceObject[] = [
  { id: "fn-square", kind: "function", name: "square", signature: "fn square(x: Int) -> Int", module: "main" },
  { id: "fn-main", kind: "function", name: "main", signature: "fn main()", module: "main" },
];

const MODULE_FRAME: TraceFrame = {
  id: "module-main",
  functionName: "main",
  parentId: null,
  status: "module",
  bindings: [
    { name: "square", value: ref("fn-square") },
    { name: "main", value: ref("fn-main") },
  ],
};

function mainFrame(bindings: [string, number][], status: TraceFrame["status"] = "active", returnValue?: number): TraceFrame {
  return {
    id: "frame-main-1",
    functionName: "main",
    parentId: "module-main",
    status,
    bindings: bindings.map(([name, v]) => ({ name, value: int(v) })),
    ...(returnValue === undefined ? {} : { returnValue: int(returnValue) }),
  };
}

function squareFrame(status: TraceFrame["status"], returnValue?: number): TraceFrame {
  return {
    id: "frame-square-2",
    functionName: "square",
    parentId: "module-main",
    status,
    bindings: [{ name: "x", value: int(5) }],
    ...(returnValue === undefined ? {} : { returnValue: int(returnValue) }),
  };
}

// Source ranges in DEMO_SOURCE (1-based, endColumn exclusive).
const L = {
  squareHeader: { line: 1, column: 1, endColumn: 31 },
  squareBody: { line: 2, column: 3, endColumn: 8 }, //   x * x
  squareEnd: { line: 3, column: 1, endColumn: 2 }, //    } (square's value is produced)
  mainHeader: { line: 5, column: 1, endColumn: 16 },
  letA: { line: 6, column: 3, endColumn: 12 }, //        let a = 5
  callSquare: { line: 7, column: 11, endColumn: 20 }, // square(a)
  letB: { line: 7, column: 3, endColumn: 20 }, //        let b = square(a)
  mainResult: { line: 8, column: 3, endColumn: 4 }, //   b
  mainEnd: { line: 9, column: 1, endColumn: 2 }, //      } (main's value is produced)
};

type StepSpec = Omit<TraceStep, "index" | "stdout" | "objects" | "error">;

const STEPS: StepSpec[] = [
  {
    // 1. Entering main(): the frame exists with no bindings yet.
    event: "call",
    source: L.mainHeader,
    justExecuted: null,
    nextToExecute: L.letA,
    frames: [MODULE_FRAME, mainFrame([])],
    note: "enter main()",
  },
  {
    // 2. `let a = 5` evaluated; a is bound.
    event: "bind",
    source: L.letA,
    justExecuted: L.letA,
    nextToExecute: L.callSquare,
    frames: [MODULE_FRAME, mainFrame([["a", 5]])],
    note: "bind a = 5",
  },
  {
    // 3. Argument `a` evaluated to 5; about to call square(5). No square frame yet.
    event: "eval",
    source: L.callSquare,
    justExecuted: L.callSquare,
    nextToExecute: L.squareHeader,
    frames: [MODULE_FRAME, mainFrame([["a", 5]])],
    note: "call square(5)",
  },
  {
    // 4. square entered: new frame with parameter x = 5.
    event: "call",
    source: L.squareHeader,
    justExecuted: L.squareHeader,
    nextToExecute: L.squareBody,
    frames: [MODULE_FRAME, mainFrame([["a", 5]]), squareFrame("active")],
    note: "enter square with x = 5",
  },
  {
    // 5. `x * x` evaluated to 25, the last expression of square's body.
    event: "eval",
    source: L.squareBody,
    justExecuted: L.squareBody,
    nextToExecute: L.squareEnd,
    frames: [MODULE_FRAME, mainFrame([["a", 5]]), squareFrame("active")],
    note: "evaluate x * x = 25",
  },
  {
    // 6. square produces 25 (the value of its last expression) and exits.
    event: "return",
    source: L.squareEnd,
    justExecuted: L.squareEnd,
    nextToExecute: L.letB,
    frames: [MODULE_FRAME, mainFrame([["a", 5]]), squareFrame("exited", 25)],
    note: "square returns 25",
  },
  {
    // 7. `let b = square(a)` completes; b is bound.
    event: "bind",
    source: L.letB,
    justExecuted: L.letB,
    nextToExecute: L.mainResult,
    frames: [MODULE_FRAME, mainFrame([["a", 5], ["b", 25]]), squareFrame("exited", 25)],
    note: "bind b = 25",
  },
  {
    // 8. `b`, main's last expression, evaluated to 25.
    event: "eval",
    source: L.mainResult,
    justExecuted: L.mainResult,
    nextToExecute: L.mainEnd,
    frames: [MODULE_FRAME, mainFrame([["a", 5], ["b", 25]]), squareFrame("exited", 25)],
    note: "evaluate b = 25",
  },
  {
    // 9. main produces 25 and exits. Nothing is printed: a return value is not output.
    event: "return",
    source: L.mainEnd,
    justExecuted: L.mainEnd,
    nextToExecute: null,
    frames: [MODULE_FRAME, mainFrame([["a", 5], ["b", 25]], "exited", 25), squareFrame("exited", 25)],
    note: "main returns 25",
  },
];

export const DEMO_TRACE: ExecutionTrace = {
  schemaVersion: TRACE_SCHEMA_VERSION,
  traceKind: "fixture",
  sourceHash: hashSource(DEMO_SOURCE),
  source: normalizeSource(DEMO_SOURCE),
  target: "javascript",
  steps: STEPS.map((s, index) => ({
    ...s,
    index,
    stdout: "", // the demo program prints nothing; main's 25 is a value, not output
    objects: OBJECTS,
    error: null,
  })),
};
