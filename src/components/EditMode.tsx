/** Edit Mode: settings line, code editor, and the Visualize Execution button. */
import { CodeEditor } from "../editor/CodeEditor";
import { ExamplePicker } from "./ExamplePicker";

interface Props {
  source: string;
  onSourceChange: (s: string) => void;
  showExitedFrames: boolean;
  onShowExitedFramesChange: (v: boolean) => void;
  onVisualize: () => void;
  onLoadDemo: () => void;
  onLoadExample: (exampleId: string) => void;
  busy: boolean;
  error: string | null;
  /** "info" for "not traceable yet" notices, "error" for real errors such as compile failures. */
  errorTone?: "error" | "info";
  /** Full compiler diagnostic, shown preformatted under the message. */
  errorDetails?: string | null;
  /** The real tracer (local preview) is active; changes wording only. */
  realTracing?: boolean;
}

export function EditMode(p: Props) {
  return (
    <div className="edit-mode">
      <div className="edit-toolbar">
        <div className="edit-settings">
          Write code in{" "}
          <select aria-label="Language" defaultValue="gleam">
            <option value="gleam">{p.realTracing ? "Gleam (real tracing preview)" : "Gleam (Demo trace only)"}</option>
          </select>{" "}
          and{" "}
          <select
            aria-label="Exited frames"
            value={p.showExitedFrames ? "show" : "hide"}
            onChange={(e) => p.onShowExitedFramesChange(e.target.value === "show")}
          >
            <option value="show">display frames of exited functions.</option>
            <option value="hide">hide frames of exited functions.</option>
          </select>
        </div>
        <ExamplePicker source={p.source} onPick={p.onLoadExample} />
      </div>
      <CodeEditor value={p.source} onChange={p.onSourceChange} />
      <div className="visualize-row">
        <button type="button" className="visualize-button" onClick={p.onVisualize} disabled={p.busy}>
          Visualize Execution
        </button>
      </div>
      {p.error && (
        <div className={p.errorTone === "info" ? "edit-error edit-notice" : "edit-error"} role="alert">
          {p.error}
          {p.errorDetails && <pre className="edit-error-details">{p.errorDetails}</pre>}
        </div>
      )}
      <div className="example-links">
        Example with a Demo trace:{" "}
        <a
          href="#demo"
          onClick={(e) => {
            e.preventDefault();
            p.onLoadDemo();
          }}
        >
          square(5)
        </a>
      </div>
    </div>
  );
}
