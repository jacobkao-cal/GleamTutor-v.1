/**
 * End-to-end POC tests: official compiler -> instrumentation -> isolated run.
 * Requires the pinned toolchain: npm run tracer:setup
 */
import { beforeAll, describe, expect, it } from "vitest";
import { hashSource } from "../../src/trace/source";
import { validateTrace } from "../../src/trace/validate";
import { toolchainAvailable } from "../compiler";
import { traceGleam } from "./helpers";
import { eventSummary, expectOk, stepSummary } from "./helpers";

beforeAll(() => {
  if (!toolchainAvailable()) throw new Error("Gleam toolchain missing. Run: npm run tracer:setup");
});

const squareProgram = (a: number | string, body = "x * x") => `pub fn square(x: Int) -> Int {
  ${body}
}

pub fn main() {
  let a = ${a}
  let b = square(a)
  b
}
`;

describe("GT-01 square: the trace follows the input", () => {
  it("a = 5 gives 25, recorded step by step", async () => {
    const r = expectOk(await traceGleam(squareProgram(5)));
    expect(r.result).toEqual({ kind: "int", value: "25" });
    expect(eventSummary(r)).toEqual([
      "call main()",
      "line 6",
      "bind a=5",
      "line 7",
      "call square(x=5)",
      "line 2",
      "return 25",
      "bind b=25",
      "line 8",
      "return 25",
    ]);
    expect(r.trace.steps.map(stepSummary)).toEqual([
      "call@5 main[]",
      "bind@6 main[a=5]",
      "eval@7 main[a=5]",
      "call@1 main[a=5] square[x=5]",
      "return@2 main[a=5] square![x=5 => 25]",
      "bind@7 main[a=5 b=25] square![x=5 => 25]",
      "return@8 main![a=5 b=25 => 25] square![x=5 => 25]",
    ]);
  });

  it("a = 7 gives 49 and every recorded value changes accordingly", async () => {
    const r = expectOk(await traceGleam(squareProgram(7)));
    expect(r.result).toEqual({ kind: "int", value: "49" });
    expect(eventSummary(r)).toEqual([
      "call main()",
      "line 6",
      "bind a=7",
      "line 7",
      "call square(x=7)",
      "line 2",
      "return 49",
      "bind b=49",
      "line 8",
      "return 49",
    ]);
  });

  it.each([0, 1, -4, 12, 1000, 123456])("a = %i: bindings and return values match a*a", async (n) => {
    const r = expectOk(await traceGleam(squareProgram(n)));
    const sq = String(n * n);
    expect(r.result).toEqual({ kind: "int", value: sq });
    expect(eventSummary(r)).toContain(`bind a=${n}`);
    expect(eventSummary(r)).toContain(`call square(x=${n})`);
    expect(eventSummary(r)).toContain(`bind b=${sq}`);
  });

  it.each([
    ["x * x + 1", (x: number) => x * x + 1],
    ["x * 3 - 2", (x: number) => x * 3 - 2],
    ["x - x * x", (x: number) => x - x * x],
  ])("a different body (%s) changes the recorded results", async (body, f) => {
    const r = expectOk(await traceGleam(squareProgram(6, body)));
    expect(r.result.kind === "int" && r.result.value).toBe(String(f(6)));
  });

  it("produces a valid, real-kind trace tied to the exact source", async () => {
    const src = squareProgram(5);
    const r = expectOk(await traceGleam(src));
    expect(r.trace.traceKind).toBe("real");
    expect(r.trace.sourceHash).toBe(hashSource(src));
    expect(validateTrace(r.trace, src)).toEqual([]);
    expect(validateTrace(r.trace, squareProgram(7))).toContain("trace does not belong to this source");
  });

  it("arrows chain: each green arrow is the previous red arrow", async () => {
    const { trace } = expectOk(await traceGleam(squareProgram(5)));
    expect(trace.steps[0].justExecuted).toBeNull();
    expect(trace.steps.at(-1)!.nextToExecute).toBeNull();
    for (let i = 1; i < trace.steps.length; i++) expect(trace.steps[i].justExecuted).toEqual(trace.steps[i - 1].nextToExecute);
  });

  it("earlier snapshots are not changed by later events", async () => {
    const { trace } = expectOk(await traceGleam(squareProgram(5)));
    const main0 = trace.steps[0].frames.find((f) => f.functionName === "main" && f.status !== "module")!;
    expect(main0.bindings).toEqual([]);
    expect(main0.status).toBe("active");
    expect(main0.returnValue).toBeUndefined();
  });
});

