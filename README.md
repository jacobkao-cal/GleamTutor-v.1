# Gleam Tutor

**A Python Tutor-style execution visualizer for Gleam, designed for students learning functional programming in UC Berkeley CS 61A.**

> **Project status: Phase 2C.** Edited Gleam code is compiled by the official Gleam compiler and run for real **in the browser**, inside a sandboxed iframe, for a small subset: Int, Bool, `let`, arithmetic and comparisons, and calls including recursion. Anything else gets a clear "not supported yet" message with its location. The exact GT-01 `square(5)` example keeps its predefined, clearly labelled **Demo trace**.

## The idea

Gleam Tutor lets students write a small Gleam program in a browser, select **Visualize Execution**, and then step **forward or backward** through a recorded execution. The visualizer shows source-code execution arrows, function frames, local bindings, return values, print output, and representations of Gleam data structures.

**Our design target is the existing Python Tutor experience—not a redesigned IDE or dashboard.** We intend to keep Python Tutor's two-stage Edit → Visualize → Edit flow and its sparse left-code/right-environment layout, while replacing Python execution semantics with Gleam semantics. The Gleam star is the visual identity.

### User workflow

```text
Edit Mode
  Enter or modify Gleam code
  Click "Visualize Execution"
        |
        v
Compilation + execution + trace collection (engine to be built)
        |
        v
Visualization Mode
  Source code on left; Print Output, Frames, Objects on right
  Red arrow = next source location; green arrow = just executed
  First | Prev | timeline slider | Next | Last
  Inspect bindings, calls, returns, and data structures
        |
        v
Click "Edit this code" → Edit Mode
```

The first front-end prototype **may** use a visibly labeled predefined execution trace to validate the controls and layout. A fixture is **not** the actual execution of edited user code. Supporting real user-written programs requires a separately validated tracing engine.

## Design references

| Asset | Location | Purpose |
| --- | --- | --- |
| Star logo | `public/gleam-star.png` | Use as the site's logo |
| Original Edit Mode | `references/python-tutor/edit-mode.png` | Match editor and execution button layout |
| Original Visualization Mode (initial state) | `references/python-tutor/visualization-initial.png` | Match left-code/right-output and stepping controls |
| Original Visualization Mode (frames visible) | `references/python-tutor/visualization-frames.png` | Match frames, objects, arrows, and exited-frame appearance |

**Do not substitute earlier AI-generated UI mockups for these reference screenshots.** The screenshots supplied for this project are the product's visual source of truth.

## Core capabilities (target)

- **Two modes:** Edit Mode and Visualization Mode are separate screens; no execution diagram in Edit Mode.
- **Python Tutor-style playback:** First, Prev, slider, Next, Last, step counter; seek in either direction without re-executing the program.
- **Environment diagrams:** Function call frames, parameters, local bindings, return values, closures where supported, linked-list and tuple values, custom-type representations.
- **Gleam-specific behavior:** Immutable values, binding shadowing, `case`/pattern bindings, structural data, recursion, and logical call frames for tail-recursive calls.
- **Accurate diagnostics:** Compile errors shown as errors; unsupported programs marked as unsupported, never silently visualized using a made-up trace.
- **Accessible entry:** No account required for the initial prototype.

## What makes Gleam different?

Gleam is a statically typed functional language with expression-based functions, immutable values, pattern matching, and immutable singly linked lists. The environment diagram is an **educational model of Gleam's semantics**; it need not pretend to be the literal heap or call stack of the JavaScript runtime that executes compiled Gleam.

Important rules:

1. A later `let x = ...` can reuse a name without modifying the earlier value.
2. A function returns the value of its last expression; Gleam does not use Python's `return` statement.
3. Calling `main()` does not print its return value by default; print output only shows actual output (e.g., `gleam/io.println` or supported `echo` behavior).
4. For `case list { [] -> ...; [first, ..rest] -> ... }`, bindings from the selected pattern should appear in the appropriate logical scope.
5. Recursion and tail recursion may be shown with logical educational frames; label this clearly when it does not match optimized physical runtime frames.

