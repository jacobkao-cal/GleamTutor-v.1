/** Print Output, String and Nil values in the visualizer (Phase 2D). */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { DEMO_TRACE } from "./trace/demoTrace";
import type { ExecutionTrace } from "./trace/types";

// The demo trace's shape, with output and String/Nil values added per step, as a real tracer produces them.
const outputs = ["", "", "", "Hello\n", "Hello\n", "Hello\nWorld\n", "Hello\nWorld\n"];
const TRACE: ExecutionTrace = {
  ...DEMO_TRACE,
  traceKind: "real",
  steps: DEMO_TRACE.steps.slice(0, outputs.length).map((s, i, all) => ({
    ...s,
    stdout: outputs[i],
    nextToExecute: i === all.length - 1 ? null : s.nextToExecute,
    frames: s.frames.map((f) =>
      f.status === "module" ? f : { ...f, bindings: [...f.bindings, { name: "greeting", value: { kind: "string" as const, value: 'say "hi"\n' } }, { name: "nothing", value: { kind: "nil" as const } }] },
    ),
  })),
};

async function open() {
  const user = userEvent.setup();
  render(<App tracer={{ trace: async () => ({ status: "ok", trace: TRACE }) }} realTracing />);
  await user.click(screen.getByRole("button", { name: "Visualize Execution" }));
  return user;
}
const output = () => (screen.getByLabelText("Print output") as HTMLTextAreaElement).value;

describe("Print Output follows playback", () => {
  it("shows only output printed up to the current step, backward and forward, without duplicates", async () => {
    const user = await open();
    const next = () => user.click(screen.getByRole("button", { name: "Next >" }));
    const prev = () => user.click(screen.getByRole("button", { name: "< Prev" }));
    const seen: string[] = [output()];
    for (let i = 1; i < outputs.length; i++) {
      await next();
      seen.push(output());
    }
    expect(seen).toEqual(outputs);
    await prev();
    await prev();
    expect(output()).toBe("Hello\n"); // output not yet produced at this step is gone
    await next();
    await next();
    expect(output()).toBe("Hello\nWorld\n"); // and comes back exactly once
    await user.click(screen.getByRole("button", { name: "<< First" }));
    await user.click(screen.getByRole("button", { name: "Last >>" }));
    expect(output()).toBe("Hello\nWorld\n");
  });

  it("String values are shown as Gleam literals and Nil as Nil", async () => {
    await open();
    const greeting = document.querySelector('[data-binding="greeting"] .value-string');
    expect(greeting?.textContent).toBe('"say \\"hi\\"\\n"');
    expect(document.querySelector('[data-binding="nothing"] .frame-var-value')?.textContent).toBe("Nil");
  });
});