describe("other program structures (not the square example)", () => {
  it("add(3, 4): argument bindings, return value, resumption of main", async () => {
    const r = expectOk(
      await traceGleam(`pub fn add(a: Int, b: Int) -> Int {\n  a + b\n}\n\npub fn main() {\n  let result = add(3, 4)\n  result\n}\n`),
    );
    expect(eventSummary(r)).toEqual(["call main()", "line 6", "call add(a=3, b=4)", "line 2", "return 7", "bind result=7", "line 7", "return 7"]);
  });

  it("shadowing creates a new binding instead of mutating the old one", async () => {
    const r = expectOk(await traceGleam(`pub fn main() {\n  let x = 5\n  let x = x + 2\n  x\n}\n`));
    expect(r.result).toEqual({ kind: "int", value: "7" });
    expect(eventSummary(r).filter((e) => e.startsWith("bind"))).toEqual(["bind x=5", "bind x=7"]);
    const [, first, second] = r.trace.steps;
    expect(first.frames[1].bindings).toEqual([{ name: "x", value: { kind: "int", value: "5" }, bindingId: "frame-main-1:x#1" }]);
    expect(second.frames[1].bindings).toEqual([{ name: "x", value: { kind: "int", value: "7" }, bindingId: "frame-main-1:x#2" }]);
  });

  it("nested calls are recorded in real evaluation order", async () => {
    const r = expectOk(await traceGleam(`fn sq(x: Int) -> Int {\n  x * x\n}\n\npub fn main() {\n  let r = sq(sq(2)) + 1\n  r\n}\n`));
    expect(eventSummary(r)).toEqual([
      "call main()",
      "line 6",
      "call sq(x=2)",
      "line 2",
      "return 4",
      "call sq(x=4)",
      "line 2",
      "return 16",
      "bind r=17",
      "line 7",
      "return 17",
    ]);
  });

  it("&& short-circuits: the second call is never made (observed, not assumed)", async () => {
    const src = (a: number) =>
      `fn is_pos(n: Int) -> Bool {\n  n > 0\n}\n\npub fn main() {\n  let a = ${a}\n  let ok = is_pos(a) && is_pos(10)\n  ok\n}\n`;
    const neg = expectOk(await traceGleam(src(-3)));
    expect(eventSummary(neg).filter((e) => e.startsWith("call is_pos"))).toEqual(["call is_pos(n=-3)"]);
    expect(neg.result).toEqual({ kind: "bool", value: false });
    const pos = expectOk(await traceGleam(src(3)));
    expect(eventSummary(pos).filter((e) => e.startsWith("call is_pos"))).toEqual(["call is_pos(n=3)", "call is_pos(n=10)"]);
    expect(pos.result).toEqual({ kind: "bool", value: true });
  });

  it("recursion through || gets one logical frame per call", async () => {
    const r = expectOk(
      await traceGleam(`fn reaches_zero(n: Int) -> Bool {\n  n == 0 || reaches_zero(n - 1)\n}\n\npub fn main() {\n  reaches_zero(2)\n}\n`),
    );
    const last = r.trace.steps.at(-1)!;
    expect(last.frames.filter((f) => f.functionName === "reaches_zero").map((f) => f.bindings[0].value)).toEqual([
      { kind: "int", value: "2" },
      { kind: "int", value: "1" },
      { kind: "int", value: "0" },
    ]);
  });

  it("uses Gleam's integer semantics from the real prelude (x / 0 = 0, remainder sign)", async () => {
    const r = expectOk(
      await traceGleam(`pub fn main() {\n  let n = 17\n  let d = n / 0\n  let q = n / 5\n  let m = 0 - n % 5\n  let k = -7 % 3\n  d + q + m + k\n}\n`),
    );
    expect(eventSummary(r).filter((e) => e.startsWith("bind"))).toEqual(["bind n=17", "bind d=0", "bind q=3", "bind m=-2", "bind k=-1"]);
  });

  it("functions defined after main and type annotations on let", async () => {
    const r = expectOk(
      await traceGleam(`pub fn main() {\n  let n: Int = twice(4)\n  n\n}\n\nfn twice(v: Int) -> Int {\n  v + v\n}\n`),
    );
    expect(r.result).toEqual({ kind: "int", value: "8" });
  });

  it("randomly generated programs agree with independently computed values", async () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 6; i++) {
      const [a, b, c] = [rand(50) - 25, rand(50) - 25, rand(9) + 1];
      const ops = ["+", "-", "*"];
      const [o1, o2] = [ops[rand(3)], ops[rand(3)]];
      const src = `fn f(p: Int, q: Int) -> Int {\n  p ${o1} q ${o2} ${c}\n}\n\npub fn main() {\n  let x = ${a}\n  let y = f(x, ${b})\n  y\n}\n`;
      const expected = Function(`return ${a} ${o1} (${b}) ${o2} ${c}`)() as number;
      const r = expectOk(await traceGleam(src));
      expect(eventSummary(r)).toEqual([
        "call main()",
        "line 6",
        `bind x=${a}`,
        "line 7",
        `call f(p=${a}, q=${b})`,
        "line 2",
        `return ${expected}`,
        `bind y=${expected}`,
        "line 8",
        `return ${expected}`,
      ]);
    }
  });
});

