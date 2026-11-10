/**
 * Phase 3B: recursion and scope, traced from real runs.
 *  - Logical frames for self tail calls (which the compiled program runs as a
 *    loop), labelled only where the official compiler really made a loop.
 *  - Blocks `{ ... }` anywhere, with their own scope.
 * Requires the pinned toolchain: npm run tracer:setup
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GT_EXAMPLES } from "../../examples.js";
import type { ExecutionTrace, TraceStep, TraceValue } from "../../src/trace/types";
import { instrumentSource, loopFunctionsIn } from "../../src/tracer/instrument";
import { parseSubset } from "../../src/tracer/subset";
import { toolchainAvailable } from "../compiler";
import { expectOk, traceGleam } from "./helpers";

beforeAll(() => {
  if (!toolchainAvailable()) throw new Error("Gleam toolchain missing. Run: npm run tracer:setup");
});

const last = (t: ExecutionTrace) => t.steps[t.steps.length - 1];
const userFrames = (s: TraceStep) => s.frames.filter((f) => f.status !== "module");
const val = (v: TraceValue | undefined) => (v && "value" in v ? String(v.value) : v?.kind ?? "?");
const vars = (s: TraceStep, id: string) => Object.fromEntries(s.frames.find((f) => f.id === id)!.bindings.map((b) => [b.name, val(b.value)]));
/** "name(args) -> result" for every user frame at the end, with [tail] on logical frames. */
const frames = (t: ExecutionTrace) =>
  userFrames(last(t)).map(
    (f) =>
      `${f.functionName}(${f.bindings
        .filter((_, i) => i < 2)
        .map((b) => val(b.value))
        .join(", ")}) -> ${val(f.returnValue)}${f.tailCall ? " [tail]" : ""}`,
  );

const GT06 = `pub fn count_down(n: Int, acc: Int) -> Int {
  case n {
    0 -> acc
    _ -> count_down(n - 1, acc + 1)
  }
}

pub fn main() {
  count_down(3, 0)
}
`;

