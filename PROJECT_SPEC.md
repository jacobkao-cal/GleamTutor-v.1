# Gleam Tutor — Product and Engineering Specification

**Version:** 0.1 — pre-implementation  
**Audience:** Project contributors, AI coding agents, CS 61A teaching staff  
**Project status:** Requirements and technical exploration; no production execution tracer yet  
**Source of truth for UI:** `references/python-tutor/*.png`, supplied by the project owner

---

## 1. Mission

Build **Gleam Tutor**, a browser-based execution visualizer for Gleam. Its purpose is to help CS 61A students understand *how a program evaluates*, rather than only see its final output.

**Primary product requirement:** The interface and interaction flow should work as closely as practicable to **Python Tutor**, with the Gleam star logo and Gleam source-language semantics. This is *not* a request for a modern dashboard, a new Playground design, a split IDE, or an exam grading application.

**Non-negotiable distinction:** The appearance, playback behavior, and user workflow are adapted from Python Tutor; **Gleam's environment semantics must be implemented accurately, not copied from Python**.

### 1.1 Who uses it

- Students learning Gleam fundamentals in UC Berkeley CS 61A.
- TAs explaining recursion, functions, lists, pattern matching, and functional evaluation.
- Students debugging short, self-contained Gleam examples in a browser.

### 1.2 Success measures

1. A new student can paste a supported Gleam snippet and understand the Edit → Visualize → Edit workflow without instruction.
2. A supported snippet produces a **real, source-mapped execution trace**, not a fixture or an extrapolation from final output.
3. All stepping controls and visual representations agree with the trace at every step.
4. Semantic outputs and compiler errors agree with a tested version of the official Gleam toolchain for supported programs.
5. The interface stays visually faithful to the supplied Python Tutor screenshots.

---

## 2. Canonical References and Reading Order

### UI / trace design

1. `references/python-tutor/edit-mode.png`
2. `references/python-tutor/visualization-initial.png`
3. `references/python-tutor/visualization-frames.png`
4. https://github.com/hcientist/OnlinePythonTutor — historical original
   - `tutor.html` — two-screen HTML and layout
   - `edu-python-tutor.js` — Edit/Visualize transitions and execution request
   - `edu-python.js` — playback state, arrows, Frames/Objects renderer
   - `cgi-bin/pg_logger.py` — instruction and function event capture
   - `cgi-bin/pg_encoder.py` — object serialization and identity
   - `cgi-bin/web_exec.py` — execution endpoint

**Key architectural insight:** Python Tutor runs the program, collects a *sequence of trace snapshots*, then lets the browser move forward and backward over that record. Backward playback does not mean actually undoing program execution.

### Gleam language and toolchain

- https://tour.gleam.run/table-of-contents/
- https://tour.gleam.run/everything/
- https://gleam.run/documentation/
- https://playground.gleam.run/
- https://github.com/gleam-lang/playground
  - `static/compiler.js` — WASM compiler wrapper
  - `static/worker.js` — browser Worker compilation/execution and console output

The official Playground **compiles Gleam to JavaScript and runs it in a Worker**, but it does **not** automatically supply a Python Tutor-style source-level execution trace. Generating that trace is the project's primary technical challenge.

---

## 3. Explicit Product Decisions (do not re-decide silently)

| Decision | Required behavior |
| --- | --- |
| User flow | **Edit Mode → Visualize Execution → Visualization Mode → Edit this code** |
| Screen design | Edit and Visualize are **separate screens**, not simultaneously visible panes |
| Layout | Closely follow original Python Tutor screenshots |
| Branding | Use `public/gleam-star.png` as logo; otherwise minimal design changes |
| Playback | First, Prev, slider, Next, Last; allow seeking both directions |
| Visualization | Source arrows on left; Print Output + Frames + Objects on right |
| Authentication | None for first prototype |
| Backend | Not required unless feasibility tests establish a need |
| Exercise library, quizzes, scoring | Not part of first prototype |
| Trace provenance | Fixture traces must be labeled **Demo trace**; never claim arbitrary code works without genuine tracing |
| Scope management | Implement and test one milestone at a time; no unsolicited product redesign |

A reference implementation that changes the UI to a dashboard, adds unrelated cards or large new teaching panels, or displays editable code and the execution diagram at the same time **does not satisfy this spec**.

