import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { DEMO_SOURCE } from "./trace/demoTrace";

// jsdom has no layout; arrow geometry is checked in the browser, structure here.
async function openVisualizer() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Visualize Execution" }));
  return user;
}

const counter = () => document.querySelector(".step-counter")!.textContent;
const arrowLine = (kind: "next" | "just") => document.querySelector(`tr[data-arrow="${kind}"]`)?.getAttribute("data-line") ?? null;
const frame = (id: string) => document.querySelector<HTMLElement>(`[data-frame-id="${id}"]`);
const binding = (frameId: string, name: string) =>
  frame(frameId)?.querySelector(`[data-binding="${name}"] .frame-var-value`)?.textContent ?? null;

describe("Edit Mode", () => {
  it("shows the editor and button only, no diagram or controls", () => {
    render(<App />);
    expect(screen.getByText("Gleam Tutor")).toBeInTheDocument();
    expect(screen.getByLabelText("Gleam source code")).toHaveValue(DEMO_SOURCE);
    expect(screen.getByRole("button", { name: "Visualize Execution" })).toBeInTheDocument();
    expect(screen.queryByText("Frames")).toBeNull();
    expect(screen.queryByText("Objects")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next >" })).toBeNull();
    expect(screen.queryByText(/Step \d+ of/)).toBeNull();
  });
});

describe("Edit -> Visualize -> Edit", () => {
  it("switches screens, labels the Demo trace, and preserves source", async () => {
    const user = await openVisualizer();
    expect(screen.queryByLabelText("Gleam source code")).toBeNull(); // editor not shown simultaneously
    expect(screen.getByText(/Demo trace/)).toBeInTheDocument();
    expect(screen.getByText("Frames")).toBeInTheDocument();
    expect(screen.getByText("Objects")).toBeInTheDocument();
    expect(screen.getByLabelText("Print output")).toHaveValue("");
    expect(counter()).toBe("Step 1 of 9");

    await user.click(screen.getByText("Edit this code"));
    expect(screen.getByLabelText("Gleam source code")).toHaveValue(DEMO_SOURCE);
  });

  it("restarts at step 1 on each new visualization", async () => {
    const user = await openVisualizer();
    await user.click(screen.getByRole("button", { name: "Last >>" }));
    await user.click(screen.getByText("Edit this code"));
    await user.click(screen.getByRole("button", { name: "Visualize Execution" }));
    expect(counter()).toBe("Step 1 of 9");
  });
});

describe("playback controls", () => {
  it("First/Prev/Next/Last update every pane from the same step", async () => {
    const user = await openVisualizer();
    const btn = (name: string) => screen.getByRole("button", { name });

    // Step 1: entering main
    expect(btn("<< First")).toBeDisabled();
    expect(btn("< Prev")).toBeDisabled();
    expect(arrowLine("next")).toBe("6");
    expect(arrowLine("just")).toBeNull();
    expect(frame("frame-main-1")).not.toBeNull();
    expect(binding("frame-main-1", "a")).toBeNull();
    expect(frame("frame-square-2")).toBeNull();

    await user.click(btn("Next >")); // step 2: a = 5
    expect(counter()).toBe("Step 2 of 9");
    expect(binding("frame-main-1", "a")).toBe("5");
    expect(arrowLine("just")).toBe("6");
    expect(arrowLine("next")).toBe("7");

    await user.click(btn("Next >"));
    await user.click(btn("Next >")); // step 4: square entered
    expect(binding("frame-square-2", "x")).toBe("5");
    expect(frame("frame-square-2")).toHaveClass("frame-current");
    expect(binding("frame-square-2", "__return")).toBeNull();

    await user.click(btn("Next >"));
    await user.click(btn("Next >")); // step 6: square returned
    expect(binding("frame-square-2", "__return")).toBe("25");
    expect(frame("frame-square-2")).toHaveClass("frame-exited");
    expect(frame("frame-main-1")).toHaveClass("frame-current");

    await user.click(btn("< Prev")); // backward: step 5
    expect(counter()).toBe("Step 5 of 9");
    expect(binding("frame-square-2", "__return")).toBeNull();
    expect(frame("frame-square-2")).not.toHaveClass("frame-exited");

    await user.click(btn("Last >>")); // step 9
    expect(counter()).toBe("Step 9 of 9");
    expect(btn("Next >")).toBeDisabled();
    expect(btn("Last >>")).toBeDisabled();
    expect(binding("frame-main-1", "b")).toBe("25");
    expect(binding("frame-main-1", "__return")).toBe("25");
    expect(arrowLine("next")).toBeNull();
    expect(arrowLine("just")).toBe("9");
    expect(screen.getByLabelText("Print output")).toHaveValue("");

    await user.click(btn("<< First"));
    expect(counter()).toBe("Step 1 of 9");
    expect(frame("frame-square-2")).toBeNull();
  });

  it("slider seeks to any step in either direction", async () => {
    await openVisualizer();
    const slider = screen.getByLabelText("Execution step");
    fireEvent.change(slider, { target: { value: "6" } });
    expect(counter()).toBe("Step 7 of 9");
    expect(binding("frame-main-1", "b")).toBe("25");
    fireEvent.change(slider, { target: { value: "1" } });
    expect(counter()).toBe("Step 2 of 9");
    expect(binding("frame-main-1", "b")).toBeNull();
  });

  it("shows module functions as objects referenced from the module frame", async () => {
    await openVisualizer();
    const objects = document.querySelector(".objects-column")!;
    expect(within(objects as HTMLElement).getByText("fn square(x: Int) -> Int")).toBeInTheDocument();
    expect(document.querySelector('[data-ref-src="module-main:square"]')).toHaveAttribute("data-ref-target", "fn-square");
  });
});

describe("exited frames option", () => {
  it("hides exited frames when selected", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.selectOptions(screen.getByLabelText("Exited frames"), "hide");
    await user.click(screen.getByRole("button", { name: "Visualize Execution" }));
    await user.click(screen.getByRole("button", { name: "Last >>" }));
    expect(frame("frame-square-2")).toBeNull();
    expect(frame("frame-main-1")).toBeNull();
    expect(frame("module-main")).not.toBeNull();
  });
});

