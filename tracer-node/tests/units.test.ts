/** Unit tests for the POC pieces that do not need the compiler. */
import { describe, expect, it } from "vitest";
import { parseDiagnostic } from "../../src/tracer/runtime";
import { clampLimits, DEFAULT_LIMITS, MAX_LIMITS, type RawEvent } from "../../src/tracer/events";
import { AlignmentError, gleamNameOf, instrument } from "../../src/tracer/instrument";
import { mergeEvents, normalize, NormalizeLimitError } from "../../src/tracer/normalize";
import { runInWorker } from "../runner";
import { parseSubset, UnsupportedError } from "../../src/tracer/subset";

const SQUARE = `pub fn square(x: Int) -> Int {
  x * x
}

pub fn main() {
  let a = 5
  let b = square(a)
  b
}
`;

describe("subset recogniser", () => {
  it("records exact source anchors", () => {
    const m = parseSubset(SQUARE);
    const [square, main] = m.functions;
    expect(square).toMatchObject({ name: "square", isPublic: true, params: ["x"], signature: "fn square(x: Int) -> Int" });
    expect(square.header).toEqual({ line: 1, column: 1, endLine: 1, endColumn: 31 });
    expect(square.tail.loc).toEqual({ line: 2, column: 3, endLine: 2, endColumn: 8 });
    expect(main.lets.map((l) => [l.name, l.loc, l.hasCall])).toEqual([
      ["a", { line: 6, column: 3, endLine: 6, endColumn: 12 }, false],
      ["b", { line: 7, column: 3, endLine: 7, endColumn: 20 }, true],
    ]);
    expect(main.tail.loc).toEqual({ line: 8, column: 3, endLine: 8, endColumn: 4 });
  });

  it("handles multi-line expressions and comments", () => {
    const m = parseSubset(`// comment\npub fn main() {\n  let a =\n    1 +\n    2\n  /// doc\n  a\n}\n`);
    expect(m.functions[0].lets[0].loc).toEqual({ line: 3, column: 3, endLine: 5, endColumn: 6 });
  });

  it.each([
    [`pub fn main() {\n  1\n  2\n}\n`, "Expression statements (a value computed and then discarded)"],
    [`pub fn main() {\n  let _x = 1\n  2\n}\n`, "Discard names (starting with _)"],
    [`fn f(label x: Int) -> Int {\n  x\n}\npub fn main() {\n  1\n}\n`, "Labelled parameters"],
    [`fn f(x: Int) -> Int {\n  x\n}\npub fn main() {\n  f(x: 1)\n}\n`, "Labelled arguments"],
    [`fn f(x: List(Int)) -> Int {\n  1\n}\npub fn main() {\n  1\n}\n`, "The type List"],
    [`fn helper() -> Int {\n  1\n}\n`, "Programs without `pub fn main()`"],
  ])("rejects %j", (src, feature) => {
    expect(() => parseSubset(src)).toThrow(UnsupportedError);
    try {
      parseSubset(src);
    } catch (e) {
      expect((e as UnsupportedError).feature).toBe(feature);
    }
  });
});

describe("instrumentation alignment", () => {
  it("maps compiler-escaped names back to Gleam names", () => {
    expect(gleamNameOf("x$1")).toBe("x");
    expect(gleamNameOf("class$")).toBe("class");
    expect(gleamNameOf("this$2")).toBe("this");
    expect(gleamNameOf("total")).toBe("total");
  });

  const module = parseSubset(SQUARE);
  const good = `export function square(x) {\n  return x * x;\n}\n\nexport function main() {\n  let a = 5;\n  let b = square(a);\n  return b;\n}\n`;

  it("instruments matching compiled code without changing its expressions", () => {
    const out = instrument(good, module);
    expect(out).toContain("let a = 5;");
    expect(out).toContain("let b = square(a);");
    expect(out).toContain('$__gt.call("square", [1, 1, 1, 31], [["x", x]])');
  });

  it.each([
    ["an extra statement", good.replace("let a = 5;", "let a = 5; let t = 1;")],
    ["a renamed binding", good.replace(/\ba\b/g, "z")],
    ["a loop", good.replace("return x * x;", "while (true) { return x * x; }")],
    ["a missing function", good.replace(/export function square[\s\S]*?\n}\n/, "")],
    ["an unexpected import", `import * as $io from "./gleam/io.mjs";\n` + good],
  ])("refuses compiled code with %s", (_, js) => {
    expect(() => instrument(js, module)).toThrow(AlignmentError);
  });
});

