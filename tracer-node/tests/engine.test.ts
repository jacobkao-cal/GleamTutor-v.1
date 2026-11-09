/**
 * Phase 2B engine tests: golden traces, the error taxonomy end to end, the
 * UI-facing result mapping, and the demo-fixture switch. Requires the pinned toolchain: npm run tracer:setup
 */
import { beforeAll, describe, expect, it } from "vitest";
import { DEMO_SOURCE } from "../../src/trace/demoTrace";
import { demoTracer, withDemoFixture, type Tracer } from "../../src/trace/tracer";
import type { ExecutionTrace, SourceLocation } from "../../src/trace/types";
import type { TracerRuntime } from "../../src/tracer/runtime";
import { toTraceResult } from "../../src/tracer/toTraceResult";
import { MAX_SOURCE_CHARS, traceGleam as engineTrace } from "../../src/tracer/traceGleam";
import { toolchainAvailable } from "../compiler";
import { nodeRuntime } from "../nodeRuntime";
import { expectOk, stepSummary, traceGleam } from "./helpers";

beforeAll(() => {
  if (!toolchainAvailable()) throw new Error("Gleam toolchain missing. Run: npm run tracer:setup");
});

const at = (l: SourceLocation | null) => (l ? `${l.line}:${l.column}` : "-");
/** One line per step: event, green arrow, red arrow, frames. */
const golden = (t: ExecutionTrace) => t.steps.map((s) => `${at(s.justExecuted)} -> ${at(s.nextToExecute)}  ${stepSummary(s)}`);

const GT03 = `pub fn main() {
  let x = 1
  let y = x
  let x = 2
  #(x, y)
}
`;
const GT03_WITHOUT_TUPLE = GT03.replace("#(x, y)", "x * 10 + y");

describe("golden traces", () => {
  it("GT-01: square(5), every step and both arrows", async () => {
    const r = expectOk(await traceGleam(DEMO_SOURCE));
    expect(r.result).toEqual({ kind: "int", value: "25" });
    expect(r.trace.steps.every((s) => s.stdout === "")).toBe(true); // main's value is never printed
    expect(golden(r.trace)).toEqual([
      "- -> 6:3  call@5 main[]",
      "6:3 -> 7:3  bind@6 main[a=5]",
      "7:3 -> 1:1  eval@7 main[a=5]",
      "1:1 -> 2:3  call@1 main[a=5] square[x=5]",
      "2:3 -> 7:3  return@2 main[a=5] square![x=5 => 25]",
      "7:3 -> 8:3  bind@7 main[a=5 b=25] square![x=5 => 25]",
      "8:3 -> -  return@8 main![a=5 b=25 => 25] square![x=5 => 25]",
    ]);
  });

  it("GT-01: the real trace ends in the same state as the predefined Demo trace", async () => {
    const real = expectOk(await traceGleam(DEMO_SOURCE)).trace;
    const demo = await demoTracer.trace(DEMO_SOURCE);
    if (demo.status !== "ok") throw new Error("demo trace missing");
    const finalState = (t: ExecutionTrace) =>
      t.steps[t.steps.length - 1].frames.map((f) => ({
        fn: f.functionName,
        status: f.status,
        bindings: f.bindings.map((b) => [b.name, b.value]),
        ret: f.returnValue,
      }));
    expect(finalState(real)).toEqual(finalState(demo.trace));
  });

  it("GT-03 as written uses a tuple, which is refused with its location", async () => {
    const r = await traceGleam(GT03);
    expect(r).toMatchObject({ status: "unsupported", feature: "Tuples", line: 5, column: 3 });
  });

  it("GT-03 without the tuple: re-binding x does not change y", async () => {
    const r = expectOk(await traceGleam(GT03_WITHOUT_TUPLE));
    expect(r.result).toEqual({ kind: "int", value: "21" });
    expect(golden(r.trace)).toEqual([
      "- -> 2:3  call@1 main[]",
      "2:3 -> 3:3  bind@2 main[x=1]",
      "3:3 -> 4:3  bind@3 main[x=1 y=1]",
      "4:3 -> 5:3  bind@4 main[y=1 x=2]",
      "5:3 -> -  return@5 main![y=1 x=2 => 21]",
    ]);
    const main = r.trace.steps[3].frames[1];
    expect(main.bindings.map((b) => b.bindingId)).toEqual(["frame-main-1:y#1", "frame-main-1:x#2"]);
    // The earlier snapshot still shows the first x: shadowing never rewrites history.
    expect(r.trace.steps[2].frames[1].bindings.map((b) => b.bindingId)).toEqual(["frame-main-1:x#1", "frame-main-1:y#1"]);
  });

  it("covers the 2B target list: literals, arithmetic, comparisons, Bool logic, several parameters", async () => {
    const src = `fn clamp(low: Int, x: Int, high: Int) -> Int {
  let below = x < low
  let above = x > high
  let inside = !below && !above
  let tmp = high * 0 + x
  tmp - 0 * low
}

fn is_even(n: Int) -> Bool {
  n % 2 == 0
}

pub fn main() {
  let a = clamp(1, -4 + 9, 10)
  let b = is_even(a)
  let c = a != 5 || b
  c == False
}
`;
    const r = expectOk(await traceGleam(src));
    expect(r.result).toEqual({ kind: "bool", value: true });
    const last = r.trace.steps[r.trace.steps.length - 1];
    const byName = Object.fromEntries(last.frames.map((f) => [f.functionName, f]));
    expect(byName.clamp.bindings.map((b) => [b.name, b.value])).toEqual([
      ["low", { kind: "int", value: "1" }],
      ["x", { kind: "int", value: "5" }],
      ["high", { kind: "int", value: "10" }],
      ["below", { kind: "bool", value: false }],
      ["above", { kind: "bool", value: false }],
      ["inside", { kind: "bool", value: true }],
      ["tmp", { kind: "int", value: "5" }],
    ]);
    expect(byName.is_even.returnValue).toEqual({ kind: "bool", value: false });
    expect(byName.main.bindings.map((b) => [b.name, b.value])).toEqual([
      ["a", { kind: "int", value: "5" }],
      ["b", { kind: "bool", value: false }],
      ["c", { kind: "bool", value: false }],
    ]);
  });
});