---

## 4. UI Specification — Match Python Tutor

### 4.1 Edit Mode

Reference: `references/python-tutor/edit-mode.png`

- Small, unobtrusive header or title with the Gleam star and **Gleam Tutor**.
- Large plain code input surface with monospaced font and line numbers.
- Gleam syntax highlighting is desirable, but should not change the familiar proportions, spacing, or restraint of the original layout.
- A single primary action labeled **Visualize Execution** below the editor.
- Optional simple display-settings selector only when behavior is defined (e.g., whether exited function frames remain visible).
- No Frames, Objects, step counters, timelines, or explanation cards in Edit Mode.
- Retain the user's current source text when switching between modes.

### 4.2 Visualization Mode

References: `references/python-tutor/visualization-initial.png` and `references/python-tutor/visualization-frames.png`.

**Left: Source / control column**

- Read-only source with matching line numbers.
- **Red arrow:** next source line/expression to evaluate, when applicable.
- **Green arrow:** source line/expression just evaluated, when applicable.
- Distinguish current action and previously executed action consistently, including when a single source line generates several events.
- Link/button labeled **Edit this code** to return to Edit Mode.
- Horizontal seek slider for the current trace.
- Buttons: **<< First**, **< Prev**, **Next >**, **Last >>**.
- Step counter, e.g., **Step 3 of 8**.
- Disable Prev/First at the beginning and Next/Last at the end.

**Right: Execution / environment column**

- **Print Output** text area at the top.
- **Frames** and **Objects** regions beneath; align with the reference layout rather than replacing them with a tabbed dashboard.
- Show module-level functions/constants in a sensible module environment or definition region *if useful*, but do not incorrectly claim that Gleam has Python's mutable `globals()` dictionary.
- Display a frame for each relevant user-function call, including function name, parameters, visible local bindings, and final return value when available.
- For exited frames, use the subdued/faded presentation shown in Python Tutor when the relevant display option is enabled.
- Show compound values in the Objects region, with arrows/links from bindings when this increases comprehension. Primitive values can appear inline.
- Maintain visual stability while stepping; avoid unnecessary box jumps.

**Error states**

- Compile failure: show the compiler error and source location; do not show a fabricated successful execution.
- Execution error/limit: show the error and the last valid trace state, if available.
- No trace: show an explicit empty or unsupported state, not fake Frames/Objects.

### 4.3 Interaction behavior

1. The student enters Gleam code in Edit Mode.
2. Student clicks **Visualize Execution**.
3. Code is compiled and executed, and the resulting trace becomes available (once real tracing exists).
4. The student steps through snapshot indices; all panes derive from the **same current index**.
5. Student clicks **Edit this code** to return with the text unchanged.
6. After editing and running again, the trace must be refreshed; previous trace snapshots must not be represented as the new program's results.
7. Browser keyboard navigation may be added later, but it must not interfere with typing in Edit Mode.

---

## 5. Gleam Semantic Model for Environment Diagrams

These are the rules the tracer and renderer must respect. Always verify questionable cases against the official Gleam compiler and current language documentation.

### 5.1 Functions, expressions, and scope

- Function bodies evaluate expressions and produce the value of the **last expression**; do not invent a Python `return` statement.
- Parameters belong to the function invocation's local scope.
- New `let` bindings appear only after their initializer has evaluated successfully.
- Blocks create scopes; do not leak block-local names outside their lifetime.
- Module-level function declarations and constants are not the same as Python's executable mutable global bindings.
- Recursive calls get distinct **logical call frames** with their own parameters and bindings.
- When physical runtime optimizations (e.g., tail-call optimization) remove or reuse stack frames, the UI may still show a **clearly documented logical evaluation history** for teaching. Never present it as a literal JavaScript/Erlang runtime stack.

### 5.2 Immutable data and name reuse

- Gleam values are immutable.
- A repeated name in `let x = ...` binds a new value/name occurrence; it does not mutate the old value. The UI should show the currently visible binding; if history is shown, distinguish the two bindings.
- `let a = [1, 2]` then `let b = [0, ..a]` preserves `a`.
- Visual references may illustrate immutable list-tail sharing conceptually, but must not assert actual object identity or memory layout unless the runtime/tracer genuinely provides that evidence.
- Equality in Gleam is structural for comparable values; it is not a Python-style object identity check.