See **[PROJECT_SPEC.md](PROJECT_SPEC.md)** for all requirements and acceptance tests.

## Technical direction (to validate; not yet implemented)

- **UI:** React + TypeScript + Vite, using ordinary DOM/SVG for the faithful Python Tutor-style visualization.
- **Editor:** A code editor with Gleam syntax highlighting and line numbers (e.g., Monaco, if it fits the visual reference).
- **Compilation:** Investigate the official Gleam WASM compiler approach used by the Gleam Playground.
- **Execution:** Investigate the official Gleam JavaScript target inside a constrained, disposable Web Worker.
- **Tracing:** Evaluate source/AST instrumentation, generated-JS instrumentation, and a deliberately limited interpreter before choosing.
- **Trace format:** A versioned, deterministic JSON representation independent of UI components.
- **Hosting:** Aim for a static frontend when feasible; server execution is not a prerequisite for the planning stage.

**A Web Worker is not, by itself, a complete security sandbox.** Execution restrictions, resource limits, imports, and abuse resistance require separate design.

## Initial milestones

| Milestone | Outcome | Status |
| --- | --- | --- |
| M0 — Product spec and references | Confirm scope, screenshot fidelity, Gleam semantics | Done |
| M1 — UI and trace playback | Two screens and fully working navigation over a clearly labeled trace fixture | Prototype done (fixture only) |
| M2 — Real tracing feasibility | Produce real source-mapped call/binding/return events for a tiny Gleam example | Done for a small subset (Int, Bool, `let`, calls, recursion), running in the browser sandbox ([report](docs/PHASE_2_ARCHITECTURE.md), [engine](tracer-node/README.md)) |
| M3 — Supported core language | Add recursion, lists, pattern matching with semantic tests | Not started |
| M4 — Validation and release | Expand coverage, test edge cases, evaluate safe deployment | Not started |

### First tracing test (not yet supported)

```gleam
pub fn square(x: Int) -> Int {
  x * x
}

pub fn main() {
  let a = 5
  let b = square(a)
  b
}
```

The program's `main` evaluates to `25`, but **Print Output should remain empty** unless the program actually prints. The trace should show the `main` call, binding `a`, calling `square(5)`, its `x = 5` frame, returning `25`, binding `b`, and returning `25` from `main`.

## How to use these starter files

1. Copy `README.md`, `PROJECT_SPEC.md`, `public/`, and `references/` into your local `~/Desktop/Gleam Tutor/` folder.
2. In VS Code, open that folder and read `PROJECT_SPEC.md` before installing a framework or generating components.
3. Keep the original reference screenshots in the repository so contributors and coding agents can compare the UI directly.
4. Build in small phases, review each result, and track completed acceptance criteria in `PROJECT_SPEC.md`.

## Running locally (Phase 1)

