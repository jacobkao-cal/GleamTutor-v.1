/**
 * Phase 3C: imports and output.
 *  - How stdlib imports resolve, and which modules are available.
 *  - gleam/io output; gleam/list, gleam/int and gleam/string calls verified
 *    against known Gleam results, as atomic steps (no stdlib frames).
 *  - Unqualified imports and aliases; clear refusals for everything else.
 * Every value comes from running the real gleam_stdlib.
 * Requires the pinned toolchain: npm run tracer:setup
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ExecutionTrace, TraceObject, TraceStep, TraceValue } from "../../src/trace/types";
import { checkStdlibCall, isDisplayableType } from "../../src/tracer/stdlib";
import { toTraceResult } from "../../src/tracer/toTraceResult";
import { compileGleam, loadStdlibInfo, toolchainAvailable } from "../compiler";
import { expectOk, traceGleam } from "./helpers";

beforeAll(() => {
  if (!toolchainAvailable()) throw new Error("Gleam toolchain missing. Run: npm run tracer:setup");
});

const last = (t: ExecutionTrace) => t.steps[t.steps.length - 1];

/** A value as Gleam's string.inspect would print it, following list cells. */
function show(v: TraceValue | undefined, s: TraceStep): string {
  if (!v) return "?";
  const objects = new Map<string, TraceObject>(s.objects.map((o) => [o.id, o]));
  switch (v.kind) {
    case "empty-list":
      return "[]";
    case "ref": {
      const items: string[] = [];
      let c: TraceValue = v;
      while (c.kind === "ref") {
        const o = objects.get(c.id);
        if (!o || o.kind !== "cons") return `<missing ${c.id}>`;
        items.push(show(o.head, s));
        c = o.tail;
      }
      return `[${items.join(", ")}]`;
    }
    case "string":
      return JSON.stringify(v.value);
    case "bool":
      return v.value ? "True" : "False";
    case "nil":
      return "Nil";
    default:
      return String((v as { value: unknown }).value);
  }
}
const mainVars = (t: ExecutionTrace) => {
  const s = last(t);
  return Object.fromEntries(s.frames.find((f) => f.functionName === "main" && f.status !== "module")!.bindings.map((b) => [b.name, show(b.value, s)]));
};

describe("how stdlib imports resolve", () => {
  it("every gleam_stdlib 1.0.5 module can be imported (the compiler gets the real stdlib sources)", async () => {
    const info = loadStdlibInfo();
    const modules = Object.keys(info.modules);
    expect(modules).toHaveLength(19);
    for (const m of modules) {
      const r = await compileGleam(`import ${m}\n\npub fn main() {\n  1\n}\n`);
      expect(r.ok, m).toBe(true);
    }
  });

  it("a module outside gleam_stdlib is the compiler's 'Unknown module' error, with a hint", async () => {
    for (const src of ["import lustre/element\n\npub fn main() {\n  1\n}\n", "import gleam/http\n\npub fn main() {\n  1\n}\n"]) {
      const r = toTraceResult(await traceGleam(src));
      expect(r).toMatchObject({ status: "compile_error", location: { line: 1 } });
      expect(r.status === "compile_error" && r.message).toContain("Only the Gleam standard library (gleam_stdlib 1.0.5) can be imported");
    }
  });

  it("which result types can be shown (the rule behind which stdlib calls are traceable)", () => {
    for (const t of ["Int", "String", "Nil", "List(a)", "List(List(String))", "acc", "Bool"]) expect(isDisplayableType(t), t).toBe(true);
    for (const t of ["Float", "Result(Int, Nil)", "Option(a)", "Dict(k, v)", "List(Float)", "#(a, b)", "fn(a) -> b", "", "Order"]) expect(isDisplayableType(t), t).toBe(false);
    const info = loadStdlibInfo();
    expect(checkStdlibCall(info, "gleam/list", "list.shuffle", "shuffle")).toEqual({ ok: false, feature: "Calling list.shuffle (its result is different on every run)" });
    expect(checkStdlibCall(info, "gleam/list", "list.reverse", "reverse")).toEqual({ ok: true });
  });
});