describe("error taxonomy, end to end", () => {
  it("syntax error: the official compiler's diagnostic with its location", async () => {
    const r = await traceGleam("pub fn main() {\n  let x = 1 +\n}\n");
    expect(r).toMatchObject({ status: "compile_error", diagnostic: { title: "Syntax error", line: 2, column: 13 } });
  });

  it("type error", async () => {
    const r = await traceGleam("pub fn main() {\n  let x = 1\n  x + True\n}\n");
    expect(r).toMatchObject({ status: "compile_error", diagnostic: { title: "Type mismatch", line: 3, column: 7 } });
  });

  it("unknown variable", async () => {
    const r = await traceGleam("pub fn main() {\n  y\n}\n");
    expect(r).toMatchObject({ status: "compile_error", diagnostic: { title: "Unknown variable", line: 2 } });
  });

  it("unsupported construct, after the compiler accepted it", async () => {
    const r = await traceGleam("pub fn main() {\n  case 1 {\n    _ -> 2\n  }\n}\n");
    expect(r).toMatchObject({ status: "unsupported", feature: "case expressions", line: 2, column: 3 });
  });

  it("runaway recursion stops at the call-depth limit", async () => {
    const r = await traceGleam("fn down(n: Int) -> Int {\n  1 + down(n + 1)\n}\n\npub fn main() {\n  down(0)\n}\n", { maxDepth: 50 });
    expect(r).toMatchObject({ status: "limit", message: "Call depth exceeded 50" });
  });

  it("too many steps stops at the event limit", async () => {
    const src = "fn f(n: Int) -> Int {\n  g(n) + g(n)\n}\n\nfn g(n: Int) -> Int {\n  n\n}\n\npub fn main() {\n  f(1) + f(2) + f(3)\n}\n";
    const r = await traceGleam(src, { maxEvents: 10 });
    expect(r).toMatchObject({ status: "limit", message: "Trace is longer than 10 events" });
  });

  it("oversized source is refused before compiling", async () => {
    const r = await traceGleam("// " + "x".repeat(MAX_SOURCE_CHARS) + "\npub fn main() {\n  1\n}\n");
    expect(r.status).toBe("limit");
  });

  // The Runtime seam lets the remaining outcomes be tested without contrived programs.
  const SIMPLE = "pub fn main() {\n  let a = 2\n  a * 3\n}\n";
  const withExecute = (execute: TracerRuntime["execute"]): TracerRuntime => ({ ...nodeRuntime, execute });

  it("timeout from the runtime is passed through", async () => {
    const r = await engineTrace(SIMPLE, withExecute(async () => ({ status: "timeout", message: "Execution took longer than 2000 ms and was stopped" })));
    expect(r).toEqual({ status: "timeout", message: "Execution took longer than 2000 ms and was stopped" });
  });

  it("runtime error keeps the partial trace and marks its last step with the error", async () => {
    const r = await engineTrace(
      SIMPLE,
      withExecute(async () => ({
        status: "runtime_error",
        message: "RangeError: boom",
        stdout: "",
        events: [
          { t: "call", frame: 1, fn: "main", loc: [1, 1, 1, 16], args: [] },
          { t: "line", frame: 1, loc: [2, 3, 2, 12] },
        ],
      })),
    );
    if (r.status !== "runtime_error") throw new Error(r.status);
    expect(r.trace?.steps).toHaveLength(2);
    expect(r.trace?.steps[1].error).toEqual({ kind: "runtime", message: "RangeError: boom" });
  });

  it("a compiler crash is an internal error, not the student's mistake", async () => {
    const r = await engineTrace(SIMPLE, { ...nodeRuntime, compile: async () => Promise.reject(new Error("wasm trap")) });
    expect(r).toEqual({ status: "internal_error", message: "Compiler failed: wasm trap" });
  });

  it("the differential check catches instrumentation that changes the result", async () => {
    const r = await engineTrace(
      SIMPLE,
      withExecute(async () => ({
        status: "ok",
        events: [],
        stdout: "",
        baselineStdout: "",
        result: { kind: "int", value: "7" },
        baselineResult: { kind: "int", value: "6" },
      })),
    );
    expect(r.status).toBe("internal_error");
  });

  it("the differential check also compares printed output", async () => {
    const r = await engineTrace(
      SIMPLE,
      withExecute(async () => ({
        status: "ok",
        events: [],
        stdout: "a\n",
        baselineStdout: "b\n",
        result: { kind: "int", value: "6" },
        baselineResult: { kind: "int", value: "6" },
      })),
    );
    expect(r).toEqual({ status: "internal_error", message: "The instrumented program printed different output from the uninstrumented one" });
  });

  it("limits passed to the runtime are clamped to the hard ceilings", async () => {
    let seen: unknown;
    await engineTrace(SIMPLE, withExecute(async (_p, lim) => ((seen = lim), { status: "timeout", message: "x" })), { timeoutMs: 1e9, maxDepth: Infinity });
    expect(seen).toMatchObject({ timeoutMs: 10_000, maxDepth: 2_000 });
  });
});

