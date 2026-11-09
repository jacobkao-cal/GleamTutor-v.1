import type { TraceFrame, TraceStep } from "../../src/trace/types";
import type { RunLimits } from "../../src/tracer/events";
import { traceGleam as engineTrace, type EngineResult } from "../../src/tracer/traceGleam";
import { nodeRuntime } from "../nodeRuntime";

type PocResult = EngineResult;

/** The engine with the Node runtime (the runtime the tests exercise). */
export const traceGleam = (source: string, limits: Partial<RunLimits> = {}) => engineTrace(source, nodeRuntime, limits);

export type Ok = Extract<PocResult, { status: "ok" }>;

export function expectOk(r: PocResult): Ok {
  if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}: ${JSON.stringify(r).slice(0, 400)}`);
  return r;
}

/** Display form of a frame: `name[a=1 b=2 => 3]`, ignoring the module frame. */
export function frameSummary(f: TraceFrame): string {
  const v = (x: { kind: string; value?: unknown }) => String(x.value);
  const vars = f.bindings.map((b) => `${b.name}=${v(b.value)}`).join(" ");
  return `${f.functionName}${f.status === "exited" ? "!" : ""}[${vars}${f.returnValue ? ` => ${v(f.returnValue)}` : ""}]`;
}

export function stepSummary(s: TraceStep): string {
  const frames = s.frames.filter((f) => f.status !== "module").map(frameSummary).join(" ");
  return `${s.event}@${s.source.line} ${frames}`;
}

/** Raw events in a compact, order-preserving form. */
export function eventSummary(r: Ok): string[] {
  return r.events.map((e) => {
    switch (e.t) {
      case "call":
        return `call ${e.fn}(${e.args.map(([n, v]) => `${n}=${"value" in v ? v.value : "?"}`).join(", ")})`;
      case "bind":
        return `bind ${e.name}=${"value" in e.value ? e.value.value : "?"}`;
      case "return":
        return `return ${"value" in e.value ? e.value.value : "?"}`;
      case "out":
        return `out ${JSON.stringify(e.text)}`;
      case "done":
        return `done ${e.loc[0]}`;
      default:
        return `line ${e.loc[0]}`;
    }
  });
}