describe("event merging", () => {
  const loc: [number, number, number, number] = [6, 3, 6, 12];
  it("merges a line event into its own bind when nothing happened in between", () => {
    const ev: RawEvent[] = [
      { t: "line", frame: 1, loc },
      { t: "bind", frame: 1, name: "a", value: { kind: "int", value: "5" }, loc },
    ];
    expect(mergeEvents(ev)).toEqual([ev[1]]);
  });
  it("keeps the line event when a call happened inside the statement", () => {
    const ev: RawEvent[] = [
      { t: "line", frame: 1, loc },
      { t: "call", frame: 2, fn: "f", loc: [1, 1, 1, 10], args: [] },
    ];
    expect(mergeEvents(ev)).toEqual(ev);
  });
});

describe("limits", () => {
  it("clamps every limit to its hard ceiling", () => {
    expect(clampLimits({})).toEqual(DEFAULT_LIMITS);
    expect(clampLimits({ maxEvents: 1e12, maxDepth: Infinity, timeoutMs: -1, maxHeapMb: NaN })).toMatchObject({
      maxEvents: MAX_LIMITS.maxEvents,
      maxDepth: MAX_LIMITS.maxDepth,
      timeoutMs: MAX_LIMITS.timeoutMs,
      maxHeapMb: MAX_LIMITS.maxHeapMb,
    });
    expect(clampLimits({ maxEvents: 10 }).maxEvents).toBe(10);
  });

  it("refuses to build snapshots beyond the size cap", () => {
    const module = parseSubset(SQUARE);
    const loc: [number, number, number, number] = [1, 1, 1, 31];
    const deep: RawEvent[] = Array.from({ length: 300 }, (_, i) => ({ t: "call", frame: i + 1, fn: "square", loc, args: [] }));
    expect(() => normalize(SQUARE, module, deep, null, 1000)).toThrow(NormalizeLimitError);
    expect(normalize(SQUARE, module, deep.slice(0, 10), null, 1000).steps).toHaveLength(10);
  });

  it("shares unchanged frame objects between steps instead of copying them", () => {
    const module = parseSubset(SQUARE);
    const trace = normalize(SQUARE, module, [
      { t: "call", frame: 1, fn: "main", loc: [5, 1, 5, 16], args: [] },
      { t: "call", frame: 2, fn: "square", loc: [1, 1, 1, 31], args: [["x", { kind: "int", value: "5" }]] },
      { t: "return", frame: 2, value: { kind: "int", value: "25" }, loc: [2, 3, 2, 8] },
    ]);
    expect(trace.steps[1].frames[1]).toBe(trace.steps[2].frames[1]); // main unchanged: same object
    expect(trace.steps[1].frames[2]).not.toBe(trace.steps[2].frames[2]); // square changed: new object
    expect(trace.steps[1].frames[2].status).toBe("active"); // earlier snapshot intact
  });
});

describe("diagnostics", () => {
  it("extracts title and location from compiler output", () => {
    const text = "error: Type mismatch\n  ┌─ /src/main.gleam:3:9\n  │\n3 │   1 + True";
    expect(parseDiagnostic(text)).toMatchObject({ title: "Type mismatch", line: 3, column: 9 });
  });
});

describe("isolated runner", () => {
  it("terminates a program that never finishes", async () => {
    const spin = "export function main() { while (true) {} }\n";
    const started = Date.now();
    const r = await runInWorker({ instrumented: spin, original: "export function main() { return 0; }\n" }, { timeoutMs: 500 });
    expect(r.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("stops a program that exhausts its memory budget", async () => {
    const hog = "export function main() { const a = []; while (true) a.push(new Array(1e5).fill(1)); }\n";
    const r = await runInWorker({ instrumented: hog, original: "export function main() { return 0; }\n" }, { timeoutMs: 10_000, maxHeapMb: 32 });
    expect(["limit", "internal_error"]).toContain(r.status);
  });

  it("does not expose environment variables to the program", async () => {
    const peek = "export function main() { return Object.keys(process.env).length; }\n";
    const r = await runInWorker({ instrumented: peek, original: peek });
    expect(r).toMatchObject({ status: "ok", result: { kind: "int", value: "0" } });
  });
});
