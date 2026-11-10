/**
 * Raw events -> the app's existing ExecutionTrace (src/trace/types.ts), with
 * traceKind "real". Pure function; no React, no runtime references kept.
 *
 * Step rules:
 *  - One step per recorded event, except that a `line` event immediately
 *    followed by the `bind`/`return`/`done` of the same statement is merged
 *    into it. A statement therefore shows as one step when nothing else
 *    happened during it, and as "about to evaluate" + "finished" when calls
 *    or clause selections happened inside it.
 *  - justExecuted(i) = location of event i (null for the first step);
 *    nextToExecute(i) = location of event i+1 (null for the last step).
 *  - Frames are logical call frames. Shadowing appends a NEW binding with a
 *    new bindingId; the shadowed one is no longer visible (it is not mutated).
 *  - `match` (a case clause was selected) is a step; the clause's pattern
 *    variables are bound in it. They belong to the clause: when the case
 *    expression has produced its value (`close`), the frame's bindings return
 *    to what they were before the case, at the frame's next step. At a
 *    `return` they are still shown, since they produced the returned value.
 *    Blocks work the same way (`open` ... `close`), without a step of their own.
 *  - A call marked `tail` (a self tail call the compiled program runs as a
 *    loop) gets a frame flagged `tailCall`: a logical frame.
 *  - List values are references to immutable cells (`cons` objects). Each
 *    step's Objects are the function objects plus every cell reachable from
 *    that step's frames, in a stable order.
 *  - Frame and cell objects are immutable once placed in a step and are
 *    SHARED between steps (no deep copies). Copying every frame into every
 *    step costs O(steps x frames) and crashed the host process during deep
 *    recursion. The total snapshot size is capped (maxSnapshotFrames).
 *  - Printed output (`out` events) does not make steps of its own. Each step's
 *    stdout is everything printed up to and including that step.
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

/** Upper bound on the sum, over all steps, of frames and list cells in each step's snapshot. */
export const MAX_SNAPSHOT_FRAMES = 200_000;

const toLoc = ([line, column, endLine, endColumn]: RawLoc): SourceLocation => ({ line, column, endLine, endColumn });

const cellId = (node: number) => `list-${node}`;

function toValue(v: RawValue): TraceValue {
  switch (v.kind) {
    case "int":
      return { kind: "int", value: v.value };
    case "bool":
      return { kind: "bool", value: v.value };
    case "string":
      return { kind: "string", value: v.value };
    case "nil":
      return { kind: "nil" };
    case "list":
      return v.node === null ? { kind: "empty-list" } : { kind: "ref", id: cellId(v.node) };
    default:
      throw new NormalizeError(`a value of type ${v.jsType} can't be shown yet`);
  }
}

type StepEvent = Extract<RawEvent, { t: "call" | "line" | "bind" | "return" | "done" | "match" }>;
const isStep = (e: RawEvent): e is StepEvent => e.t !== "out" && e.t !== "node" && e.t !== "close" && e.t !== "open";

const EVENT_KIND: Record<StepEvent["t"], TraceEventKind> = { call: "call", line: "eval", bind: "bind", return: "return", done: "eval", match: "match" };

/**
 * Drops a `line` ("about to evaluate") event when the same statement finishes
 * (bind / return / done) with nothing but output, new list cells or a case
 * ending in between.
 */
export function mergeEvents(events: RawEvent[]): RawEvent[] {
  return events.filter((e, i) => {
    if (e.t !== "line") return true;
    let j = i + 1;
    while (events[j] && !isStep(events[j])) j++;
    const n = events[j];
    return !(n && (n.t === "bind" || n.t === "return" || n.t === "done") && n.frame === e.frame && n.loc.join() === e.loc.join());
  });
}

interface FrameState {
  frame: TraceFrame;
  shadowCount: Map<string, number>;
  /** Open case expressions: the bindings to restore when each one ends. */
  scopes: { caseId: number; saved: TraceBinding[] }[];
  /** Case expressions that ended; applied at the frame's next non-return step. */
  closed: number[];
}