### 5.3 Lists

- Gleam lists are immutable singly linked lists, not mutable Python arrays.
- Show `[]` as the empty list and `[first, ..rest]` as the head/tail decomposition.
- Make list construction and pattern deconstruction readable, with clear arrows to tail values.
- Do not invent `.append` mutation or indexed assignment behavior.

### 5.4 Pattern matching

- `case` selects a matching clause; bindings introduced by the selected pattern exist in the relevant branch scope.
- For `case s { [] -> 0; [first, ..rest] -> ... }` with `s = [1,2]`, display `first = 1` and `rest = [2]` when the second clause is selected.
- Support failed patterns, guards, multiple subjects, aliases, and alternative patterns incrementally; do not imply full support at the outset.
- Exhaustiveness/type errors are compile-time diagnostics, not ordinary execution branches.
- `let assert` is not interchangeable with `case`; verify its matching/failure behavior separately before support.

### 5.5 Function values and higher-order behavior

- Named and anonymous functions are values; closures may capture lexical bindings.
- Visualize function values and captures as meaningful conceptual objects, distinct from Python class instances.
- Higher-order functions, function capture syntax, and pipelines can introduce nested calls; preserve correct evaluation order and source locations.
- `use` desugars to a callback-based form; do not visualize source-level `use` incorrectly without confirming its semantics.

### 5.6 Types and other data

- Show tuples by position and custom types by constructor/fields, including records, as supported.
- Results (`Ok`/`Error`), options, and bit arrays are later expansions.
- Static types are useful labels, but compilation/type checking should not be represented as runtime variable changes.
- Preserve distinction between source values and JavaScript representation details.

### 5.7 Output and runtime differences

- Returning `25` from `main()` does **not** imply printed output `25`.
- Capture actual output produced by supported Gleam printing/debugging constructs, with explicit and testable handling of `gleam/io.println` and `echo`.
- Browser prototype targets Gleam's **JavaScript** backend; some behavior/performance may differ from Erlang/BEAM. State target and version in test reports.
- A source-level step is a pedagogical event, not necessarily one machine instruction or one generated JavaScript statement.

---

## 6. Architecture Contract — Trace and Replay

```text
User's Gleam source
    |
    v
Gleam compiler / diagnostics
    |
    v
Instrumented execution path (technical approach TBD)
    |
    v
Captured source-level events, bindings, and value snapshots
    |
    v
Versioned JSON execution trace
    |
    v
Python Tutor-style playback controller
    |
    v
Source arrows + stdout + Frames + Objects
```

### 6.1 Trace event principles

- **Deterministic replay:** stepping backward reads earlier snapshots; it should not reverse-run the language runtime.
- **One source of truth:** source arrows, printed output, frames, and objects all come from the current event/snapshot index.
- **Trace provenance:** include whether the trace is `fixture` or `real` and the original source/version identity. A fixture must never be displayed as a real trace for modified code.
- **Stable identities:** assign logical IDs to call frames and compound value nodes as needed to keep arrows stable across snapshots. IDs are tracer labels, not unverified physical addresses.
- **Memory limits:** cap trace steps, data depth, stdout length, and node count; report truncation.
- **Source fidelity:** store line/column/range for each traceable operation when available. Mark synthetic/non-source events clearly.
- **Evaluation consistency:** define precisely whether a step snapshot is before/after an expression, and test red/green arrow behavior accordingly.
- **Exited frames:** recorded as exited but optionally still viewable; no longer treated as active.

### 6.2 Proposed minimal trace schema (design, not finalized API)

```json
{
  "schemaVersion": 1,
  "traceKind": "fixture",
  "sourceHash": "<hash-of-source>",
  "target": "javascript",
  "steps": [
    {
      "index": 0,
      "event": "call",
      "source": { "file": "main.gleam", "line": 6, "column": 1 },
      "justExecuted": null,
      "nextToExecute": { "line": 7 },
      "stdout": "",
      "frames": [
        {
          "id": "frame-main-1",
          "functionName": "main",
          "parentId": null,
          "status": "active",
          "bindings": []
        }
      ],
      "objects": [],
      "error": null
    }
  ]
}
```

