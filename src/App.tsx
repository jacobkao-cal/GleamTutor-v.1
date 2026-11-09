/**
 * Top-level mode switch: Edit Mode -> Visualize Execution -> Visualization Mode
 * -> Edit this code. The source text is owned here so it survives mode changes.
 */
import { useRef, useState } from "react";
import { EditMode } from "./components/EditMode";
import { VisualizeMode } from "./components/VisualizeMode";
import { DEMO_SOURCE } from "./trace/demoTrace";
import { demoTracer, type Tracer } from "./trace/tracer";
import type { ExecutionTrace } from "./trace/types";

interface Props {
  tracer?: Tracer;
  initialSource?: string;
}

type View = { mode: "edit" } | { mode: "visualize"; trace: ExecutionTrace; runId: number };

export default function App({ tracer = demoTracer, initialSource = DEMO_SOURCE }: Props) {
  const [source, setSource] = useState(initialSource);
  const [showExitedFrames, setShowExitedFrames] = useState(true);
  const [view, setView] = useState<View>({ mode: "edit" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runCounter = useRef(0);
  const latestSource = useRef(source);

  const updateSource = (s: string) => {
    latestSource.current = s;
    setSource(s);
    setError(null); // an old error must not describe edited code
  };

  const visualize = async () => {
    setBusy(true);
    setError(null);
    const requested = source;
    try {
      const result = await tracer.trace(requested);
      // If the code was edited while tracing, the result describes stale code: drop it.
      if (latestSource.current !== requested) return;
      if (result.status === "ok") {
        runCounter.current += 1;
        // A fresh runId remounts the visualizer, so playback restarts at step 1.
        setView({ mode: "visualize", trace: result.trace, runId: runCounter.current });
      } else {
        const where = result.status === "compile_error" && result.location ? ` (line ${result.location.line})` : "";
        setError(result.message + where);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="site-header">
        <img src="/gleam-star.png" alt="" className="site-logo" />
        <span className="site-title">Gleam Tutor</span>
      </header>
      {view.mode === "edit" ? (
        <EditMode
          source={source}
          onSourceChange={updateSource}
          showExitedFrames={showExitedFrames}
          onShowExitedFramesChange={setShowExitedFrames}
          onVisualize={visualize}
          onLoadDemo={() => updateSource(DEMO_SOURCE)}
          busy={busy}
          error={error}
        />
      ) : (
        <VisualizeMode
          key={view.runId}
          trace={view.trace}
          showExitedFrames={showExitedFrames}
          onEdit={() => setView({ mode: "edit" })}
        />
      )}
    </div>
  );
}
