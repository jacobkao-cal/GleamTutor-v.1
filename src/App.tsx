/**
 * Top-level mode switch: Edit Mode -> Visualize Execution -> Visualization Mode
 * -> Edit this code. The source text is owned here so it survives mode changes.
 */
import { useRef, useState } from "react";
import { EditMode } from "./components/EditMode";
import { VisualizeMode } from "./components/VisualizeMode";
import { findExampleById, findExampleBySource } from "./examples/library";
import { DEMO_SOURCE } from "./trace/demoTrace";
import { demoTracer, type Tracer } from "./trace/tracer";
import type { ExecutionTrace, SourceLocation } from "./trace/types";

interface Props {
  tracer?: Tracer;
  initialSource?: string;
  /** True when `tracer` runs real programs (local preview); changes wording only. */
  realTracing?: boolean;
}

type View = { mode: "edit" } | { mode: "visualize"; trace: ExecutionTrace; runId: number };

/** Friendly notice for a library example: examples are for reading/editing; none has a trace yet. */
export function exampleNotTraceableMessage(title: string): string {
  return (
    `Step-by-step tracing for the "${title}" example isn't available yet. ` +
    "Gleam Tutor can't run Gleam code yet; the only program it can step through is the square(5) Demo trace. " +
    "You can still read and edit this example."
  );
}

/** True when the editor holds the student's own work that loading an example would discard. */
function hasOwnWork(source: string): boolean {
  return source.trim() !== "" && source !== DEMO_SOURCE && !findExampleBySource(source);
}

/** Appends "(line L, column C)" when a location is known. */
function withLocation(message: string, location?: SourceLocation): string {
  if (!location) return message;
  return `${message} (line ${location.line}${location.column ? `, column ${location.column}` : ""})`;
}

export default function App({ tracer = demoTracer, initialSource = DEMO_SOURCE, realTracing = false }: Props) {
  const [source, setSource] = useState(initialSource);
  const [showExitedFrames, setShowExitedFrames] = useState(true);
  const [view, setView] = useState<View>({ mode: "edit" });
  const [error, setError] = useState<string | null>(null);
  const [errorTone, setErrorTone] = useState<"error" | "info">("error");
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runCounter = useRef(0);
  const latestSource = useRef(source);

  const updateSource = (s: string) => {
    latestSource.current = s;
    setSource(s);
    setError(null); // an old error must not describe edited code
    setErrorDetails(null);
  };

  const loadExample = (id: string) => {
    const example = findExampleById(id);
    if (!example) return;
    if (hasOwnWork(latestSource.current) && !window.confirm("Replace your code with this example? Your changes will be lost.")) {
      return;
    }
    updateSource(example.code); // load only; never traced or run automatically
  };

  const visualize = async () => {
    setBusy(true);
    setError(null);
    setErrorDetails(null);
    const requested = source;
    try {
      const result = await tracer.trace(requested);
      // If the code was edited while tracing, the result describes stale code: drop it.
      if (latestSource.current !== requested) return;
      const trace = result.status === "ok" ? result.trace : result.status === "runtime_error" ? result.trace : null;
      if (trace) {
        // A runtime error with a partial trace is still visualized; its last step shows the error.
        runCounter.current += 1;
        // A fresh runId remounts the visualizer, so playback restarts at step 1.
        setView({ mode: "visualize", trace, runId: runCounter.current });
      } else if (result.status === "ok") {
        // unreachable: an ok result always has a trace
      } else if (result.status === "unsupported" && !result.feature && findExampleBySource(requested)) {
        setErrorTone("info");
        setError(exampleNotTraceableMessage(findExampleBySource(requested)!.title));
      } else if (result.status === "unsupported") {
        setErrorTone("info");
        setError(withLocation(result.message, result.location));
      } else if (result.status === "compile_error") {
        setErrorTone("error");
        setError(withLocation(result.message, result.location));
        setErrorDetails(result.details ?? null);
      } else {
        setErrorTone("error");
        setError(result.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="site-header">
        <div className="site-header-inner">
          <img src="/gleam-star.png" alt="" className="site-logo" />
          <span className="site-title">Gleam Tutor</span>
        </div>
      </header>
      <main className="app-main">
        {view.mode === "edit" ? (
          <EditMode
            source={source}
            onSourceChange={updateSource}
            showExitedFrames={showExitedFrames}
            onShowExitedFramesChange={setShowExitedFrames}
            onVisualize={visualize}
            onLoadDemo={() => updateSource(DEMO_SOURCE)}
            onLoadExample={loadExample}
            busy={busy}
            error={error}
            errorTone={errorTone}
            errorDetails={errorDetails}
            realTracing={realTracing}
          />
        ) : (
          <VisualizeMode
            key={view.runId}
            trace={view.trace}
            showExitedFrames={showExitedFrames}
            onEdit={() => setView({ mode: "edit" })}
          />
        )}
      </main>
    </div>
  );
}