This JSON is an **illustrative contract**, not a claim that the trace engine exists or that every shown field has an implementation. Add typed value variants (primitive, list, tuple, record, function, reference) when implementing the renderer; validate each emitted snapshot against a TypeScript schema.

### 6.3 Tracer approaches to investigate

**A. Source / AST instrumentation**

- Rewrite or annotate language-level operations to record calls, bindings, branches, returns, and source positions.
- Advantage: semantic control close to original source.
- Risk: requires robust parsing/AST support and preservation of evaluation order, types, scopes, and tail calls.

**B. Generated JavaScript instrumentation**

- Compile with the official Gleam WASM compiler, then instrument generated JavaScript and map events back to source.
- Advantage: starts from a compiler-supported executable program.
- Risk: optimized/desugared code and name mangling may obscure Gleam concepts; source maps and intermediate expression tracing are hard.

**C. Limited educational interpreter**

- Implement a well-defined subset of Gleam semantics and emit trace events directly.
- Advantage: precise stepping over the supported subset.
- Risk: substantial semantic maintenance and possible disagreement with the official compiler.

**Decision gate:** Do a tiny verified feasibility experiment first. Do not silently pick an approach because it is easy to scaffold. Record which source events can be traced correctly, unsupported syntax, and mismatch risks.

### 6.4 Browser execution safety

- Run user code in a disposable Worker or stronger isolation mechanism after a security review.
- Enforce wall-clock/step limits, output limits, and memory guardrails where practical.
- Restrict imports and external bindings; assess network/global access and runaway execution.
- Terminate and re-create the Worker after a timeout; a Web Worker alone is not a trustworthy sandbox for hostile code.
- Do not log students' source by default or send it to third-party services without a deliberate privacy decision.

---

## 7. Implementation Milestones and Exit Criteria

### Phase 0 — Requirements and reference set (current)

Deliverables:
- `README.md`
- `PROJECT_SPEC.md`
- `public/gleam-star.png`
- `references/python-tutor/*.png`

Exit: all developers agree Python Tutor's two-mode flow and screenshots are the reference; language and trace limitations are documented.

### Phase 1 — UI reproduction with explicit fixture (no live Gleam tracer yet)

- Create the minimal web application and Edit / Visualize mode transitions.
- Match screenshot proportions, typography, left/right structure, buttons, and arrow legend as closely as practical.
- Build a deterministic step controller and diagram renderer using one **clearly labeled Demo trace**.
- Ensure the currently edited source cannot be mistaken for the fixture's source. If the source changes, invalidate the fixture or explicitly reset it to its matching code.
- Add tests for First/Prev/Next/Last/slider, bounds, exiting frames, and edits.

Exit: the UI is faithful and functional **for the identified fixture only**; no unsupported statement about arbitrary Gleam code.

### Phase 2 — Real tracing proof of concept

- Confirm official compiler/WASM integration and supported tool versions.
- Choose/validate instrumentation approach.
- Run one tiny example with real `call`, `bind`, and `return` events and accurate source locations.
- Feed real events into the Phase 1 renderer, replacing the fixture for that supported case.
- Compare traced result with the official Gleam execution output.

Exit: evidence that a modified, supported source program produces a **new real trace**, with test output recorded.

**Status: done (Phases 2A–2D).** Programs run in a browser sandbox, with the official compiler 1.19.2 and `gleam_stdlib` 1.0.5. Supported: Int, Bool, String and Nil values, `let`, shadowing, calls, `<>`, Print Output, and stdlib calls as atomic steps. See `docs/PHASE_2_ARCHITECTURE.md`.

### Phase 3 — CS 61A core semantics

- Recursive calls, nested frames, return propagation.
- `case`, pattern bindings, list deconstruction, immutable list construction.
- Binding reuse/shadowing and scoped blocks.
- Output, compile diagnostics, logical recursion history.
- Tests for step ordering and arrows after nested calls/returns.

Exit: golden programs pass both runtime-result and per-step semantic assertions.

**Status:**

