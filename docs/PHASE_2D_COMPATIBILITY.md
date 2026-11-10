# Compatibility report: the example library (Phase 2D, updated through Phase 3C)

**Toolchain:** Gleam compiler 1.19.2 (official WASM build), with `gleam_stdlib` 1.0.5 from Hex. Both are pinned by SHA-256 in `tracer-node/toolchain.json`.

**How this table was produced:** `npm run tracer:audit` (`tracer-node/audit.ts`) runs each of the 20 examples in `examples.js` three times, with the real compiler and the real stdlib. Nothing in it is predicted or hand-entered.

| Column | Meaning |
| --- | --- |
| **Compiles** | The official compiler, given the stdlib sources, accepts the example. |
| **Executes** | The *uninstrumented* compiled program runs to completion in the isolated runner, linked to the precompiled stdlib. |
| **Traces** | The tracer produces a validated step-by-step trace. An example counts only if it also passes the checks in "Supported, and how we know". |
| **Missing features** | The tracer's first refusal, plus every other unsupported construct a token scan of the source finds, each with its line. |

## Results (20 examples, updated for Phase 3C)

| Example | Compiles | Executes | Traces | Missing features |
|---|---|---|---|---|
| Hello world (`hello`) | ✅ | ✅ (2 lines printed) | ✅ 3 steps | — |
| Assignments and shadowing (`assignments`) | ✅ | ✅ (4 lines printed) | ✅ 8 steps | — |
| Lists share their tails (`lists`) | ✅ | ✅ (3 lines printed) | ✅ 6 steps | — |
| Functions (`functions`) | ✅ | ✅ (1 lines printed) | ✅ 13 steps | — |
| Higher order functions and captures (`hof`) | ✅ | ✅ (2 lines printed) | ❌ unsupported | Anonymous functions (line 5) |
| Pipelines (`pipelines`) | ✅ | ✅ (1 lines printed) | ❌ unsupported | Pipelines (line 7) |
| Labelled arguments (`labelled`) | ✅ | ✅ (1 lines printed) | ❌ unsupported | Labelled arguments (line 5) |
| Recursion: factorial (`recursion`) | ✅ | ✅ (1 lines printed) | ✅ 24 steps | — |
| List recursion (`list-recursion`) | ✅ | ✅ (1 lines printed) | ✅ 20 steps | — |
| Tail calls with an accumulator (`tail-calls`) | ✅ | ✅ (1 lines printed) | ✅ 30 steps | — |
| Tree recursion: count partitions (`partitions`) | ✅ | ✅ (1 lines printed) | ✅ 143 steps | — |
| String patterns and guards (`string-patterns`) | ✅ | ✅ (4 lines printed) | ❌ unsupported | String prefix patterns ("a" <> rest) (line 12) |
| Tuples (`tuples`) | ✅ | ✅ (3 lines printed) | ❌ unsupported | Tuples (line 5); Floats (line 5) |
| Custom types (`custom-types`) | ✅ | ✅ (1 lines printed) | ❌ unsupported | Custom types (line 4); Floats (line 10) |
| Records and record updates (`records`) | ✅ | ✅ (2 lines printed) | ❌ unsupported | Custom types (line 4) |
| Results (`results`) | ✅ | ✅ (2 lines printed) | ❌ unsupported | Custom types (line 4) |
| Dict module (`dict`) | ✅ | ✅ (3 lines printed) | ❌ unsupported | Calling dict.from_list (its result type, Dict(k, v), can't be shown yet) (line 6); Tuples (line 6) |
| Option module (`option`) | ✅ | ✅ (2 lines printed) | ❌ unsupported | Custom type constructors (line 5) |
| use with result.try (`use`) | ✅ | ✅ (2 lines printed) | ❌ unsupported | Custom type constructors in patterns (line 12); use expressions (line 18) |
| let assert (crashes on purpose) (`let-assert`) | ✅ | ⚠️ crashes: Error: Pattern match failed, no pattern matched the value. | ❌ unsupported | assert (line 10) |

**Totals:**
- **Compiles:** 20 of 20.
- **Executes:** 20 of 20. `let-assert` crashes on purpose; that is the example's point.
- **Traces:** 8 of 20 (3 after Phase 2D, plus 5 from Phase 3A's lists and `case`): Hello world, Assignments and shadowing, Lists share their tails, Functions, Recursion: factorial, List recursion, Tail calls with an accumulator, Tree recursion: count partitions.

**Notes:**
- **"Missing features"** shows the tracer's first refusal, plus other constructs a token scan finds. Tokens that are fine in context (`case`, `if` guards, list brackets, `..`, `_` patterns) are not counted.
- **The option example's import** (`import gleam/option.{type Option, None, Some}`) is supported since Phase 3C. It is now blocked by using the `Some(...)` constructor.

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

### The five examples added by Phase 3A

Lists, Recursion: factorial, List recursion, Tail calls with an accumulator, and Tree recursion: count partitions are each verified by the audit:
- they compile;
- the instrumented run's result and output equal the uninstrumented run's;
- the trace passes `validateTrace`;
- the dropdown marking agrees with the engine (`sandbox.test.ts`).

None of the five has its own per-step expected trace yet. The constructs they use do have step-by-step tests in `tracer-node/tests/phase3a.test.ts`:
- `case` on Ints and lists;
- `[first, ..rest]` recursion (GT-04, GT-05);
- shared tails (GT-07);
- guards.

Tail calls with an accumulator shows a real frame for the first call, then a logical frame labelled "tail call" for each recursive call (Phase 3B). Partitions is tree recursion: its calls aren't in tail position, so its frames are not labelled.

## Why the other 12 are not traced yet

No example was rewritten to make it traceable, and none needed fixing: every example is valid Gleam (all 20 compile).

| Missing capability | Examples blocked | Planned |
| --- | --- | --- |
| Anonymous functions, function captures | hof | Phase 4 |
| Pipelines (`\|>`) | pipelines | Phase 4 |
| Labelled arguments | labelled | Phase 4 |
| String prefix patterns (`"a" <> rest`) | string-patterns | Phase 4 |
| Tuples (and Floats) | tuples, dict | Phase 4 |
| Custom types, records, `Option`/`Result` values, constructor patterns | custom-types, records, results, option, use | Phase 4 |
| Stdlib results of non-displayable types (`Dict`) | dict | Phase 4 |
| `use` | use | Phase 4 |
| `let assert` | let-assert | Phase 4 |