describe("UI-facing results (toTraceResult)", () => {
  it("compile errors keep the official diagnostic as details", async () => {
    const r = toTraceResult(await traceGleam("pub fn main() {\n  y\n}\n"));
    expect(r).toMatchObject({ status: "compile_error", message: "The Gleam compiler found a problem: Unknown variable", location: { line: 2, column: 3 } });
    expect(r.status === "compile_error" && r.details).toContain("main.gleam:2:3");
  });

  it("unsupported features are named in plain words, with their location", async () => {
    const r = toTraceResult(await traceGleam("pub fn main() {\n  case 1 {\n    _ -> 2\n  }\n}\n"));
    expect(r).toMatchObject({ status: "unsupported", feature: "case expressions", location: { line: 2, column: 3 } });
    expect(r.status === "unsupported" && r.message).toMatch(/^Step-by-step tracing doesn't support case expressions yet\./);
  });

  it("ok results carry only the trace (no compiled JS or raw events)", async () => {
    const r = toTraceResult(await traceGleam(DEMO_SOURCE));
    expect(Object.keys(r).sort()).toEqual(["status", "trace"]);
  });

  it("limits, timeouts and internal errors become messages", () => {
    expect(toTraceResult({ status: "limit", message: "Call depth exceeded 500", events: [] })).toEqual({ status: "limit", message: "The run was stopped: Call depth exceeded 500." });
    expect(toTraceResult({ status: "timeout", message: "Took too long" }).status).toBe("timeout");
    expect(toTraceResult({ status: "internal_error", message: "x" })).toMatchObject({ status: "internal_error", message: expect.stringContaining("not a mistake in your code") });
  });
});

describe("withDemoFixture", () => {
  const real: Tracer = { trace: async () => ({ status: "timeout", message: "real tracer was used" }) };
  it("uses the predefined Demo trace only for the exact demo source", async () => {
    const r = await withDemoFixture(real).trace(DEMO_SOURCE);
    expect(r.status === "ok" && r.trace.traceKind).toBe("fixture");
  });
  it("uses the real tracer for any edit", async () => {
    expect(await withDemoFixture(real).trace(DEMO_SOURCE.replace("let a = 5", "let a = 6"))).toEqual({ status: "timeout", message: "real tracer was used" });
  });
});