| Sub-phase | Scope | State |
| --- | --- | --- |
| **3A** | Lists and pattern matching | **Implemented.** Covers list literals, `[]`, `[x, ..xs]`, `case` (incl. guards, several subjects and nested list patterns), pattern-bound variables and their scope, and immutable lists drawn as shared cells. |
| **3B** | Recursion and scope | **Implemented.** Nested frames and return values for recursion over lists. Self tail calls are shown as labelled **logical frames** ("tail call"), and only where the official compiler really compiled the function to a loop; mutual recursion is never labelled. Blocks `{ ... }` work anywhere, with their own scope, and shadowing inside a block ends with it. |
| **3C** | Imports and output | **Implemented.** All 19 `gleam_stdlib` 1.0.5 modules resolve. `gleam/io` output appears in Print Output. Stdlib calls are atomic steps; a call is traceable when its declared result type is Int, Bool, String, Nil, `List(...)` or a type variable (161 of 353 functions; the random ones are excluded). `gleam/list`, `gleam/int` and `gleam/string` results are verified against known Gleam values. Unqualified imports and `as` aliases work. Unknown modules, higher-order calls and non-displayable results are refused with a reason. |

Details are in `docs/PHASE_2_ARCHITECTURE.md` §14 (3A), §15 (3B) and §16 (3C).

### Phase 4 — Extended Gleam language

- Anonymous functions, closures, higher-order functions, pipelines.
- Tuples, custom types, records, `Result`, standard library calls.
- Clear feature-support table for syntax not yet traceable.

### Phase 5 — Reliability and distribution

- Performance and safety tests, source/trace-size limits, browser support.
- Accessibility review (contrast, keyboard controls, screen-reader labels).
- License/provenance review before importing Python Tutor or Gleam Playground source.
- Publish only after accurate, documented behavior has been verified.

---

## 8. Golden Test Programs (language and visualization verification)

Test both **correct program result** and **expected source-level events/frames**. If a program is outside current support, return a clear unsupported status.

### Golden test status (verified by `npm run tracer:test`)

| Test | State |
| --- | --- |
| GT-01 | Passes. The real trace ends in the same state as the Demo trace. |
| GT-02 | Passes (Phase 2D). |
| GT-03 | Refused with "Tuples" as written (Phase 4). A tuple-free version passes. |
| GT-04 | Passes (Phase 3A). |
| GT-05 | Passes (Phase 3A): four logical frames returning 0, 3, 5 and 6. |
| GT-06 | Passes (Phase 3B). The call from `main` is a real frame; the three recursive tail calls are labelled "tail call" (logical frames: the compiled program runs them as a loop). |
| GT-07 | The tuple-free version passes: shared cells, and `old` is unchanged. The tuple is Phase 4. |

### GT-01 — Simple call and bindings (first real tracer milestone)

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

Expected: `main()` evaluates to `25`; **stdout is empty**. Trace `main` → bind `a` → call `square(5)` → `x = 5` → return `25` → bind `b = 25` → return from `main`. Exact source step boundaries to be established by the tracer contract.

### GT-02 — Print output

```gleam
import gleam/io

pub fn main() {
  io.println("Hello, Gleam!")
}
```

Expected: one printed line containing `Hello, Gleam!`. No made-up return-value printing.

### GT-03 — Shadowed binding, not mutation

```gleam
pub fn main() {
  let x = 1
  let y = x
  let x = 2
  #(x, y)
}
```

Expected final value `#(2, 1)`; `y` stays `1`. Show binding reuse without implying object mutation.

### GT-04 — List pattern matching

```gleam
pub fn describe(xs: List(Int)) -> Int {
  case xs {
    [] -> 0
    [first, ..rest] -> first
  }
}

pub fn main() {
  describe([3, 4, 5])
}
```

Expected: selected non-empty branch, `first = 3`, `rest = [4, 5]`, result `3`.

### GT-05 — Non-tail recursion

```gleam
pub fn sum(xs: List(Int)) -> Int {
  case xs {
    [] -> 0
    [first, ..rest] -> first + sum(rest)
  }
}

pub fn main() {
  sum([1, 2, 3])
}
```

Expected final value `6`; nested **logical** frames for `sum([1,2,3])`, `sum([2,3])`, `sum([3])`, `sum([])` and corresponding return propagation.

### GT-06 — Tail recursion

```gleam
pub fn count_down(n: Int, acc: Int) -> Int {
  case n {
    0 -> acc
    _ -> count_down(n - 1, acc + 1)
  }
}

pub fn main() {
  count_down(3, 0)
}
```