describe("failures are explicit", () => {
  it("syntax errors come from the official compiler with a location", async () => {
    const r = await traceGleam(`pub fn main() {\n  let = 5\n}\n`);
    expect(r.status).toBe("compile_error");
    if (r.status === "compile_error") expect(r.diagnostic).toMatchObject({ title: "Syntax error", line: 2, column: 7 });
  });

  it("type errors come from the official compiler", async () => {
    const r = await traceGleam(`pub fn main() {\n  let a = 1 + True\n  a\n}\n`);
    expect(r.status).toBe("compile_error");
    if (r.status === "compile_error") expect(r.diagnostic).toMatchObject({ title: "Type mismatch", line: 2 });
  });

  it("unknown names are compile errors", async () => {
    const r = await traceGleam(`pub fn main() {\n  y\n}\n`);
    expect(r.status).toBe("compile_error");
  });

  it.each([
    ["unqualified imports", `import gleam/io.{println}\n\npub fn main() {\n  println("hi")\n}\n`, "Unqualified imports (import module.{...})", 1],
    ["import aliases", `import gleam/io as out\n\npub fn main() {\n  out.println("hi")\n}\n`, "Aliases (as)", 1],
    ["stdlib calls with List results", `import gleam/string\n\npub fn main() {\n  let parts = string.split("a,b", ",")\n  1\n}\n`, "Calling string.split (its result type, List(String), can't be shown yet)", 4],
    ["stdlib calls with Float results", `import gleam/int\n\npub fn main() {\n  let f = int.to_float(2)\n  1\n}\n`, "Calling int.to_float (its result type, Float, can't be shown yet)", 4],
    ["nondeterministic stdlib calls", `import gleam/int\n\npub fn main() {\n  int.random(10)\n}\n`, "Calling int.random (its result is different on every run)", 4],
    ["case", `pub fn main() {\n  case 1 {\n    _ -> 2\n  }\n}\n`, "case expressions", 2],
    ["lists", `pub fn main() {\n  let xs = [1, 2]\n  xs\n}\n`, "Lists", 2],
    ["floats", `pub fn main() {\n  let f = 1.5\n  f\n}\n`, "Floats", 2],
    ["anonymous fns", `pub fn main() {\n  let f = fn(x) { x }\n  f(1)\n}\n`, "Anonymous functions", 2],
    ["blocks", `pub fn main() {\n  let y = {\n    3\n  }\n  y\n}\n`, "Blocks", 2],
    ["custom types", `pub type T {\n  A\n}\n\npub fn main() {\n  1\n}\n`, "Custom types", 1],
    ["functions as values", `fn id(x: Int) -> Int {\n  x\n}\n\npub fn main() {\n  let f = id\n  f(1)\n}\n`, "Using the function id as a value", 6],
  ])("%s are rejected with a location instead of being traced", async (_, src, feature, line) => {
    const r = await traceGleam(src);
    expect(r.status).toBe("unsupported");
    if (r.status === "unsupported") expect(r).toMatchObject({ feature, line });
  });

  it("a self tail call (compiled to a loop) is refused, not guessed", async () => {
    const r = await traceGleam(`fn down(n: Int) -> Int {\n  down(n - 1)\n}\n\npub fn main() {\n  down(3)\n}\n`);
    expect(r.status).toBe("unsupported");
    if (r.status === "unsupported") expect(r.message).toMatch(/Could not map the compiled code back to the source/);
  });

  it("runaway recursion hits the call-depth limit", async () => {
    const r = await traceGleam(`fn grow(n: Int) -> Int {\n  1 + grow(n + 1)\n}\n\npub fn main() {\n  grow(0)\n}\n`);
    expect(r.status).toBe("limit");
    if (r.status === "limit") expect(r.message).toMatch(/Call depth exceeded 500/);
  });

  it("callers cannot raise limits past the hard ceilings; the host survives deep recursion", async () => {
    // Before the ceilings and shared snapshots existed, this exact call crashed the
    // HOST process with a fatal out-of-memory error (see docs/PHASE_2_ARCHITECTURE.md).
    const r = await traceGleam(`fn grow(n: Int) -> Int {\n  1 + grow(n + 1)\n}\n\npub fn main() {\n  grow(0)\n}\n`, {
      maxDepth: 1e9,
      maxEvents: 1e9,
      timeoutMs: 1e9,
    });
    expect(["limit", "runtime_error"]).toContain(r.status);
    if (r.status === "limit") expect(r.message).toMatch(/Call depth exceeded 2000|longer than 50000 events|too large to visualize/);
  });

  it("long traces hit the event limit", async () => {
    const r = await traceGleam(squareProgram(5), { maxEvents: 4 });
    expect(r.status).toBe("limit");
    if (r.status === "limit") expect(r.message).toMatch(/longer than 4 events/);
  });
});