describe("edited source never shows the Demo trace", () => {
  it.each([
    ["a changed value", (s: string) => s.replace("let a = 5", "let a = 7")],
    ["an added line", (s: string) => s + "// note\n"],
    ["everything deleted", () => ""],
  ])("with %s, stays in Edit Mode with an unsupported message", async (_, edit) => {
    const user = userEvent.setup();
    render(<App />);
    const editor = screen.getByLabelText("Gleam source code");
    fireEvent.change(editor, { target: { value: edit(DEMO_SOURCE) } });
    await user.click(screen.getByRole("button", { name: "Visualize Execution" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot trace this program yet/);
    expect(screen.queryByText("Frames")).toBeNull();
    expect(screen.queryByText(/Step \d+ of/)).toBeNull();
    expect(screen.getByLabelText("Gleam source code")).toHaveValue(edit(DEMO_SOURCE));
  });

  it("edit after visualizing, then re-run: no stale trace", async () => {
    const user = await openVisualizer();
    await user.click(screen.getByText("Edit this code"));
    fireEvent.change(screen.getByLabelText("Gleam source code"), { target: { value: DEMO_SOURCE.replace("5", "6") } });
    await user.click(screen.getByRole("button", { name: "Visualize Execution" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Demo trace \(/)).toBeNull();
  });

  it("restoring the exact demo example via the example link works again", async () => {
    const user = userEvent.setup();
    render(<App initialSource="pub fn main() { 1 }" />);
    await user.click(screen.getByRole("button", { name: "Visualize Execution" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByText("square(5)"));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Visualize Execution" }));
    expect(counter()).toBe("Step 1 of 9");
  });
});
