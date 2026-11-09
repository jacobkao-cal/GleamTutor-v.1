/**
 * Phase 2D: gleam_stdlib imports, String values, Print Output, stdlib calls as
 * atomic steps, and the library examples that are now traceable.
 * Every value and every line of output here comes from running the program
 * (official compiler + real gleam_stdlib); nothing is predicted.
 * Requires the pinned toolchain: npm run tracer:setup
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GT_EXAMPLES } from "../../examples.js";
import type { ExecutionTrace, TraceStep } from "../../src/trace/types";
import { toTraceResult } from "../../src/tracer/toTraceResult";
import { toolchainAvailable } from "../compiler";
import { expectOk, stepSummary, traceGleam } from "./helpers";

beforeAll(() => {
  if (!toolchainAvailable()) throw new Error("Gleam toolchain missing. Run: npm run tracer:setup");
});

const example = (id: string) => GT_EXAMPLES.find((e) => e.id === id)!.code;
const last = (t: ExecutionTrace) => t.steps[t.steps.length - 1];
const frame = (s: TraceStep, fn: string) => s.frames.find((f) => f.status !== "module" && f.functionName === fn)!;
const bindings = (s: TraceStep, fn: string) => Object.fromEntries(frame(s, fn).bindings.map((b) => [b.name, b.value]));
const str = (value: string) => ({ kind: "string", value });
const int = (n: number) => ({ kind: "int", value: String(n) });

describe("A-F: the Phase 2D programs", () => {
  it("A. a stdlib import: int.to_string(42) is the String \"42\"", async () => {
    const r = expectOk(await traceGleam("import gleam/int\n\npub fn main() {\n  int.to_string(42)\n}\n"));
    expect(r.result).toEqual(str("42"));
    expect(frame(last(r.trace), "main").returnValue).toEqual(str("42"));
  });

  it("B. string concatenation", async () => {
    const r = expectOk(await traceGleam('pub fn main() {\n  let first = "Hello"\n  let second = "Gleam"\n  first <> ", " <> second\n}\n'));
    expect(r.result).toEqual(str("Hello, Gleam"));
    expect(r.trace.steps.map(stepSummary)).toEqual([
      "call@1 main[]",
      "bind@2 main[first=Hello]",
      "bind@3 main[first=Hello second=Gleam]",
      "return@4 main![first=Hello second=Gleam => Hello, Gleam]",
    ]);
  });

  it("C. io.println output appears in Print Output; main returns Nil", async () => {
    const r = expectOk(await traceGleam('import gleam/io\n\npub fn main() {\n  io.println("Hello, Gleam!")\n}\n'));
    expect(r.result).toEqual({ kind: "nil" });
    expect(last(r.trace).stdout).toBe("Hello, Gleam!\n");
    expect(r.trace.steps[0].stdout).toBe(""); // nothing printed before main runs
  });

  it("D. several prints keep their order and newlines, each at its own step", async () => {
    const r = expectOk(await traceGleam('import gleam/io\n\npub fn main() {\n  io.println("First")\n  io.println("Second")\n}\n'));
    expect(r.trace.steps.map((s) => [s.event, s.source.line, s.stdout])).toEqual([
      ["call", 3, ""],
      ["eval", 4, "First\n"],
      ["return", 5, "First\nSecond\n"],
    ]);
  });

  it("E. a stdlib conversion inside a print", async () => {
    const r = expectOk(await traceGleam("import gleam/int\nimport gleam/io\n\npub fn main() {\n  let number = 42\n  io.println(int.to_string(number))\n}\n"));
    expect(last(r.trace).stdout).toBe("42\n");
    expect(bindings(last(r.trace), "main")).toEqual({ number: int(42) });
  });

  it("F. a user-defined function with String arguments and result", async () => {
    const r = expectOk(await traceGleam('pub fn greet(name: String) -> String {\n  "Hello, " <> name\n}\n\npub fn main() {\n  greet("Jacob")\n}\n'));
    expect(r.result).toEqual(str("Hello, Jacob"));
    const greet = frame(last(r.trace), "greet");
    expect(greet.bindings.map((b) => [b.name, b.value])).toEqual([["name", str("Jacob")]]);
    expect(greet.returnValue).toEqual(str("Hello, Jacob"));
  });

  it("the §3 example: main, greet, name, the string expression, return, message", async () => {
    const r = expectOk(
      await traceGleam('pub fn greet(name: String) -> String {\n  "Hello, " <> name\n}\n\npub fn main() {\n  let message = greet("Jacob")\n  message\n}\n'),
    );
    expect(r.trace.steps.map(stepSummary)).toEqual([
      "call@5 main[]",
      "eval@6 main[]",
      "call@1 main[] greet[name=Jacob]",
      "return@2 main[] greet![name=Jacob => Hello, Jacob]",
      "bind@6 main[message=Hello, Jacob] greet![name=Jacob => Hello, Jacob]",
      "return@7 main![message=Hello, Jacob => Hello, Jacob] greet![name=Jacob => Hello, Jacob]",
    ]);
  });

  it("the §5 example: stdlib calls are atomic (no stdlib frames), with real values and output", async () => {
    const r = expectOk(
      await traceGleam("import gleam/int\nimport gleam/io\n\npub fn main() {\n  let number = 42\n  let text = int.to_string(number)\n  io.println(text)\n}\n"),
    );
    expect(r.trace.steps.map((s) => [s.event, s.source.line, s.stdout])).toEqual([
      ["call", 4, ""],
      ["bind", 5, ""],
      ["bind", 6, ""],
      ["return", 7, "42\n"],
    ]);
    expect(bindings(last(r.trace), "main")).toEqual({ number: int(42), text: str("42") });
    expect(last(r.trace).frames.filter((f) => f.status !== "module").map((f) => f.functionName)).toEqual(["main"]);
  });
});

describe("strings are recorded exactly", () => {
  it("escapes, quotes, Unicode and emoji survive unchanged", async () => {
    const r = expectOk(await traceGleam('pub fn main() {\n  let s = "tab\\tquote\\" back\\\\ héllo 🌟 \\u{1F600}"\n  s\n}\n'));
    expect(r.result).toEqual(str('tab\tquote" back\\ héllo 🌟 😀'));
  });

  it("a multi-line string literal keeps its newline, and its step spans its lines", async () => {
    const r = expectOk(await traceGleam('pub fn main() {\n  let s = "one\ntwo"\n  s\n}\n'));
    expect(r.result).toEqual(str("one\ntwo"));
    expect(r.trace.steps[1].source).toMatchObject({ line: 2, endLine: 3 });
  });

  it("io.print writes no newline of its own; println adds one", async () => {
    const r = expectOk(await traceGleam('import gleam/io\n\npub fn main() {\n  io.print("a")\n  io.print("b")\n  io.println("c")\n}\n'));
    expect(last(r.trace).stdout).toBe("abc\n");
  });

  it("string functions from the stdlib give their real results", async () => {
    const r = expectOk(
      await traceGleam('import gleam/string\n\npub fn main() {\n  let up = string.uppercase("gleam")\n  let n = string.length("héllo")\n  string.repeat(up, n - 3)\n}\n'),
    );
    expect(bindings(last(r.trace), "main")).toEqual({ up: str("GLEAM"), n: int(5) });
    expect(r.result).toEqual(str("GLEAMGLEAM"));
  });

  it("a String longer than the per-value limit stops the run with a limit", async () => {
    const r = await traceGleam('import gleam/string\n\npub fn main() {\n  string.repeat("a", 20000)\n}\n');
    expect(r).toMatchObject({ status: "limit", message: "A String value is longer than 10000 characters" });
  });

  it("printed output is limited", async () => {
    const r = await traceGleam('import gleam/io\n\npub fn main() {\n  io.println("0123456789")\n  io.println("0123456789")\n}\n', { maxStdout: 15 });
    expect(r).toMatchObject({ status: "limit", message: "Printed output is longer than 15 characters" });
  });
});

describe("G: unsupported programs get a clear message and no trace", () => {
  it.each([
    ["a list", 'import gleam/io\n\npub fn main() {\n  let xs = [1, 2]\n  io.println("x")\n}\n', "Lists"],
    ["case", 'pub fn main() {\n  case 1 {\n    _ -> "one"\n  }\n}\n', "case expressions"],
    ["a stdlib call returning a List", 'import gleam/string\n\npub fn main() {\n  string.split("a,b", ",")\n}\n', "Calling string.split (its result type, List(String), can't be shown yet)"],
    ["an unqualified import (the option example's form)", example("option"), "Unqualified imports (import module.{...})"],
    ["a function capture (the hof example)", example("hof"), "Anonymous functions"],
  ])("%s", async (_name, src, feature) => {
    const r = await traceGleam(src);
    expect(r.status).toBe("unsupported");
    if (r.status === "unsupported") expect(r.feature).toBe(feature);
    expect("trace" in r).toBe(false);
  });

  it("an unknown module is a compiler error, with a hint about what can be imported", async () => {
    const r = toTraceResult(await traceGleam("import lustre\n\npub fn main() {\n  1\n}\n"));
    expect(r).toMatchObject({ status: "compile_error", location: { line: 1 } });
    expect(r.status === "compile_error" && r.message).toBe(
      "The Gleam compiler found a problem: Unknown module. Only the Gleam standard library (gleam_stdlib 1.0.5) can be imported",
    );
  });
});

describe("H: playback correctness", () => {
  const PROGRAM = 'import gleam/io\n\nfn shout(s: String) -> String {\n  io.println(s)\n  s <> "!"\n}\n\npub fn main() {\n  io.println("start")\n  let a = shout("hi")\n  io.println(a)\n}\n';

  it("each step shows exactly the output printed so far: a growing prefix, never duplicated", async () => {
    const r = expectOk(await traceGleam(PROGRAM));
    const outs = r.trace.steps.map((s) => s.stdout);
    for (let i = 1; i < outs.length; i++) expect(outs[i].startsWith(outs[i - 1])).toBe(true);
    expect(outs[outs.length - 1]).toBe("start\nhi\nhi!\n");
    expect(r.trace.steps.map((s) => [s.event, s.source.line, s.stdout])).toEqual([
      ["call", 8, ""],
      ["eval", 9, "start\n"],
      ["eval", 10, "start\n"],
      ["call", 3, "start\n"],
      ["eval", 4, "start\nhi\n"],
      ["return", 5, "start\nhi\n"],
      ["bind", 10, "start\nhi\n"],
      ["return", 11, "start\nhi\nhi!\n"],
    ]);
  });

  it("moving backward and forward is a pure lookup: earlier snapshots are never changed", async () => {
    const r = expectOk(await traceGleam(PROGRAM));
    const before = JSON.stringify(r.trace.steps.slice(0, 4));
    // Walk the timeline forward, back and forward again, reading every pane.
    const read = (i: number) => JSON.stringify([r.trace.steps[i].stdout, r.trace.steps[i].frames, r.trace.steps[i].justExecuted]);
    const forward = r.trace.steps.map((_, i) => read(i));
    const backward = r.trace.steps.map((_, i) => read(r.trace.steps.length - 1 - i)).reverse();
    expect(backward).toEqual(forward);
    expect(JSON.stringify(r.trace.steps.slice(0, 4))).toBe(before);
    expect(frame(r.trace.steps[4], "shout").status).toBe("active");
    expect(frame(last(r.trace), "shout").status).toBe("exited");
  });

  it("source arrows follow the recorded events (green = this event, red = the next one)", async () => {
    const r = expectOk(await traceGleam(PROGRAM));
    r.trace.steps.forEach((s, i) => {
      expect(s.justExecuted).toEqual(i === 0 ? null : s.source);
      expect(s.nextToExecute).toEqual(r.trace.steps[i + 1]?.source ?? null);
    });
  });
});

describe("library examples now traceable (verified by running them)", () => {
  it("Hello world", async () => {
    const r = expectOk(await traceGleam(example("hello")));
    expect(r.trace.steps.map((s) => [s.event, s.source.line, s.stdout])).toEqual([
      ["call", 3, ""],
      ["eval", 4, "Hello, Joe!\n"],
      ["return", 5, "Hello, Joe!\nHello, Mike!\n"],
    ]);
  });

  it("Assignments and shadowing: y keeps the original value after x is re-bound", async () => {
    const r = expectOk(await traceGleam(example("assignments")));
    expect(last(r.trace).stdout).toBe("Original\nOriginal\nNew\nOriginal\n");
    const main = frame(last(r.trace), "main");
    expect(main.bindings.map((b) => [b.name, b.value, b.bindingId])).toEqual([
      ["y", str("Original"), "frame-main-1:y#1"],
      ["x", str("New"), "frame-main-1:x#2"],
    ]);
  });

  it("Functions: nested user calls get frames; int.to_string does not", async () => {
    const r = expectOk(await traceGleam(example("functions")));
    expect(last(r.trace).stdout).toBe("10\n");
    expect(last(r.trace).frames.filter((f) => f.status !== "module").map((f) => `${f.functionName}=${f.returnValue && "value" in f.returnValue ? f.returnValue.value : "?"}`)).toEqual([
      "main=?",
      "add=5",
      "double=10",
      "multiply=10",
    ]);
    expect(bindings(last(r.trace), "main")).toEqual({ total: int(5), doubled: int(10) });
  });
});
