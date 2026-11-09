import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { GT_EXAMPLES } from "../../examples.js";
import { DEMO_SOURCE } from "../trace/demoTrace";

const picker = () => screen.getByLabelText("Example programs") as HTMLSelectElement;
const editor = () => screen.getByLabelText("Gleam source code") as HTMLTextAreaElement;
const visualizeButton = () => screen.getByRole("button", { name: "Visualize Execution" });
const inEditModeOnly = () => {
  expect(editor()).toBeInTheDocument();
  expect(screen.queryByText("Frames")).toBeNull();
  expect(screen.queryByText("Objects")).toBeNull();
  expect(screen.queryByText(/Step \d+ of/)).toBeNull();
};

afterEach(() => vi.restoreAllMocks());

describe("example dropdown", () => {
  it("is a native select with a placeholder and the library's optgroups in order", () => {
    render(<App />);
    expect(picker().tagName).toBe("SELECT");
    expect(picker().value).toBe(""); // demo source is not a library example
    expect(within(picker()).getByRole("option", { name: "Choose an example..." })).toBeInTheDocument();

    const groups = [...picker().querySelectorAll("optgroup")];
    const expectedGroups = [...new Set(GT_EXAMPLES.map((e) => e.group))];
    expect(groups.map((g) => g.label)).toEqual(expectedGroups);
    for (const g of groups) {
      const titles = [...g.querySelectorAll("option")].map((o) => o.textContent);
      expect(titles).toEqual(GT_EXAMPLES.filter((e) => e.group === g.label).map((e) => e.title));
    }
  });

  it("loads every example's exact source without running it", async () => {
    const user = userEvent.setup();
    render(<App />);
    for (const ex of GT_EXAMPLES) {
      await user.selectOptions(picker(), ex.id);
      expect(editor().value).toBe(ex.code);
      expect(picker().value).toBe(ex.id);
      inEditModeOnly();
      expect(screen.queryByRole("alert")).toBeNull();
    }
  });

  it("leaves the loaded code editable and resets to the placeholder after an edit", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.selectOptions(picker(), "recursion");
    await user.click(editor());
    await user.keyboard("{Control>}{End}{/Control}// my note");
    expect(editor().value).toContain("// my note");
    expect(editor().value.startsWith(GT_EXAMPLES.find((e) => e.id === "recursion")!.code.slice(0, 20))).toBe(true);
    expect(picker().value).toBe("");
  });

  it("switches between examples, replacing the editor contents", async () => {
    const user = userEvent.setup();
    render(<App />);
    const [a, b] = [GT_EXAMPLES[0], GT_EXAMPLES[5]];
    await user.selectOptions(picker(), a.id);
    await user.selectOptions(picker(), b.id);
    expect(editor().value).toBe(b.code);
    expect(picker().value).toBe(b.id);
  });

  it("asks before replacing the student's own code, and keeps it if cancelled", async () => {
    const user = userEvent.setup();
    render(<App />);
    fireEvent.change(editor(), { target: { value: "pub fn main() { 42 }" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.selectOptions(picker(), "hello");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(editor().value).toBe("pub fn main() { 42 }");
    expect(picker().value).toBe("");

    confirm.mockReturnValue(true);
    await user.selectOptions(picker(), "hello");
    expect(editor().value).toBe(GT_EXAMPLES[0].code);
  });

  it("does not ask when the editor holds the demo or an unmodified example", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm");
    render(<App />);
    await user.selectOptions(picker(), "hello");
    await user.selectOptions(picker(), "tuples");
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("visualizing library examples", () => {
  it.each(GT_EXAMPLES.map((e) => [e.id, e.title]))(
    "%s shows a friendly not-yet-available notice and no trace",
    async (id, title) => {
      const user = userEvent.setup();
      render(<App />);
      await user.selectOptions(picker(), id);
      await user.click(visualizeButton());
      const notice = screen.getByRole("alert");
      expect(notice).toHaveTextContent(`tracing for the "${title}" example isn't available yet`);
      expect(notice).toHaveTextContent("square(5) Demo trace");
      expect(notice).toHaveClass("edit-notice");
      inEditModeOnly();
      expect(screen.queryByText(/Demo trace \(predefined/)).toBeNull();
    },
  );

  it("an edited example gets the general unsupported message", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.selectOptions(picker(), "hello");
    fireEvent.change(editor(), { target: { value: editor().value + "\n// edited" } });
    await user.click(visualizeButton());
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot trace this program yet/);
    inEditModeOnly();
  });

  it("the square(5) demo still visualizes after browsing examples", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.selectOptions(picker(), "list-recursion");
    await user.click(visualizeButton());
    await user.click(screen.getByText("square(5)"));
    expect(editor().value).toBe(DEMO_SOURCE);
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(visualizeButton());
    expect(screen.getByText(/Demo trace \(predefined/)).toBeInTheDocument();
    expect(document.querySelector(".step-counter")!.textContent).toBe("Step 1 of 9");
    await user.click(screen.getByRole("button", { name: "Last >>" }));
    expect(document.querySelector(".step-counter")!.textContent).toBe("Step 9 of 9");
    await user.click(screen.getByText("Edit this code"));
    expect(editor().value).toBe(DEMO_SOURCE);
  });
});
