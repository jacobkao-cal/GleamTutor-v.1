/**
 * Phase 3A: lists and pattern matching, traced from real runs.
 * Every value comes from executing the program compiled by the official
 * compiler; list contents are read back from the recorded cells.
 * Requires the pinned toolchain: npm run tracer:setup
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ExecutionTrace, TraceObject, TraceStep, TraceValue } from "../../src/trace/types";
import { toTraceResult } from "../../src/tracer/toTraceResult";
import { toolchainAvailable } from "../compiler";
import { expectOk, traceGleam } from "./helpers";

beforeAll(() => {
  if (!toolchainAvailable()) throw new Error("Gleam toolchain missing. Run: npm run tracer:setup");
});

const last = (t: ExecutionTrace) => t.steps[t.steps.length - 1];
const userFrames = (s: TraceStep) => s.frames.filter((f) => f.status !== "module");
const frameOf = (s: TraceStep, fn: string, nth = 0) => userFrames(s).filter((f) => f.functionName === fn)[nth];

/** A value as Gleam would print it, following list cells through the step's objects. */
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
    case "nil":
      return "Nil";
    case "bool":
      return v.value ? "True" : "False";
    default:
      return String((v as { value: unknown }).value);
  }
}
const vars = (s: TraceStep, fn: string, nth = 0) => Object.fromEntries(frameOf(s, fn, nth).bindings.map((b) => [b.name, show(b.value, s)]));

const FIRST = `pub fn first(xs: List(Int)) -> Int {
  case xs {
    [] -> 0
    [head, ..tail] -> head
  }
}

pub fn main() {
  first([3, 4, 5])
}
`;

describe("the Phase 3A example: first([3, 4, 5])", () => {
  it("returns 3, selecting the non-empty clause with head = 3 and tail = [4, 5]", async () => {
    const r = expectOk(await traceGleam(FIRST));
    expect(r.result).toMatchObject({ kind: "int", value: "3" });
    const steps = r.trace.steps;
    expect(steps.map((s) => [s.event, s.source.line])).toEqual([
      ["call", 8],
      ["eval", 9],
      ["call", 1],
      ["eval", 2], // about to evaluate the case expression
      ["match", 4], // the [head, ..tail] clause was selected (not line 3)
      ["return", 2],
      ["return", 9],
    ]);
    expect(vars(steps[2], "first")).toEqual({ xs: "[3, 4, 5]" });
    expect(vars(steps[4], "first")).toEqual({ xs: "[3, 4, 5]", head: "3", tail: "[4, 5]" });
    expect(show(frameOf(last(r.trace), "first").returnValue, last(r.trace))).toBe("3");
  });

  it("represents the list as immutable linked cells; tail is the rest of the SAME cells, not a copy", async () => {
    const s = expectOk(await traceGleam(FIRST)).trace.steps[4];
    const xs = frameOf(s, "first").bindings.find((b) => b.name === "xs")!.value;
    const tail = frameOf(s, "first").bindings.find((b) => b.name === "tail")!.value;
    const cells = s.objects.filter((o): o is Extract<TraceObject, { kind: "cons" }> => o.kind === "cons");
    expect(cells).toHaveLength(3); // [3, 4, 5] is three cells; tail adds none
    const first = cells.find((c) => xs.kind === "ref" && c.id === xs.id)!;
    expect(first.tail).toEqual(tail); // tail points at the second cell of xs
    expect(cells.map((c) => c.tail.kind)).toEqual(expect.arrayContaining(["ref", "ref", "empty-list"]));
  });

  it("an empty list selects the [] clause and binds nothing", async () => {
    const r = expectOk(await traceGleam(FIRST.replace("first([3, 4, 5])", "first([])")));
    const match = r.trace.steps.find((s) => s.event === "match")!;
    expect(match.source.line).toBe(3);
    expect(vars(match, "first")).toEqual({ xs: "[]" });
    expect(r.result).toMatchObject({ kind: "int", value: "0" });
  });
});