Tested with Node 24.22.0 / npm 11.19.1, Vite 5.4.10, React 18.3.1, TypeScript 5.6.3, Vitest 2.1.4, on macOS + Chrome.

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit + component tests (Vitest, jsdom)
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build
```

Real tracing needs the pinned compiler: run `npm run tracer:setup` once before `npm run dev` or `npm run build`. `npm run tracer:test` runs the engine tests, and `npm run build && npm run e2e` runs the real-browser tests (needs Google Chrome). See [tracer-node/README.md](tracer-node/README.md).

### Source layout

| Path | Responsibility |
| --- | --- |
| `src/trace/types.ts` | Versioned trace schema (UI-independent) |
| `src/trace/demoTrace.ts` | The GT-01 **Demo trace** fixture and its exact source |
| `src/trace/tracer.ts` | `Tracer` interface, `TraceResult` statuses, `demoTracer`, `withDemoFixture` |
| `src/tracer/` | Phase 2B real tracing engine (pure; the runtime is injected) |
| `src/trace/validate.ts`, `source.ts` | Trace validation; source hashing that ties a trace to exact code |
| `src/playback/playback.ts` | Step index controller (First/Prev/Next/Last/seek) |
| `src/editor/` | Edit Mode code editor and display-only Gleam highlighter |
| `src/components/SourceDisplay.tsx` | Read-only source with green/red arrows |
| `src/components/PlaybackControls.tsx` | Slider, buttons, step counter |
| `src/components/EnvironmentDiagram.tsx` | Frames + Objects + pointer arrows |
| `src/components/EditMode.tsx`, `VisualizeMode.tsx`, `src/App.tsx` | The two screens and the mode switch |

### Visual design (branch `gleam-style`)

The `gleam-style` branch keeps the Python Tutor structure and behaviour unchanged (two separate screens; code, arrows and controls on the left; Print output, Frames and Objects side by side on the right) and applies the Gleam Playground's visual identity. The unstyled Python Tutor look is preserved on the `classic-ui` branch.

- **Theme tokens** live at the top of `src/styles.css` as CSS variables. They use the official Gleam colours: pink `#FFAFF3`, white `#FEFEFC`, navy `#292D3E`, blue `#A6F0FC`, aubergine `#584355`, menthol `#C8FFA7`, red `#FF6262`.
- **Fonts and code colours** follow the Playground: Outfit for text, Lexend for titles (loaded from Google Fonts; only font files are requested), the SFMono/Consolas/Menlo stack for code, and Atom One Light syntax colours.
- **Header:** a compact pink bar with the star logo.
- **Layout:** content is centred with a 1260px maximum width.
- **Frames:** the current frame is light pink, other frames have a soft pink border, and exited frames are faded and dashed.
- **Objects and arrows:** function objects are soft-blue boxes, and pointer arrows are navy.
- **Source arrows:** the just-executed line gets a green arrow with a menthol row tint, and the next line a red arrow with a light red tint. The exact expression is still underlined in the matching colour.
- **Demo trace badge:** "Demo trace (predefined, not a live execution)" is shown as a yellow badge.
- **Narrow screens:** below 920px the visualizer stacks into code and controls, then output and diagram, keeping the same order. A diagram wider than the screen scrolls inside its panel and is never clipped.

### Example library (Phase 1.5)

The **Choose an example...** dropdown in Edit Mode lists the examples in `examples.js`, grouped by category with `<optgroup>`. That file is the only copy of the examples; the app imports it, with types from `examples.d.ts`, through `src/examples/library.ts`.

- Picking an example only loads its code into the editor, where it stays fully editable. Nothing is run or visualized automatically.
- The dropdown shows an example's name only while the editor text matches that example exactly. After any edit it shows the placeholder again.
- If the editor holds the student's own code, the app asks before replacing it.
- **None of the library examples has a trace.** Clicking Visualize Execution on one shows a friendly "tracing isn't available yet" notice. Only the `square(5)` example, loaded from the link under the editor, has the Demo trace.
- All 21 examples compile with Gleam 1.19.2 (`gleam_stdlib` 1.0.5) and run on the JavaScript target. `let assert` crashes on purpose.

### Demo trace conventions

- Green arrow = the location whose evaluation produced the current snapshot; red arrow = the next location to evaluate. The exact expression is underlined in the arrow's colour, so several events on one line stay distinct.
- A `return` step points at the function's closing `}`: the function has produced the value of its last expression and its frame becomes exited.
- `module main` lists module-level function definitions. It is not a mutable globals dictionary.
- Frames are logical evaluation frames for teaching, not the JavaScript runtime stack.

## Sources and acknowledgments

- [OnlinePythonTutor historical source](https://github.com/hcientist/OnlinePythonTutor) — original trace-and-replay and environment diagram design
- [Python Tutor](https://pythontutor.com/) — reference user experience
- [Gleam Language Tour](https://tour.gleam.run/everything/) — language semantics and examples
- [Gleam Playground](https://playground.gleam.run/) and [its source](https://github.com/gleam-lang/playground) — reference compiler-in-browser design
- [Gleam documentation](https://gleam.run/documentation/) — compiler and language reference

The historical OnlinePythonTutor source carries GPL-3.0-or-later notices. Before incorporating its code, verify the applicable license obligations and the scope of any additional permission. The screenshots are design references and should be attributed appropriately; reproduction of original source is not automatically authorized for unrestricted licensing.