describe("gleam/io", () => {
  it("the Phase 3C example prints Hello, Gleam!", async () => {
    const r = expectOk(await traceGleam('import gleam/io\n\npub fn main() {\n  io.println("Hello, Gleam!")\n}\n'));
    expect(last(r.trace).stdout).toBe("Hello, Gleam!\n");
  });
});

describe("gleam/list, verified against known Gleam results", () => {
  it("results are real list values, drawn as cells", async () => {
    const r = expectOk(
      await traceGleam(`import gleam/list

pub fn main() {
  let xs = [1, 2, 3]
  let reversed = list.reverse(xs)
  let appended = list.append([1, 2], [3])
  let size = list.length(xs)
  let has_two = list.contains(xs, 2)
  let first_two = list.take(xs, 2)
  let rest = list.drop(xs, 1)
  let flat = list.flatten([[1], [2, 3]])
  let three = list.repeat("a", 3)
  let spaced = list.intersperse(xs, 0)
  let uniq = list.unique([1, 1, 2])
  let pairs = list.window(xs, 2)
  size
}
`),
    );
    expect(mainVars(r.trace)).toEqual({
      xs: "[1, 2, 3]",
      reversed: "[3, 2, 1]",
      appended: "[1, 2, 3]",
      size: "3",
      has_two: "True",
      first_two: "[1, 2]",
      rest: "[2, 3]",
      flat: "[1, 2, 3]",
      three: '["a", "a", "a"]',
      spaced: "[1, 0, 2, 0, 3]",
      uniq: "[1, 2]",
      pairs: "[[1, 2], [2, 3]]",
    });
  });

  it("list.drop returns the rest of the SAME list: the trace shows the shared cells, as the real stdlib built them", async () => {
    const r = expectOk(await traceGleam("import gleam/list\n\npub fn main() {\n  let xs = [1, 2, 3]\n  let rest = list.drop(xs, 1)\n  rest\n}\n"));
    const s = last(r.trace);
    const b = (n: string) => s.frames.find((f) => f.functionName === "main" && f.status !== "module")!.bindings.find((x) => x.name === n)!.value;
    const xsCell = s.objects.find((o) => b("xs").kind === "ref" && o.id === (b("xs") as { id: string }).id) as Extract<TraceObject, { kind: "cons" }>;
    expect(xsCell.tail).toEqual(b("rest"));
    expect(s.objects.filter((o) => o.kind === "cons")).toHaveLength(3);
  });

  it("stdlib calls are atomic: one step each, no stdlib frames; user frames still appear", async () => {
    const r = expectOk(
      await traceGleam(`import gleam/list

fn double_all(xs: List(Int)) -> List(Int) {
  case xs {
    [] -> []
    [x, ..rest] -> [x * 2, ..double_all(rest)]
  }
}

pub fn main() {
  let xs = list.reverse([1, 2])
  double_all(xs)
}
`),
    );
    const names = [...new Set(r.trace.steps.flatMap((s) => s.frames.filter((f) => f.status !== "module").map((f) => f.functionName)))];
    expect(names).toEqual(["main", "double_all"]);
    expect(show(last(r.trace).frames[1].returnValue, last(r.trace))).toBe("[4, 2]");
    const bindXs = r.trace.steps.filter((s) => s.note === "bind xs");
    expect(bindXs).toHaveLength(1); // list.reverse is one step
  });
});

