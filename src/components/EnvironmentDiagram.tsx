/**
 * Frames + Objects renderer for one trace step, with SVG pointer arrows from
 * reference bindings to objects. Pure function of (step, options).
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { TraceFrame, TraceObject, TraceStep, TraceValue } from "../trace/types";

interface Props {
  step: TraceStep;
  showExitedFrames: boolean;
}

export const POINTER_COLOR = "#292d3e"; // Gleam underwater blue

function frameTitle(f: TraceFrame): string {
  return f.status === "module" ? `module ${f.functionName}` : f.functionName;
}

/** The frame the program is currently evaluating in: deepest active call, else the module. */
function currentFrameId(frames: TraceFrame[]): string | null {
  const active = frames.filter((f) => f.status === "active");
  if (active.length > 0) return active[active.length - 1].id;
  return frames.find((f) => f.status === "module")?.id ?? null;
}

function ValueCell({ value, srcKey }: { value: TraceValue; srcKey: string }) {
  switch (value.kind) {
    case "ref":
      return <span className="ref-dot" data-ref-src={srcKey} data-ref-target={value.id} />;
    case "string":
      return <span className="value-string">{JSON.stringify(value.value)}</span>;
    case "bool":
      return <span>{value.value ? "True" : "False"}</span>;
    case "nil":
      return <span>Nil</span>;
    default:
      return <span>{value.value}</span>;
  }
}

function FrameBox({ frame, current }: { frame: TraceFrame; current: boolean }) {
  const cls = ["frame", current ? "frame-current" : "", frame.status === "exited" ? "frame-exited" : ""].join(" ").trim();
  return (
    <div className={cls} data-frame-id={frame.id} data-frame-status={frame.status}>
      <div className="frame-header">{frameTitle(frame)}</div>
      <table className="frame-vars">
        <tbody>
          {frame.bindings.map((b) => (
            <tr key={b.bindingId ?? b.name} data-binding={b.name}>
              <td className="frame-var-name">{b.name}</td>
              <td className="frame-var-value">
                <ValueCell value={b.value} srcKey={`${frame.id}:${b.name}`} />
              </td>
            </tr>
          ))}
          {frame.returnValue && (
            <tr data-binding="__return">
              <td className="frame-var-name frame-return-label">
                Return
                <br />
                value
              </td>
              <td className="frame-var-value">
                <ValueCell value={frame.returnValue} srcKey={`${frame.id}:__return`} />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ObjectBox({ obj }: { obj: TraceObject }) {
  let body: ReactNode;
  switch (obj.kind) {
    case "function":
      body = <span className="object-function">{obj.signature}</span>;
      break;
    case "list":
      body = <span className="object-generic">[{obj.items.length} items]</span>;
      break;
    case "tuple":
      body = <span className="object-generic">#({obj.items.length} items)</span>;
      break;
    case "record":
      body = <span className="object-generic">{obj.constructor}(…)</span>;
      break;
  }
  return (
    <div className="heap-object" data-obj-id={obj.id}>
      {body}
    </div>
  );
}

interface Pointer {
  key: string;
  d: string;
}

/** Measures rendered dots/objects and computes curved arrow paths in container coordinates. */
function usePointers(dep: unknown) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pointers, setPointers] = useState<Pointer[]>([]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const base = container.getBoundingClientRect();
      const out: Pointer[] = [];
      container.querySelectorAll<HTMLElement>("[data-ref-src]").forEach((src) => {
        const target = container.querySelector<HTMLElement>(`[data-obj-id="${CSS.escape(src.dataset.refTarget ?? "")}"]`);
        if (!target) return;
        const a = src.getBoundingClientRect();
        const b = target.getBoundingClientRect();
        const x1 = a.left + a.width / 2 - base.left;
        const y1 = a.top + a.height / 2 - base.top;
        const x2 = b.left - base.left - 2;
        const y2 = b.top + Math.min(b.height / 2, 10) - base.top;
        const dx = Math.max((x2 - x1) * 0.45, 20);
        out.push({ key: src.dataset.refSrc ?? "", d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` });
      });
      setPointers((prev) => (JSON.stringify(prev) === JSON.stringify(out) ? prev : out));
    };
    measure();
    // Web fonts change text widths after first paint; re-measure once they load.
    let alive = true;
    document.fonts?.ready.then(() => alive && measure());
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(container);
    window.addEventListener("resize", measure);
    return () => {
      alive = false;
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [dep]);

  return { containerRef, pointers };
}

export function EnvironmentDiagram({ step, showExitedFrames }: Props) {
  const frames = step.frames.filter((f) => showExitedFrames || f.status !== "exited");
  const currentId = currentFrameId(step.frames);
  const { containerRef, pointers } = usePointers(`${step.index}|${showExitedFrames}`);

  return (
    <div className="env-diagram" ref={containerRef}>
      <div className="frames-column">
        <div className="column-header">Frames</div>
        {frames.map((f) => (
          <FrameBox key={f.id} frame={f} current={f.id === currentId} />
        ))}
      </div>
      <div className="objects-column">
        <div className="column-header">Objects</div>
        {step.objects.map((o) => (
          <ObjectBox key={o.id} obj={o} />
        ))}
      </div>
      <svg className="pointer-layer" aria-hidden="true">
        <defs>
          <marker id="pointer-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,1 L10,5 L0,9 z" fill={POINTER_COLOR} />
          </marker>
        </defs>
        {pointers.map((p) => (
          <path key={p.key} d={p.d} fill="none" stroke={POINTER_COLOR} strokeWidth={1.5} markerEnd="url(#pointer-head)" />
        ))}
      </svg>
    </div>
  );
}