describe("tail recursion: logical frames", () => {
  it("GT-06: count_down(3, 0) is 3; the recursive tail calls are labelled as logical frames", async () => {
    const r = expectOk(await traceGleam(GT06));
    expect(r.result).toMatchObject({ value: "3" });
    // The compiled (uninstrumented) program really is a loop...
    expect(r.compiledJs).toMatch(/function count_down\(loop\$n, loop\$acc\)\s*\{\s*while \(true\)/);
    // ...so the frame main creates is a real call, and each later call is a logical frame.
    expect(frames(r.trace)).toEqual([
      "main() -> 3",
      "count_down(3, 0) -> 3",
      "count_down(2, 1) -> 3 [tail]",
      "count_down(1, 2) -> 3 [tail]",
      "count_down(0, 3) -> 3 [tail]",
    ]);
  });

  it("GT-05 / factorial: non-tail recursion is never labelled", async () => {
    const r = expectOk(await traceGleam(GT_EXAMPLES.find((e) => e.id === "recursion")!.code));
    expect(last(r.trace).stdout).toBe("24\n");
    expect(userFrames(last(r.trace)).some((f) => f.tailCall)).toBe(false);
    expect(loopFunctionsIn(r.compiledJs).size).toBe(0);
  });

  it("mutual recursion is not compiled to a loop, so it is not labelled", async () => {
    const r = expectOk(
      await traceGleam(`pub fn is_even(n: Int) -> Bool {
  case n {
    0 -> True
    _ -> is_odd(n - 1)
  }
}

pub fn is_odd(n: Int) -> Bool {
  case n {
    0 -> False
    _ -> is_even(n - 1)
  }
}

pub fn main() {
  is_even(3)
}
`),
    );
    expect(r.result).toMatchObject({ kind: "bool", value: false });
    expect(frames(r.trace)).toEqual(["main() -> false", "is_even(3) -> false", "is_odd(2) -> false", "is_even(1) -> false", "is_odd(0) -> false"]);
  });

  it("the labels agree with the compiler for every library example", async () => {
    for (const ex of GT_EXAMPLES) {
      const r = await traceGleam(ex.code);
      if (r.status !== "ok") continue;
      const loops = loopFunctionsIn(r.compiledJs);
      for (const f of userFrames(last(r.trace))) {
        if (f.tailCall) expect(loops.has(f.functionName), `${ex.id}: ${f.functionName}`).toBe(true);
      }
    }
  }, 90_000); // traces all 20 examples

  it("the Tail calls example: one real frame, then logical frames, same output as the real program", async () => {
    const r = expectOk(await traceGleam(GT_EXAMPLES.find((e) => e.id === "tail-calls")!.code));
    const tagged = userFrames(last(r.trace)).filter((f) => f.tailCall);
    expect(tagged.length).toBeGreaterThan(0);
    const fn = tagged[0].functionName;
    const all = userFrames(last(r.trace)).filter((f) => f.functionName === fn);
    expect(all[0].tailCall).toBeFalsy(); // the call from outside is a real call
    expect(all.slice(1).every((f) => f.tailCall)).toBe(true);
  });

  it("a tail call found inside a block or a nested case is labelled too", async () => {
    const r = expectOk(
      await traceGleam(`pub fn go(n: Int, acc: Int) -> Int {
  case n > 0 {
    False -> acc
    True -> {
      let next = n - 1
      case next {
        0 -> go(next, acc + 10)
        _ -> go(next, acc + 1)
      }
    }
  }
}

pub fn main() {
  go(3, 0)
}
`),
    );
    expect(loopFunctionsIn(r.compiledJs)).toEqual(new Set(["go"]));
    expect(frames(r.trace)).toEqual(["main() -> 12", "go(3, 0) -> 12", "go(2, 1) -> 12 [tail]", "go(1, 2) -> 12 [tail]", "go(0, 12) -> 12 [tail]"]);
  });

  it("deep tail recursion is bounded by the call-depth limit (every logical frame counts)", async () => {
    const r = await traceGleam(GT06.replace("count_down(3, 0)", "count_down(100, 0)"), { maxDepth: 50 });
    expect(r).toMatchObject({ status: "limit", message: "Call depth exceeded 50" });
  });
});

describe("loopFunctionsIn and the tail-call marker", () => {
  it("reads which functions the compiler made loops", () => {
    expect(loopFunctionsIn("export function f(loop$n) {\n  while (true) {\n    let n = loop$n;\n  }\n}\nexport function g(n) {\n  return g(n);\n}\n")).toEqual(new Set(["f"]));
  });

  it("marks only self tail calls, and only in loop functions", () => {
    const src = `pub fn f(n: Int) -> Int {\n  case n {\n    0 -> 0\n    _ -> f(n - 1)\n  }\n}\n\npub fn g(n: Int) -> Int {\n  case n {\n    0 -> 0\n    _ -> 1 + g(n - 1)\n  }\n}\n\npub fn main() {\n  f(2) + g(2)\n}\n`;
    const m = parseSubset(src);
    const marked = instrumentSource(src, m, { loopFunctions: new Set(["f"]) }).split("// ----")[0];
    expect(marked).toContain('f(gleam_tutor_tail(gleam_tutor_frame, "f", n - 1))');
    expect(marked).not.toContain('"g", n - 1');
    const unmarked = instrumentSource(src, m, { loopFunctions: new Set() }).split("// ----")[0];
    expect(unmarked).not.toContain("gleam_tutor_tail(");
  });
});

describe("blocks and scope", () => {
  it("a block's bindings are visible inside it and gone after it", async () => {
    const r = expectOk(
      await traceGleam(`pub fn main() {
  let y = {
    let a = 1
    a + 1
  }
  y * 10
}
`),
    );
    const inside = r.trace.steps.find((s) => s.note === "bind a")!;
    expect(vars(inside, "frame-main-1")).toEqual({ a: "1" });
    const after = r.trace.steps.find((s) => s.note === "bind y")!;
    expect(vars(after, "frame-main-1")).toEqual({ y: "2" });
    expect(r.result).toMatchObject({ value: "20" });
  });

  it("shadowing inside a block ends with the block: the outer binding is visible again", async () => {
    const r = expectOk(
      await traceGleam(`pub fn main() {
  let x = 1
  let y = {
    let x = 10
    x + 1
  }
  x + y
}
`),
    );
    const steps = r.trace.steps;
    const innerX = steps.find((s) => s.note === "bind x" && s.source.line === 4)!;
    expect(innerX.frames[1].bindings.map((b) => [b.name, val(b.value), b.bindingId])).toEqual([["x", "10", "frame-main-1:x#2"]]);
    const end = last(r.trace);
    expect(end.frames[1].bindings.map((b) => [b.name, val(b.value), b.bindingId])).toEqual([
      ["x", "1", "frame-main-1:x#1"],
      ["y", "11", "frame-main-1:y#1"],
    ]);
    expect(r.result).toMatchObject({ value: "12" });
  });

  it("blocks group expressions, and can be a function's result", async () => {
    const r = expectOk(
      await traceGleam(`fn area(w: Int, h: Int) -> Int {
  {
    let inner = w * h
    inner + 0
  }
}

pub fn main() {
  let g = { 1 + 2 } * 3
  area(g, 2)
}
`),
    );
    expect(vars(r.trace.steps.find((s) => s.note === "bind g")!, "frame-main-1")).toEqual({ g: "9" });
    expect(r.result).toMatchObject({ value: "18" });
    const areaFrame = userFrames(last(r.trace)).find((f) => f.functionName === "area")!;
    expect(areaFrame.returnValue).toMatchObject({ value: "18" });
  });

  it("return values propagate through nested calls inside blocks", async () => {
    const r = expectOk(
      await traceGleam(`fn double(x: Int) -> Int {
  x * 2
}

fn quad(x: Int) -> Int {
  let once = { double(x) }
  double(once)
}

pub fn main() {
  quad(5)
}
`),
    );
    expect(frames(r.trace)).toEqual(["main() -> 20", "quad(5, 10) -> 20", "double(5) -> 10", "double(10) -> 20"]);
  });
});

describe("playback stays deterministic", () => {
  it("tracing the same program twice gives identical traces; arrows follow events", async () => {
    const a = expectOk(await traceGleam(GT06));
    const b = expectOk(await traceGleam(GT06));
    expect(JSON.stringify(b.trace)).toBe(JSON.stringify(a.trace));
    a.trace.steps.forEach((s, i) => {
      expect(s.justExecuted).toEqual(i === 0 ? null : s.source);
      expect(s.nextToExecute).toEqual(a.trace.steps[i + 1]?.source ?? null);
    });
  });
});