describe("gleam/int and gleam/string", () => {
  it("gleam/int", async () => {
    const r = expectOk(
      await traceGleam(`import gleam/int

pub fn main() {
  let text = int.to_string(42)
  let biggest = int.max(3, 7)
  let distance = int.absolute_value(-4)
  let total = int.sum([1, 2, 3])
  let product = int.product([2, 3, 4])
  let even = int.is_even(4)
  biggest
}
`),
    );
    expect(mainVars(r.trace)).toEqual({ text: '"42"', biggest: "7", distance: "4", total: "6", product: "24", even: "True" });
  });

  it("gleam/string, including results that are lists", async () => {
    const r = expectOk(
      await traceGleam(`import gleam/string

pub fn main() {
  let parts = string.split("a,b,c", ",")
  let joined = string.join(parts, "-")
  let loud = string.uppercase("gleam")
  let size = string.length("héllo")
  let back = string.reverse("abc")
  let letters = string.to_graphemes("hé")
  let swapped = string.replace("a-b", "-", "+")
  joined
}
`),
    );
    expect(mainVars(r.trace)).toEqual({
      parts: '["a", "b", "c"]',
      joined: '"a-b-c"',
      loud: '"GLEAM"',
      size: "5",
      back: '"cba"',
      letters: '["h", "é"]',
      swapped: '"a+b"',
    });
  });

  it("output from stdlib-built strings appears step by step", async () => {
    const r = expectOk(
      await traceGleam(`import gleam/int
import gleam/io
import gleam/list
import gleam/string

pub fn main() {
  let xs = list.reverse([1, 2, 3])
  io.println(int.to_string(list.length(xs)))
  io.println(string.join(["a", "b"], ", "))
}
`),
    );
    expect(r.trace.steps.map((s) => s.stdout).filter((o, i, all) => i === 0 || o !== all[i - 1])).toEqual(["", "3\n", "3\na, b\n"]);
  });
});

describe("unqualified imports and aliases", () => {
  it("functions imported unqualified are called by name", async () => {
    const r = expectOk(await traceGleam('import gleam/io.{println}\n\npub fn main() {\n  println("hi")\n}\n'));
    expect(last(r.trace).stdout).toBe("hi\n");
  });

  it("aliases: `import gleam/io as out` and `{println as say}`", async () => {
    const a = expectOk(await traceGleam('import gleam/io as out\n\npub fn main() {\n  out.println("one")\n}\n'));
    expect(last(a.trace).stdout).toBe("one\n");
    const b = expectOk(await traceGleam('import gleam/io.{println as say}\nimport gleam/string\n\npub fn main() {\n  say(string.uppercase("two"))\n}\n'));
    expect(last(b.trace).stdout).toBe("TWO\n");
  });

  it("type imports are fine; using an imported constructor is refused with a reason", async () => {
    const ok = expectOk(await traceGleam("import gleam/option.{type Option}\n\npub fn main() {\n  1\n}\n"));
    expect(ok.result).toMatchObject({ value: "1" });
    const r = await traceGleam("import gleam/option.{Some}\n\npub fn main() {\n  let x = Some(1)\n  1\n}\n");
    expect(r).toMatchObject({ status: "unsupported", feature: "Custom type constructors", line: 4 });
  });

  it("an unqualified function used as a value is refused", async () => {
    const r = await traceGleam("import gleam/int.{to_string}\nimport gleam/list\n\npub fn main() {\n  list.map([1], to_string)\n}\n");
    expect(r).toMatchObject({ status: "unsupported", feature: "Using to_string as a value", line: 5 });
  });
});

describe("unsupported stdlib calls are reported clearly", () => {
  it.each([
    ["a higher-order call (a user function as an argument)", "import gleam/list\n\nfn double(x: Int) -> Int {\n  x * 2\n}\n\npub fn main() {\n  list.map([1], double)\n}\n", "Using the function double as a value"],
    ["a Result-returning function", "import gleam/list\n\npub fn main() {\n  list.first([1])\n}\n", "Calling list.first (its result type, Result(a, Nil), can't be shown yet)"],
    ["a Float-returning function", "import gleam/int\n\npub fn main() {\n  let f = int.to_float(2)\n  1\n}\n", "Calling int.to_float (its result type, Float, can't be shown yet)"],
    ["a random function", "import gleam/list\n\npub fn main() {\n  list.sample([1, 2], 1)\n}\n", "Calling list.sample (its result is different on every run)"],
    ["a name the module does not export", "import gleam/list\n\npub fn main() {\n  list.nope([1])\n}\n", null],
  ])("%s", async (_name, src, feature) => {
    const r = await traceGleam(src);
    if (feature === null) {
      expect(r.status).toBe("compile_error"); // the compiler reports unknown names first
      return;
    }
    expect(r).toMatchObject({ status: "unsupported", feature });
  });
});