Expected final value `3`; visualization must explicitly state whether it shows logical call history or optimized runtime stack frames.

### GT-07 — Immutable list prepend

```gleam
pub fn main() {
  let old = [1, 2, 3]
  let new = [0, ..old]
  #(old, new)
}
```

Expected `#([1, 2, 3], [0, 1, 2, 3])`; unchanged `old`. Conceptual shared-tail drawing is allowed if not falsely claimed as physical memory identity.

### GT-08 onward — add coverage deliberately

- Anonymous closure capturing a local name.
- Higher-order `fn` argument and nested function calls.
- Guards and multiple-subject `case`.
- Tuples and custom-type constructors/patterns.
- `Result` / `Option` and their patterns.
- `echo` vs `gleam/io.println` output handling.
- Source compile errors, type errors, and non-exhaustive `case` checks.
- `panic`, `todo`, `let assert` failure semantics.
- Deep recursion/large lists/timeout and trace-size handling.
- `use`, pipelines, standard-library calls, externals (only after feasibility review).

---

## 9. Acceptance Checklist

### Phase 1 (visual shell only)

- [x] Original supplied screenshots are included as implementation references.
- [x] Gleam star logo is displayed.
- [x] Edit Mode looks and behaves like Python Tutor Edit Mode.
- [x] Visualization Mode is separate and looks like Python Tutor Visualization Mode.
- [x] Red/green source arrows match the declared event semantics.
- [x] Print Output, Frames, Objects appear in the reference arrangement.
- [x] First/Prev/Next/Last/slider all update the same trace index correctly.
- [x] Exited frames can be shown as visually subdued.
- [x] Edit this code returns to the editor, preserving source.
- [x] Fixture trace is visibly marked **Demo trace** and tied to the exact example code.
- [x] Changing the example never creates false-looking real trace results.

### Phase 2+ (real execution)

- [x] Actual compiler is used for supported Gleam programs.
- [x] Trace comes from real evaluation and reflects edits to the source.
- [x] Calls, bindings, returns, source locations and output have automated tests.
- [x] Shadowing, immutability, `case`, and recursion agree with Gleam semantics, including logical frames for tail calls.
- [x] Compile errors and unsupported constructs are not silently visualized.
- [x] Execution limits and isolation policy are documented and tested.

---

## 10. Team Workflow and Change Control

1. **Read this spec and `README.md` before prompting an AI coding assistant.**
2. For a change, name the milestone and precise acceptance checks it serves.
3. Inspect source references, then outline the proposed implementation.
4. Implement the smallest testable increment and run checks.
5. Record actual result, unmet acceptance criteria, and newly found semantic limitations.
6. Avoid changing the UI while solving compiler/tracer issues unless explicitly needed.
7. Update this document **only when a product requirement genuinely changes**; preserve the original design constraints by default.
8. When generating screenshots or demos, label illustrative/fake trace data explicitly.

### Important licensing note

The historical OnlinePythonTutor repository contains notices for **GPL version 3 or later**. The project owner reports permission to use the original project's ideas/materials; this does not remove the need to determine license requirements for copied code or to confirm any separate permission in writing where appropriate. Keep proper copyright notices and attribution when code is incorporated. Check Gleam compiler/Playground dependency licenses separately.

---

## 11. Open Technical Questions (must resolve experimentally)

1. What parser/AST access does the Gleam WASM compiler expose for source instrumentation?
2. Can source-level call, match, binding, and return events be generated without modifying Gleam compiler internals?
3. How reliable are source maps from compiled JavaScript for multiple events on one source line?
4. How are tail calls, closures, `use`, and standard-library functions represented pedagogically?
5. Which code can safely be executed in-browser with meaningful resource limits?
6. Which parts of the historical Python Tutor frontend are legally and technically reusable versus more efficient to rebuild?

**Do not claim these questions are resolved just because a UI demo works.**

---

## 12. Definition of Done for the First Publicly Described Prototype

The **UI prototype** is complete when both Python Tutor-style screens exist and navigation works over a clearly identified fixture. It is **not** a fully functioning Gleam Tutor yet.

The **first execution prototype** is complete only when a supported, user-editable Gleam example generates a **genuine**, deterministic, source-mapped execution trace and displays it correctly in the existing UI, including correct error handling. Until then, label demonstrations accordingly.
