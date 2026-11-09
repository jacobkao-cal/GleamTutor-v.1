/**
 * Visualization Mode: source + controls on the left; Print Output, Frames and
 * Objects on the right. Every pane reads the same `playback.index`.
 */
import { usePlayback } from "../playback/playback";
import type { ExecutionTrace } from "../trace/types";
import { EnvironmentDiagram } from "./EnvironmentDiagram";
import { PlaybackControls } from "./PlaybackControls";
import { Arrow, GREEN_ARROW, RED_ARROW, SourceDisplay } from "./SourceDisplay";

interface Props {
  trace: ExecutionTrace;
  showExitedFrames: boolean;
  onEdit: () => void;
}

export function VisualizeMode({ trace, showExitedFrames, onEdit }: Props) {
  const playback = usePlayback(trace.steps.length);
  const step = trace.steps[playback.index];

  return (
    <div className="visualize-mode">
      <div className="viz-left">
        <div className="viz-language">
          Gleam (JavaScript target)
          <br />
          {trace.traceKind === "fixture" ? (
            <span className="demo-trace-label" title="Predefined trace for this exact example. Your code was not executed.">
              Demo trace (predefined, not a live execution)
            </span>
          ) : (
            <span>Live trace</span>
          )}
        </div>
        <div className="source-wrapper">
          <SourceDisplay source={trace.source} justExecuted={step.justExecuted} nextToExecute={step.nextToExecute} />
        </div>
        <div className="edit-link-row">
          <a
            href="#edit"
            className="edit-code-link"
            onClick={(e) => {
              e.preventDefault();
              onEdit();
            }}
          >
            Edit this code
          </a>
        </div>
        <div className="arrow-legend">
          <div>
            <Arrow color={GREEN_ARROW} title="" /> line that just executed
          </div>
          <div>
            <Arrow color={RED_ARROW} title="" /> next line to execute
          </div>
        </div>
        <PlaybackControls playback={playback} />
        {step.error && <div className="trace-error">{step.error.message}</div>}
      </div>
      <div className="viz-right">
        <div className="print-output-label">Print output (drag lower right corner to resize)</div>
        <textarea className="print-output" aria-label="Print output" readOnly value={step.stdout} />
        <EnvironmentDiagram step={step} showExitedFrames={showExitedFrames} />
      </div>
    </div>
  );
}
