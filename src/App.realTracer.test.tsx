/** How the app presents each TraceResult status from a real tracer (Phase 2B). */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { DEMO_SOURCE, DEMO_TRACE } from "./trace/demoTrace";
import type { Tracer, TraceResult } from "./trace/tracer";

const stub = (result: TraceResult): Tracer => ({ trace: async () => result });

async function visualizeWith(result: TraceResult) {
  const user = userEvent.setup();
  render(<App tracer={stub(result)} realTracing />);
  await user.click(screen.getByRole("button", { name: "Visualize Execution" }));
}

describe("real tracer results in the app", () => {
  it("labels the language select for the real tracing preview", () => {
    render(<App tracer={stub({ status: "timeout", message: "x" })} realTracing />);
    expect(screen.getByRole("option", { name: "Gleam (real tracing preview)" })).toBeInTheDocument();
  });

  it("an ok real trace opens the visualizer as a Live trace, not a Demo trace", async () => {
    await visualizeWith({ status: "ok", trace: { ...DEMO_TRACE, traceKind: "real" } });
    expect(screen.getByText("Live trace")).toBeInTheDocument();
    expect(screen.queryByText(/Demo trace \(predefined/)).toBeNull();
  });

  it("compile errors show the message, location and the compiler's full diagnostic", async () => {
    await visualizeWith({
      status: "compile_error",
      message: "The Gleam compiler found a problem: Syntax error",
      location: { line: 2, column: 13 },
      details: "error: Syntax error\n  ┌─ /src/main.gleam:2:13",
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The Gleam compiler found a problem: Syntax error (line 2, column 13)");
    expect(alert.querySelector("pre")).toHaveTextContent("/src/main.gleam:2:13");
  });

  it("unsupported features are an info notice with their location", async () => {
    await visualizeWith({ status: "unsupported", feature: "case expressions", message: "Step-by-step tracing doesn't support case expressions yet.", location: { line: 3, column: 3 } });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("edit-notice");
    expect(alert).toHaveTextContent("doesn't support case expressions yet. (line 3, column 3)");
  });

  it("limits and timeouts are errors and stay in Edit Mode", async () => {
    await visualizeWith({ status: "limit", message: "The run was stopped: Call depth exceeded 500." });
    expect(screen.getByRole("alert")).toHaveTextContent("Call depth exceeded 500");
    expect(screen.getByLabelText("Gleam source code")).toHaveValue(DEMO_SOURCE);
  });

  it("a runtime error with a partial trace is visualized, its last step showing the error", async () => {
    const steps = DEMO_TRACE.steps.slice(0, 2).map((s, i, all) => ({
      ...s,
      nextToExecute: i === all.length - 1 ? null : s.nextToExecute,
      error: i === all.length - 1 ? { kind: "runtime" as const, message: "RangeError: boom" } : null,
    }));
    const user = userEvent.setup();
    render(<App tracer={stub({ status: "runtime_error", message: "crashed", trace: { ...DEMO_TRACE, traceKind: "real", steps } })} realTracing />);
    await user.click(screen.getByRole("button", { name: "Visualize Execution" }));
    await user.click(screen.getByRole("button", { name: "Last >>" }));
    expect(screen.getByText("RangeError: boom")).toBeInTheDocument();
  });
});