describe("golden tests from PROJECT_SPEC", () => {
  it("GT-04: describe([3, 4, 5]) selects [first, ..rest] with first = 3", async () => {
    const r = expectOk(
      await traceGleam(`pub fn describe(xs: List(Int)) -> Int {
  case xs {
    [] -> 0
    [first, ..rest] -> first
  }
}

pub fn main() {
  describe([3, 4, 5])
}
`),
    );
    const match = r.trace.steps.find((s) => s.event === "match")!;
    expect(vars(match, "describe")).toEqual({ xs: "[3, 4, 5]", first: "3", rest: "[4, 5]" });
    expect(r.result).toMatchObject({ value: "3" });
  });

  it("GT-05: sum([1, 2, 3]) makes four logical frames returning 0, 3, 5, 6", async () => {
    const r = expectOk(
      await traceGleam(`pub fn sum(xs: List(Int)) -> Int {
  case xs {
    [] -> 0
    [first, ..rest] -> first + sum(rest)
  }
}

pub fn main() {
  sum([1, 2, 3])
}
`),
    );
    const end = last(r.trace);
    expect(userFrames(end).filter((f) => f.functionName === "sum").map((f) => [show(f.bindings[0].value, end), show(f.returnValue, end)])).toEqual([
      ["[1, 2, 3]", "6"],
      ["[2, 3]", "5"],
      ["[3]", "3"],
      ["[]", "0"],
    ]);
    // Returns happen innermost first: at each return step, the frame that just exited and its value.
    const returned = r.trace.steps.flatMap((s, i) => {
      if (s.event !== "return" || i === 0) return [];
      const before = new Set(r.trace.steps[i - 1].frames.filter((f) => f.status === "exited").map((f) => f.id));
      return userFrames(s).filter((f) => f.status === "exited" && !before.has(f.id)).map((f) => `${f.functionName}=${show(f.returnValue, s)}`);
    });
    expect(returned).toEqual(["sum=0", "sum=3", "sum=5", "sum=6", "main=6"]);
    expect(r.result).toMatchObject({ value: "6" });
  });

  it("GT-07 (without the tuple): [0, ..old] shares old's cells; old is unchanged", async () => {
    const r = expectOk(
      await traceGleam(`pub fn main() {
  let old = [1, 2, 3]
  let new = [0, ..old]
  new
}
`),
    );
    const end = last(r.trace);
    expect(vars(end, "main")).toEqual({ old: "[1, 2, 3]", new: "[0, 1, 2, 3]" });
    const b = (n: string) => frameOf(end, "main").bindings.find((x) => x.name === n)!.value;
    const newCell = end.objects.find((o) => b("new").kind === "ref" && o.id === (b("new") as { id: string }).id) as Extract<TraceObject, { kind: "cons" }>;
    expect(newCell.tail).toEqual(b("old")); // the very same first cell of old
    expect(end.objects.filter((o) => o.kind === "cons")).toHaveLength(4); // 3 shared + 1 new, not 7
    // The step that bound `old` still shows [1, 2, 3], with the same cell objects.
    const before = r.trace.steps.find((s) => s.event === "bind" && s.note === "bind old")!;
    expect(vars(before, "main")).toEqual({ old: "[1, 2, 3]" });
  });
});

describe("case expressions", () => {
  it("clauses are chosen by the real run, whatever order the compiler's decision tree tests them in", async () => {
    const src = `pub fn d(xs: List(Int)) -> Int {
  case xs {
    [a, b, ..] -> a + b
    [a] -> a
    _ -> 0
  }
}

pub fn main() {
  let one = d([7])
  let two = d([1, 2, 9])
  let none = d([])
  one + two + none
}
`;
    const r = expectOk(await traceGleam(src));
    const matches = r.trace.steps.filter((s) => s.event === "match").map((s) => s.source.line);
    expect(matches).toEqual([4, 3, 5]);
    const end = last(r.trace);
    expect(vars(end, "main")).toEqual({ one: "7", two: "3", none: "0" });
    expect(r.result).toMatchObject({ value: "10" });
  });

  it("guards, literal patterns and several subjects", async () => {
    const src = `pub fn sign(n: Int) -> String {
  case n {
    0 -> "zero"
    x if x < 0 -> "negative"
    _ -> "positive"
  }
}

pub fn both(a: Bool, b: String) -> Int {
  case a, b {
    True, "x" -> 1
    False, _ -> 2
    _, other -> 3
  }
}

pub fn main() {
  let s = sign(-4)
  let z = sign(0)
  let k = both(True, "y")
  k
}
`;
    const r = expectOk(await traceGleam(src));
    const matches = r.trace.steps.filter((s) => s.event === "match");
    expect(matches.map((s) => s.source.line)).toEqual([4, 3, 13]);
    expect(vars(matches[0], "sign")).toEqual({ n: "-4", x: "-4" });
    expect(vars(matches[2], "both")).toEqual({ a: "True", b: '"y"', other: '"y"' });
    expect(vars(last(r.trace), "main")).toEqual({ s: '"negative"', z: '"zero"', k: "3" });
  });

  it("pattern variables and block bindings go out of scope when the case ends", async () => {
    const src = `pub fn f(n: Int) -> Int {
  let x = case n {
    0 -> 10
    k -> {
      let y = k * 2
      y + 1
    }
  }
  x
}

pub fn main() {
  f(3)
}
`;
    const r = expectOk(await traceGleam(src));
    const steps = r.trace.steps;
    const inClause = steps.find((s) => s.event === "bind" && s.note === "bind y")!;
    expect(vars(inClause, "f")).toEqual({ n: "3", k: "3", y: "6" });
    const bindX = steps.find((s) => s.event === "bind" && s.note === "bind x")!;
    expect(vars(bindX, "f")).toEqual({ n: "3", x: "7" }); // k and y are gone
    expect(vars(inClause, "f")).toEqual({ n: "3", k: "3", y: "6" }); // and the earlier snapshot is unchanged
    expect(r.result).toMatchObject({ value: "7" });
  });

  it("a case on the right of a let, with a nested list pattern and shadowing", async () => {
    const src = `pub fn main() {
  let xs = [[1, 2], [3]]
  let x = case xs {
    [[a, ..], ..] -> a
    _ -> 0
  }
  let x = x + 1
  x
}
`;
    const r = expectOk(await traceGleam(src));
    const match = r.trace.steps.find((s) => s.event === "match")!;
    expect(vars(match, "main")).toEqual({ xs: "[[1, 2], [3]]", a: "1" });
    const end = last(r.trace);
    expect(frameOf(end, "main").bindings.map((b) => [b.name, show(b.value, end), b.bindingId])).toEqual([
      ["xs", "[[1, 2], [3]]", "frame-main-1:xs#1"],
      ["x", "2", "frame-main-1:x#2"],
    ]);
  });

  it("String values in lists and Print Output together", async () => {
    const src = `import gleam/io

pub fn greet_all(names: List(String)) -> Nil {
  case names {
    [] -> Nil
    [name, ..rest] -> {
      io.println("Hello, " <> name)
      greet_all(rest)
    }
  }
}

pub fn main() {
  greet_all(["Ada", "Grace"])
}
`;
    const r = expectOk(await traceGleam(src));
    expect(last(r.trace).stdout).toBe("Hello, Ada\nHello, Grace\n");
    const firstPrint = r.trace.steps.findIndex((s) => s.stdout === "Hello, Ada\n");
    expect(vars(r.trace.steps[firstPrint], "greet_all")).toEqual({ names: '["Ada", "Grace"]', name: '"Ada"', rest: '["Grace"]' });
  });
});

