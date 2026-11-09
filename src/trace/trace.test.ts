import { DEMO_SOURCE, DEMO_TRACE } from "./demoTrace";
import { hashSource, normalizeSource } from "./source";
import { demoTracer } from "./tracer";
import { validateTrace } from "./validate";

describe("demo trace fixture", () => {
  it("is labelled as a fixture and tied to the demo source", () => {
    expect(DEMO_TRACE.traceKind).toBe("fixture");
    expect(DEMO_TRACE.sourceHash).toBe(hashSource(DEMO_SOURCE));
    expect(validateTrace(DEMO_TRACE, DEMO_SOURCE)).toEqual([]);
  });

  it("never prints anything (main's return value is not output)", () => {
    for (const step of DEMO_TRACE.steps) expect(step.stdout).toBe("");
  });

  it("follows the GT-01 event order", () => {
    expect(DEMO_TRACE.steps.map((s) => s.note)).toEqual([
      "enter main()",
      "bind a = 5",
      "call square(5)",
      "enter square with x = 5",
      "evaluate x * x = 25",
      "square returns 25",
      "bind b = 25",
      "evaluate b = 25",
      "main returns 25",
    ]);
    expect(DEMO_TRACE.steps.map((s) => s.event)).toEqual([
      "call", "bind", "eval", "call", "eval", "return", "bind", "eval", "return",
    ]);
  });

  it("binds names only after their initializer evaluates", () => {
    const main = (i: number) => DEMO_TRACE.steps[i].frames.find((f) => f.id === "frame-main-1")!;
    expect(main(0).bindings).toEqual([]);
    expect(main(1).bindings.map((b) => b.name)).toEqual(["a"]);
    expect(main(5).bindings.map((b) => b.name)).toEqual(["a"]);
    expect(main(6).bindings).toEqual([
      { name: "a", value: { kind: "int", value: "5" } },
      { name: "b", value: { kind: "int", value: "25" } },
    ]);
  });

  it("creates square's frame on entry and marks it exited with 25 on return", () => {
    const sq = (i: number) => DEMO_TRACE.steps[i].frames.find((f) => f.functionName === "square" && f.status !== "module");
    expect(sq(2)).toBeUndefined();
    expect(sq(3)).toMatchObject({ status: "active", bindings: [{ name: "x", value: { kind: "int", value: "5" } }] });
    expect(sq(3)!.returnValue).toBeUndefined();
    expect(sq(5)).toMatchObject({ status: "exited", returnValue: { kind: "int", value: "25" } });
  });

  it("ends with main exited, returning 25, and no next location", () => {
    const last = DEMO_TRACE.steps[DEMO_TRACE.steps.length - 1];
    expect(last.nextToExecute).toBeNull();
    expect(last.frames.find((f) => f.id === "frame-main-1")).toMatchObject({ status: "exited", returnValue: { value: "25" } });
  });

  it("chains arrows: each step's green arrow is the previous step's red arrow", () => {
    const steps = DEMO_TRACE.steps;
    expect(steps[0].justExecuted).toBeNull();
    for (let i = 1; i < steps.length; i++) expect(steps[i].justExecuted).toEqual(steps[i - 1].nextToExecute);
  });
});

describe("source identity", () => {
  it("ignores only line endings and trailing whitespace at end of file", () => {
    expect(hashSource(DEMO_SOURCE.replace(/\n/g, "\r\n"))).toBe(hashSource(DEMO_SOURCE));
    expect(hashSource(DEMO_SOURCE + "\n\n  ")).toBe(hashSource(DEMO_SOURCE));
    expect(hashSource(DEMO_SOURCE.replace("let a = 5", "let a = 6"))).not.toBe(hashSource(DEMO_SOURCE));
    expect(hashSource(DEMO_SOURCE.replace("  x * x", "    x * x"))).not.toBe(hashSource(DEMO_SOURCE));
    expect(normalizeSource("a\r\nb  \n")).toBe("a\nb");
  });
});

describe("demoTracer", () => {
  it("returns the Demo trace for the exact example", async () => {
    const r = await demoTracer.trace(DEMO_SOURCE);
    expect(r.status).toBe("ok");
  });

  it.each([
    ["changed value", DEMO_SOURCE.replace("let a = 5", "let a = 6")],
    ["added comment", DEMO_SOURCE + "// hi\n"],
    ["empty program", ""],
    ["other program", 'import gleam/io\n\npub fn main() {\n  io.println("Hello, Gleam!")\n}\n'],
  ])("refuses to trace edited or different code (%s)", async (_, src) => {
    const r = await demoTracer.trace(src);
    expect(r.status).toBe("unsupported");
  });

  it("validation rejects a trace for a different source", () => {
    expect(validateTrace(DEMO_TRACE, "pub fn main() { 1 }")).toContain("trace does not belong to this source");
  });
});
