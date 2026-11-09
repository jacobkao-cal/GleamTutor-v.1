# Phase 2D compatibility report: the example library

**Toolchain:** Gleam compiler 1.19.2 (official WASM build), with `gleam_stdlib` 1.0.5 from Hex. Both are pinned by SHA-256 in `tracer-node/toolchain.json`.

**How this table was produced:** `npm run tracer:audit` (`tracer-node/audit.ts`) runs each of the 20 examples in `examples.js` three times, with the real compiler and the real stdlib. Nothing in it is predicted or hand-entered.

| Column | Meaning |
| --- | --- |
| **Compiles** | The official compiler, given the stdlib sources, accepts the example. |
| **Executes** | The *uninstrumented* compiled program runs to completion in the isolated runner, linked to the precompiled stdlib. |
| **Traces** | The tracer produces a validated step-by-step trace. An example counts only if it also passes the checks in "Supported, and how we know". |
| **Missing features** | The tracer's first refusal, plus every other unsupported construct a token scan of the source finds, each with its line. |

## Results (20 examples)

| Example | Compiles | Executes | Traces | Missing features |
|---|---|---|---|---|
| Hello world (`hello`) | ✅ | ✅ (2 lines printed) | ✅ 3 steps | — |
| Assignments and shadowing (`assignments`) | ✅ | ✅ (4 lines printed) | ✅ 8 steps | — |
| Lists share their tails (`lists`) | ✅ | ✅ (3 lines printed) | ❌ unsupported | Lists (line 5); List spreads and record updates (line 10) |
| Functions (`functions`) | ✅ | ✅ (1 lines printed) | ✅ 13 steps | — |
| Higher order functions and captures (`hof`) | ✅ | ✅ (2 lines printed) | ❌ unsupported | Anonymous functions (line 5); Discard names (starting with _) (line 10) |
| Pipelines (`pipelines`) | ✅ | ✅ (1 lines printed) | ❌ unsupported | Lists (line 6); Pipelines (line 7) |
| Labelled arguments (`labelled`) | ✅ | ✅ (1 lines printed) | ❌ unsupported | Labelled arguments (line 5); case expressions (line 15) |
| Recursion: factorial (`recursion`) | ✅ | ✅ (1 lines printed) | ❌ unsupported | case expressions (line 10); Discard names (starting with _) (line 12) |
| List recursion (`list-recursion`) | ✅ | ✅ (1 lines printed) | ❌ unsupported | Lists (line 5); case expressions (line 10); List spreads and record updates (line 12) |
| Tail calls with an accumulator (`tail-calls`) | ✅ | ✅ (1 lines printed) | ❌ unsupported | case expressions (line 15); Discard names (starting with _) (line 17) |
| Tree recursion: count partitions (`partitions`) | ✅ | ✅ (1 lines printed) | ❌ unsupported | case expressions (line 10); Discard names (starting with _) (line 11); if (line 12) |
| String patterns and guards (`string-patterns`) | ✅ | ✅ (4 lines printed) | ❌ unsupported | case expressions (line 11); Discard names (starting with _) (line 13); if (line 19) |
| Tuples (`tuples`) | ✅ | ✅ (3 lines printed) | ❌ unsupported | Tuples (line 5); Floats (line 5); Discard names (starting with _) (line 8) |
| Custom types (`custom-types`) | ✅ | ✅ (1 lines printed) | ❌ unsupported | Custom types (line 4); Lists (line 10); Floats (line 10); case expressions (line 16); List spreads and record updates (line 25) |
| Records and record updates (`records`) | ✅ | ✅ (2 lines printed) | ❌ unsupported | Custom types (line 4); List spreads and record updates (line 12) |
| Results (`results`) | ✅ | ✅ (2 lines printed) | ❌ unsupported | Custom types (line 4); case expressions (line 15) |
| Dict module (`dict`) | ✅ | ✅ (3 lines printed) | ❌ unsupported | Calling dict.from_list (its result type, Dict(k, v), can't be shown yet) (line 6); Lists (line 6); Tuples (line 6) |
| Option module (`option`) | ✅ | ✅ (2 lines printed) | ❌ unsupported | Unqualified imports (import module.{...}) (line 2); Custom types (line 2) |
| use with result.try (`use`) | ✅ | ✅ (2 lines printed) | ❌ unsupported | case expressions (line 11); Discard names (starting with _) (line 13); use expressions (line 18) |
| let assert (crashes on purpose) (`let-assert`) | ✅ | ⚠️ crashes: Error: Pattern match failed, no pattern matched the value. | ❌ unsupported | assert (line 10); Lists (line 10); List spreads and record updates (line 10) |

**Totals:**
- **Compiles:** 20 of 20.
- **Executes:** 20 of 20. `let-assert` crashes on purpose; that is the example's point.
- **Traces:** 3 of 20: Hello world, Assignments and shadowing, Functions.

The token scan names some constructs by their first token, so a few labels read loosely:

| Example | Label | What it actually is |
| --- | --- | --- |
| `hof` | "Discard names" (line 10) | The function capture `add(10, _)` |
| `option` | "Custom types" (line 2) | The `type` keyword inside `import gleam/option.{type Option, None, Some}` |
| `records` | "List spreads and record updates" (`..`) | A record update |

## Supported, and how we know

An example counts as supported only when all of these hold:

1. **It compiles.**
2. **It runs.**
3. **The trace is accurate:**
   - The instrumented run's result and printed output equal the uninstrumented run's (a differential check on every trace).
   - The trace passes `validateTrace`.
4. **Its values and output are right.** Step-by-step expectations in `tracer-node/tests/phase2d.test.ts` check each step's event, line and output.
5. **It works with the playback controls in a real browser** (`e2e/browser.e2e.test.ts`):
   - Hello world: Next, Prev, First and Last each show exactly the output printed so far.
   - Assignments: String values appear as Gleam literals.
   - Functions: one frame per user call, and none for `int.to_string`.

| Example | What the trace shows |
| --- | --- |
| Hello world | `main` called. Each `io.println` is one step that adds its line to Print Output: `Hello, Joe!`, then `Hello, Mike!`. `main` returns `Nil`. |
| Assignments and shadowing | `x = "Original"`, then `y = "Original"`. `x` is re-bound to `"New"` as a new binding (`x#2`); `y` stays `"Original"`. Output: `Original`, `Original`, `New`, `Original`. |
| Functions | Frames `main`, `add(2, 3) → 5`, `double(5) → 10` and `multiply(5, 2) → 10`. `int.to_string` and `io.println` are single atomic steps with no frame. Output: `10`. |

## Why the other 17 are not traced yet

No example was rewritten to make it traceable, and none needed fixing: every example is valid Gleam (all 20 compile).

| Missing capability | Examples blocked | Notes |
| --- | --- | --- |
| `case` expressions and patterns (incl. `_`, guards with `if`) | recursion, tail-calls, partitions, string-patterns, labelled, list-recursion, custom-types, results, use | Compiled to `if` chains, and tail calls become `while` loops. Both need new alignment rules (Phase 3). |
| Lists, `[x, ..rest]` spreads | lists, pipelines, list-recursion, custom-types, dict, let-assert | Need list objects in the Objects panel, plus a size budget. |
| Tuples | tuples, dict | Need tuple objects. |
| Custom types, records, record updates, `Option`/`Result` values | custom-types, records, results, option | Need record objects, and stdlib functions whose results are such values. |
| Anonymous functions and function captures | hof | Need closure objects. |
| Labelled arguments | labelled | The compiled call reorders arguments; needs alignment. |
| Pipelines (`\|>`), `use` | pipelines, use | Desugaring has to be mapped back to the source. |
| Floats | tuples, custom-types | Int and Float are the same at run time; needs type information to display correctly. |
| Unqualified imports (`import m.{x}`) | option | Also needs `Option` values. |
| `let assert` | let-assert | Failure semantics (a crash with a partial trace) are planned for later. |
