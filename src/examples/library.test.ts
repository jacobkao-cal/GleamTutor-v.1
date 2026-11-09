import { GT_EXAMPLES } from "../../examples.js";
import { DEMO_SOURCE } from "../trace/demoTrace";
import { demoTracer } from "../trace/tracer";
import { EXAMPLES, findExampleById, findExampleBySource, groupExamples } from "./library";

describe("example library", () => {
  it("uses examples.js directly (no copy)", () => {
    expect(EXAMPLES).toBe(GT_EXAMPLES);
  });

  it("keeps the categories and their order from examples.js", () => {
    expect(groupExamples().map((g) => g.group)).toEqual([
      "Basics",
      "Functions",
      "Flow control",
      "Data types",
      "Standard library",
      "Advanced features",
    ]);
  });

  it("puts every example in its own category, in file order", () => {
    const groups = groupExamples();
    expect(groups.flatMap((g) => g.examples)).toEqual([...GT_EXAMPLES]);
    for (const g of groups) for (const ex of g.examples) expect(ex.group).toBe(g.group);
    expect(groups.find((g) => g.group === "Basics")!.examples.map((e) => e.id)).toEqual(["hello", "assignments", "lists"]);
  });

  it("has unique ids, titles and non-empty code with a main function", () => {
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
    for (const e of EXAMPLES) {
      expect(e.title.trim()).not.toBe("");
      expect(e.code).toMatch(/pub fn main\(\)/);
    }
  });

  it("looks examples up by id and by exact source", () => {
    expect(findExampleById("recursion")?.title).toBe("Recursion: factorial");
    expect(findExampleById("nope")).toBeUndefined();
    const ex = findExampleById("tuples")!;
    expect(findExampleBySource(ex.code)).toBe(ex);
    expect(findExampleBySource(ex.code + " ")).toBeUndefined();
  });

  it.each(GT_EXAMPLES.map((e) => [e.id, e.code]))("%s is not given the square(5) Demo trace", async (_, code) => {
    expect(code).not.toBe(DEMO_SOURCE);
    expect((await demoTracer.trace(code)).status).toBe("unsupported");
  });
});
