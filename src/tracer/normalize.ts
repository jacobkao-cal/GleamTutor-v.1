/**
 * Raw events -> the app's existing ExecutionTrace (src/trace/types.ts), with
 * traceKind "real". Pure function; no React, no runtime references kept.
 *
 * Step rules (proposal for Phase 2B, see docs/PHASE_2_ARCHITECTURE.md):
 *  - One step per recorded event, except that a `line` event immediately
 *    followed by the `bind`/`return` of the same statement is merged into it.
 *    A statement therefore shows as one step when nothing else happened during
 *    it, and as "about to evaluate" + "finished" when calls happened inside it.
 *  - justExecuted(i) = location of event i (null for the first step);
 *    nextToExecute(i) = location of event i+1 (null for the last step).
 *  - Frames are logical call frames. Shadowing appends a NEW binding with a
 *    new bindingId; the shadowed one is no longer visible (it is not mutated).
 *  - Frame objects are immutable once placed in a step and are SHARED between
 *    steps (no deep copies). Copying every frame into every step costs
 *    O(steps x frames) and crashed the host process during deep recursion.
 *  - The total snapshot size is capped (maxSnapshotFrames).
 */
import { hashSource, normalizeSource } from "../trace/source";
import {
  TRACE_SCHEMA_VERSION,
  type ExecutionTrace,
  type SourceLocation,
  type TraceBinding,
  type TraceError,
  type TraceEventKind,
  type TraceFrame,
  type TraceObject,
  type TraceStep,
  type TraceValue,
} from "../trace/types";
import type { RawEvent, RawLoc, RawValue } from "./events";
import type { SubsetModule } from "./subset";

export class NormalizeError extends Error {}
/** The trace is too large to turn into snapshots. */
export class NormalizeLimitError extends Error {}

/** Upper bound on the sum, over all steps, of frames in each step's snapshot. */
export const MAX_SNAPSHOT_FRAMES = 200_000;

const toLoc = ([line, column, endLine, endColumn]: RawLoc): SourceLocation => ({ line, column, endLine, endColumn });

function toValue(v: RawValue): TraceValue {
  if (v.kind === "unsupported") throw new NormalizeError(`value of JS type ${v.jsType} is outside the supported subset`);
  return v.kind === "int" ? { kind: "int", value: v.value } : { kind: "bool", value: v.value };
}

const EVENT_KIND: Record<RawEvent["t"], TraceEventKind> = { call: "call", line: "eval", bind: "bind", return: "return" };

export function mergeEvents(events: RawEvent[]): RawEvent[] {
  return events.filter((e, i) => {
    const n = events[i + 1];
    return !(e.t === "line" && n && (n.t === "bind" || n.t === "return") && n.frame === e.frame && n.loc.join() === e.loc.join());
  });
}

interface FrameState {
  frame: TraceFrame;
  shadowCount: Map<string, number>;
}

export function normalize(
  source: string,
  module: SubsetModule,
  rawEvents: RawEvent[],
  error: TraceError | null = null,
  maxSnapshotFrames = MAX_SNAPSHOT_FRAMES,
): ExecutionTrace {
  const events = mergeEvents(rawEvents);
  let snapshotFrames = 0;
  const objects: TraceObject[] = module.functions.map((f) => ({
    id: `fn-${f.name}`,
    kind: "function",
    name: f.name,
    signature: f.signature,
    module: "main",
  }));
  const moduleFrame: TraceFrame = {
    id: "module-main",
    functionName: "main",
    parentId: null,
    status: "module",
    bindings: module.functions.map((f) => ({ name: f.name, value: { kind: "ref", id: `fn-${f.name}` } })),
  };

  const frames = new Map<number, FrameState>();
  const order: number[] = [];
  const steps: TraceStep[] = [];

  const setBinding = (st: FrameState, name: string, value: TraceValue) => {
    const n = (st.shadowCount.get(name) ?? 0) + 1;
    st.shadowCount.set(name, n);
    const binding: TraceBinding = { name, value, bindingId: `${st.frame.id}:${name}#${n}` };
    st.frame = { ...st.frame, bindings: [...st.frame.bindings.filter((b) => b.name !== name), binding] };
  };

  events.forEach((e, i) => {
    if (e.t === "call") {
      const st: FrameState = {
        frame: { id: `frame-${e.fn}-${e.frame}`, functionName: e.fn, parentId: "module-main", status: "active", bindings: [] },
        shadowCount: new Map(),
      };
      for (const [name, v] of e.args) setBinding(st, name, toValue(v));
      frames.set(e.frame, st);
      order.push(e.frame);
    } else {
      const st = frames.get(e.frame);
      if (!st) throw new NormalizeError(`event for unknown frame ${e.frame}`);
      if (e.t === "bind") setBinding(st, e.name, toValue(e.value));
      if (e.t === "return") st.frame = { ...st.frame, status: "exited", returnValue: toValue(e.value) };
    }
    const next = events[i + 1];
    snapshotFrames += order.length + 1;
    if (snapshotFrames > maxSnapshotFrames) {
      throw new NormalizeLimitError(`Trace is too large to visualize (more than ${maxSnapshotFrames} frame snapshots)`);
    }
    steps.push({
      index: i,
      event: EVENT_KIND[e.t],
      source: toLoc(e.loc),
      justExecuted: i === 0 ? null : toLoc(e.loc),
      nextToExecute: next ? toLoc(next.loc) : null,
      stdout: "",
      // Shared, never mutated: a later event replaces a frame object instead of changing it.
      frames: [moduleFrame, ...order.map((id) => frames.get(id)!.frame)],
      objects,
      error: null,
      note: e.t === "call" ? `call ${e.fn}` : e.t === "bind" ? `bind ${e.name}` : e.t === "return" ? "return" : "evaluate",
    });
  });
  if (error && steps.length > 0) steps[steps.length - 1] = { ...steps[steps.length - 1], error };

  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    traceKind: "real",
    sourceHash: hashSource(source),
    source: normalizeSource(source),
    target: "javascript",
    steps,
  };
}