describe("source mapping and playback", () => {
  it("green = this event, red = the next; earlier snapshots are never changed", async () => {
    const r = expectOk(await traceGleam(FIRST));
    const before = JSON.stringify(r.trace.steps);
    r.trace.steps.forEach((s, i) => {
      expect(s.justExecuted).toEqual(i === 0 ? null : s.source);
      expect(s.nextToExecute).toEqual(r.trace.steps[i + 1]?.source ?? null);
    });
    // Reading backward, then forward, gives the same snapshots.
    const back = [...r.trace.steps].reverse().map((s) => JSON.stringify(s)).reverse();
    expect(back).toEqual(r.trace.steps.map((s) => JSON.stringify(s)));
    expect(JSON.stringify(r.trace.steps)).toBe(before);
  });

  it("every step's Objects hold exactly the cells its frames can reach", async () => {
    const r = expectOk(await traceGleam(FIRST));
    for (const s of r.trace.steps) {
      const cells = s.objects.filter((o) => o.kind === "cons").length;
      const reachesList = userFrames(s).some((f) => f.bindings.some((b) => b.value.kind === "ref"));
      expect(cells > 0).toBe(reachesList);
    }
  });
});

describe("refusals and compiler errors", () => {
  it.each([
    ["tuple patterns", 'pub fn main() {\n  case #(1, 2) {\n    #(a, b) -> a\n  }\n}\n', "Tuples"],
    ["alternative patterns", "pub fn main() {\n  case 1 {\n    1 | 2 -> 0\n    _ -> 1\n  }\n}\n", "Alternative patterns"],
    ["constructor patterns", "pub fn f(x: Bool) -> Int {\n  case Ok(1) {\n    Ok(n) -> n\n    Error(_) -> 0\n  }\n}\npub fn main() {\n  1\n}\n", "Custom type constructors"],
    ["string prefix patterns", 'pub fn main() {\n  case "ab" {\n    "a" <> rest -> rest\n    _ -> ""\n  }\n}\n', 'String prefix patterns ("a" <> rest)'],
    ["pipelines", "fn inc(x: Int) -> Int {\n  x + 1\n}\n\npub fn main() {\n  1 |> inc\n}\n", "Pipelines"],
    ["stdlib calls returning a Result", 'import gleam/list\n\npub fn main() {\n  list.first([1, 2])\n}\n', "Calling list.first (its result type, Result(a, Nil), can't be shown yet)"],
  ])("%s are refused with a reason, never traced", async (_name, src, feature) => {
    const r = await traceGleam(src);
    expect(r.status).toBe("unsupported");
    if (r.status === "unsupported") expect(r.feature).toBe(feature);
  });

  it("a case that misses a pattern is the official compiler's error", async () => {
    const r = toTraceResult(await traceGleam("pub fn f(xs: List(Int)) -> Int {\n  case xs {\n    [] -> 0\n  }\n}\n\npub fn main() {\n  f([1])\n}\n"));
    expect(r.status).toBe("compile_error");
    expect(r.status === "compile_error" && r.message).toMatch(/Inexhaustive patterns/);
    expect(r.status === "compile_error" && r.location?.line).toBe(2);
  });

  it("a very long list stops at the event limit instead of growing the trace without bound", async () => {
    const r = await traceGleam(`pub fn main() {\n  [${Array.from({ length: 40 }, (_, i) => i).join(", ")}]\n}\n`, { maxEvents: 20 });
    expect(r).toMatchObject({ status: "limit", message: "Trace is longer than 20 events" });
  });
});
