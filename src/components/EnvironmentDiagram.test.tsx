/** Drawing immutable lists (Phase 3A): cells in chains, shared tails, [] inline. */
import { render } from "@testing-library/react";
import type { TraceObject, TraceStep } from "../trace/types";
import { EnvironmentDiagram } from "./EnvironmentDiagram";

const cell = (id: string, head: number, tail: string | null): TraceObject => ({
  id,
  kind: "cons",
  head: { kind: "int", value: String(head) },
  tail: tail ? { kind: "ref", id: tail } : { kind: "empty-list" },
});

// old = [1, 2, 3] (cells c1 -> c2 -> c3); new = [0, ..old] (cell c0 -> c1); none = []
const STEP: TraceStep = {
  index: 0,
  event: "bind",
  source: { line: 1 },
  justExecuted: null,
  nextToExecute: null,
  stdout: "",
  error: null,
  frames: [
    {
      id: "frame-main-1",
      functionName: "main",
      parentId: null,
      status: "active",
      bindings: [
        { name: "old", value: { kind: "ref", id: "c1" } },
        { name: "new", value: { kind: "ref", id: "c0" } },
        { name: "none", value: { kind: "empty-list" } },
      ],
    },
  ],
  objects: [cell("c1", 1, "c2"), cell("c2", 2, "c3"), cell("c3", 3, null), cell("c0", 0, "c1")],
};

describe("list cells in the Objects column", () => {
  it("draws each list as a chain of [head | tail] cells, and [] inline", () => {
    const { container } = render(<EnvironmentDiagram step={STEP} showExitedFrames />);
    const rows = [...container.querySelectorAll(".heap-row")].map((r) =>
      [...r.querySelectorAll(".heap-cons")].map((c) => c.querySelector(".cons-head")!.textContent + "|" + (c.querySelector(".cons-tail .ref-dot") ? "•" : c.querySelector(".cons-tail")!.textContent)),
    );
    // One chain: new's cell 0 continues into old's cells, so the tail is visibly shared, not copied;
    // old's pointer lands on the second cell of that chain.
    expect(rows).toEqual([["0|•", "1|•", "2|•", "3|[]"]]);
    expect(container.querySelector('[data-obj-id="c0"] .cons-tail [data-ref-target]')?.getAttribute("data-ref-target")).toBe("c1");
    expect(container.querySelector('[data-binding="none"] .frame-var-value')?.textContent).toBe("[]");
    expect(container.querySelector('[data-binding="old"] [data-ref-target]')?.getAttribute("data-ref-target")).toBe("c1");
  });
});

describe("logical tail-call frames", () => {
  it("label a frame created by a tail call, and only that frame", () => {
    const frame = (id: string, tailCall: boolean) => ({
      id,
      functionName: "count_down",
      parentId: null,
      status: "active" as const,
      bindings: [],
      ...(tailCall ? { tailCall: true } : {}),
    });
    const step: TraceStep = { ...STEP, objects: [], frames: [frame("frame-count_down-2", false), frame("frame-count_down-3", true)] };
    const { container } = render(<EnvironmentDiagram step={step} showExitedFrames />);
    expect(container.querySelector('[data-frame-id="frame-count_down-2"] .frame-tag')).toBeNull();
    const tag = container.querySelector('[data-frame-id="frame-count_down-3"] .frame-tag');
    expect(tag?.textContent).toBe("tail call");
    expect(tag?.getAttribute("title")).toMatch(/Logical frame/);
  });
});