export function normalize(
  source: string,
  module: SubsetModule,
  rawEvents: RawEvent[],
  error: TraceError | null = null,
  maxSnapshotFrames = MAX_SNAPSHOT_FRAMES,
): ExecutionTrace {
  const events = mergeEvents(rawEvents);
  let snapshotSize = 0;

  // List cells are immutable: collect them all first (an argument's cells may be recorded just after its call).
  const cells = new Map<number, Extract<RawEvent, { t: "node" }>>();
  for (const e of events) if (e.t === "node") cells.set(e.id, e);
  const cellObjects = new Map<number, TraceObject>();
  const cellObject = (id: number): TraceObject => {
    let o = cellObjects.get(id);
    if (!o) {
      const c = cells.get(id);
      if (!c) throw new NormalizeError(`list cell ${id} was not recorded`);
      o = { id: cellId(id), kind: "cons", head: toValue(c.head), tail: c.tail === null ? { kind: "empty-list" } : { kind: "ref", id: cellId(c.tail) } };
      cellObjects.set(id, o);
    }
    return o;
  };

  const functionObjects: TraceObject[] = module.functions.map((f) => ({
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

  /** Function objects plus every list cell reachable from the frames, depth first. */
  const objectsFor = (frames: TraceFrame[]): TraceObject[] => {
    const out = [...functionObjects];
    const seen = new Set<string>();
    const visit = (v: TraceValue | undefined) => {
      while (v && v.kind === "ref" && v.id.startsWith("list-") && !seen.has(v.id)) {
        seen.add(v.id);
        const o = cellObject(Number(v.id.slice("list-".length)));
        out.push(o);
        if (o.kind !== "cons") return;
        visit(o.head);
        v = o.tail;
      }
    };
    for (const f of frames) {
      f.bindings.forEach((b) => visit(b.value));
      visit(f.returnValue);
    }
    return out;
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

  /** Ends the scopes of case expressions that have finished. */
  const applyClosed = (st: FrameState) => {
    for (const caseId of st.closed) {
      const i = st.scopes.map((s) => s.caseId).lastIndexOf(caseId);
      if (i === -1) continue;
      const saved = st.scopes[i].saved;
      st.scopes.length = i;
      st.frame = { ...st.frame, bindings: saved };
    }
    st.closed = [];
  };

  let stdout = "";
  const stepEvents = events.filter(isStep);
  let k = 0; // index into stepEvents
  let lastFrames: TraceFrame[] | null = null;
  let lastObjects: TraceObject[] = functionObjects;
  for (const e of events) {
    if (e.t === "out") {
      stdout += e.text;
      continue;
    }
    if (e.t === "node") continue;
    if (e.t === "close") {
      frames.get(e.frame)?.closed.push(e.caseId);
      continue;
    }
    if (e.t === "open") {
      // A block starts: remember the bindings to restore when it ends.
      const st = frames.get(e.frame);
      if (st) {
        applyClosed(st);
        st.scopes.push({ caseId: e.scopeId, saved: st.frame.bindings });
      }
      continue;
    }
    const i = k++;
    if (e.t === "call") {
      const st: FrameState = {
        frame: {
          id: `frame-${e.fn}-${e.frame}`,
          functionName: e.fn,
          parentId: "module-main",
          status: "active",
          bindings: [],
          ...(e.tail ? { tailCall: true } : {}),
        },
        shadowCount: new Map(),
        scopes: [],
        closed: [],
      };
      for (const [name, v] of e.args) setBinding(st, name, toValue(v));
      frames.set(e.frame, st);
      order.push(e.frame);
    } else {
      const st = frames.get(e.frame);
      if (!st) throw new NormalizeError(`event for unknown frame ${e.frame}`);
      if (e.t !== "return") applyClosed(st);
      if (e.t === "bind") setBinding(st, e.name, toValue(e.value));
      if (e.t === "match") {
        st.scopes.push({ caseId: e.caseId, saved: st.frame.bindings });
        for (const [name, v] of e.binds) setBinding(st, name, toValue(v));
      }
      if (e.t === "return") st.frame = { ...st.frame, status: "exited", returnValue: toValue(e.value) };
    }
    const next = stepEvents[i + 1];
    const stepFrames = [moduleFrame, ...order.map((id) => frames.get(id)!.frame)];
    // Same frames as the previous step -> same objects (frames are shared, never mutated).
    const sameFrames = lastFrames !== null && lastFrames.length === stepFrames.length && lastFrames.every((f, j) => f === stepFrames[j]);
    const objects = sameFrames ? lastObjects : objectsFor(stepFrames);
    lastFrames = stepFrames;
    lastObjects = objects;
    snapshotSize += stepFrames.length + objects.length;
    if (snapshotSize > maxSnapshotFrames) {
      throw new NormalizeLimitError(`Trace is too large to visualize (more than ${maxSnapshotFrames} frame snapshots)`);
    }
    steps.push({
      index: i,
      event: EVENT_KIND[e.t],
      source: toLoc(e.loc),
      justExecuted: i === 0 ? null : toLoc(e.loc),
      nextToExecute: next ? toLoc(next.loc) : null,
      stdout,
      frames: stepFrames,
      objects,
      error: null,
      note:
        e.t === "call"
          ? `call ${e.fn}`
          : e.t === "bind"
            ? `bind ${e.name}`
            : e.t === "return"
              ? "return"
              : e.t === "match"
                ? `match case ${e.caseId}`
                : e.t === "done"
                  ? "evaluated"
                  : "evaluate",
    });
  }
  if (steps.length > 0) {
    // Output printed after the last step (e.g. just before a crash) belongs to that last step.
    const last = steps[steps.length - 1];
    steps[steps.length - 1] = { ...last, stdout, ...(error ? { error } : {}) };
  }

  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    traceKind: "real",
    sourceHash: hashSource(source),
    source: normalizeSource(source),
    target: "javascript",
    steps,
  };
}
