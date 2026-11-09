# Phase 2A: Real Gleam Execution Tracing: Architecture Research and Proof of Concept

**Status:** Phase 2A complete. Phase 2B and 2C are **not started** and await approval.
**Date:** 2026-11-09 · **Branch:** `gleam-style` · **Toolchain:** Gleam 1.19.2 (official browser/WASM build) · **Runtime used for the POC:** Node 24.22.0.

---

## 1. Summary

**Recommendation: Option B, compiled JavaScript instrumentation, extended with a source-alignment step.**

1. The **official Gleam compiler** (its WASM build, the same artefact the Playground uses) type-checks the program and compiles it to JavaScript.
2. A small **subset recogniser** checks capabilities and records Gleam source locations. It runs only after the compiler has accepted the program, and it never evaluates anything.
3. The compiled JavaScript is parsed and **aligned** with the source, function by function and `let` by `let`. Any mismatch makes the program *unsupported*; the tracer never guesses a mapping.
4. Recording calls are added around the compiler's own expressions, and the program runs in an **isolated, resource-limited worker**.
5. Raw events are **normalized** into the app's existing `ExecutionTrace` type (`traceKind: "real"`).

The values in a trace come from **the real compiled program running**, with Gleam's real runtime semantics. For example, `x / 0 = 0` comes from the real prelude, and `&&` really short-circuits. A differential check (the uninstrumented program is run too, and the two results must agree) guards against the instrumentation changing behaviour.

**The POC works for a narrow subset:** Int and Bool values, arithmetic and comparison operators, `let`, shadowing, function definitions and calls, nested and recursive calls. It is tested on many program structures, including randomly generated ones. Its event sequences change with the input; it does not recognise examples.

**Main blocker for growing the subset:** the browser build of the compiler emits **no source maps and exposes no AST**. The CLI *does* produce expression-level source maps (§4.6). Exposing them from the WASM build would remove most of the alignment code and is the single most valuable upstream change to pursue.

---

## 2. Baseline (before any Phase 2A change)

| Check | Result |
| --- | --- |
| Git | branch `gleam-style`, HEAD `96cc4c3`, clean tree |
| `npm test` | 5 files, **82 tests passed** |
| `npm run build` | success (JS 169.15 kB / 54.81 kB gzip) |

### What the existing code assumes (inspected: `src/trace/*`, `src/playback/*`, `src/components/*`, `src/App.tsx`, `src/examples/*`, `examples.js`)

- **Trace contract**: `ExecutionTrace` in `src/trace/types.ts`, schema v1.
  - Steps carry `event` (`call | bind | eval | return`), `source`, `justExecuted` (green), `nextToExecute` (red), cumulative `stdout`, `frames` (`module | active | exited`, `bindings`, `returnValue`), `objects` and `error`.
  - Values are tagged (`int`, `float`, `string`, `bool`, `nil`, `ref`).
  - Bindings have an optional `bindingId`, reserved for shadowing.
- **UI-to-tracer seam**: `Tracer.trace(source) → TraceResult` (`ok | compile_error | unsupported`) in `src/trace/tracer.ts`. The UI only talks to this interface, so a real tracer can replace `demoTracer` without UI changes (Phase 2C).
- **Safety rails**: `validateTrace` (schema, source hash, locations in range, references resolvable, cumulative stdout). A trace is tied to the exact source via `hashSource`. Stale results are dropped in `App.tsx`.
- **Demo restriction**: `demoTracer` returns the fixture only when `hashSource(source) === DEMO_TRACE.sourceHash`. Everything else is "unsupported".
- **Playback**: a single clamped index (`src/playback/playback.ts`). All panes are pure functions of `trace.steps[index]`.
- **Example library**: `examples.js` is editor content only. None of its examples is traceable today (and none is by the POC: they all use `gleam/io`).

**Regression tests that must keep passing:** the 82 tests in `src/**`. The POC changes none of them. Its tests run separately (`npm run poc:test`).

---

## 3. Research: the official toolchain

Evidence comes from the live Playground (`playground.gleam.run/{index,compiler,worker}.js`), the official release asset `gleam-v1.19.2-browser.tar.gz` (SHA-256 `9d5ac30e…62b9`), its `gleam_wasm.d.ts` and `README.md`, the Gleam repo at tag `v1.19.2`, and experiments run against those artefacts.

| # | Question | Finding (evidence) |
| --- | --- | --- |
| 1 | How does the Playground compile in the browser? | `worker.js` (a module Worker) loads `compiler/gleam_wasm.js` (wasm-bindgen, `--target web`). It writes the stdlib's **Gleam sources** into a virtual FS with `write_module`, then for each edit calls `write_module("main", code)`, `compile_package("javascript")` and `read_compiled_javascript("main")`. |
| 2 | Is there a usable compiler package / WASM interface? | Yes: an official release asset per version, `gleam-vX.Y.Z-browser.tar.gz` (Apache-2.0, ~4.8 MB `.wasm`). Exports: `compile_package`, `write_module`, `write_file(_bytes)`, `read_file_bytes`, `read_compiled_javascript`, `read_compiled_erlang`, `pop_warning`, `reset_warnings`, `reset_filesystem`, `delete_project`, `format_source`, `initialise_panic_hook`. **Verified working in Node** via `initSync` (POC). It is not on npm; the POC downloads the release asset and verifies its checksum. |
| 3 | How is Gleam compiled to JS? | Module-per-file ESM. `pub fn` becomes `export function`; `let` becomes JS `let`; the last expression becomes `return`. Details in §4. |
| 4 | How are compiled programs executed? | The Playground rewrites `./…` imports to its precompiled stdlib URLs, base64-encodes the module, `import()`s it as a `data:` URL **inside the Worker**, calls `main()`, and captures output by monkey-patching `console.log`. No timeout and no worker recycling are visible in that code. |
| 5 | AST / source-location metadata? | **No AST or typed-AST export in the WASM API.** Locations exist only inside diagnostic text (`┌─ /src/main.gleam:LINE:COL`). |
| 6 | Source maps? | **The CLI** (`[javascript] source_maps = true`) emits v3 maps with **expression-level** segments (decoded in §4.6). **The WASM build emits none**: writing that `gleam.toml` into its virtual FS has no effect; no `.map` file is produced. |
| 7 | Can instrumentation preserve semantics? | For the POC subset, yes: the recorder wraps the compiler's own expressions (`return $__gt.ret(f, (x * x), loc)`), returns values unchanged, and a differential run confirms equal results. Constructs the compiler rewrites (loops for tail calls, `_block` temporaries, `if`-chains for `case`) need structure-aware handling (§4). |
| 8 | Stdlib imports? | Compiled modules import siblings with relative paths (`./gleam.mjs`, `./gleam/io.mjs`). The compiler needs the stdlib **sources** to type-check. At runtime the stdlib must be **precompiled JS**. The WASM package contains neither the stdlib nor the JS prelude: its `gleam.mjs` is just `export * from "./gleam_prelude.mjs"`. The POC fetches the prelude from the `v1.19.2` tag (`compiler-core/templates/prelude.mjs`, checksum pinned; identical to the CLI's output). |
| 9 | Error representation? | `compile_package` **throws a string**: the full human diagnostic with title, `file:line:col` and a hint, for syntax and type errors alike. Warnings come from `pop_warning`. Runtime errors are JS exceptions; Gleam `panic`/`let assert` failures are `Error`s carrying `gleam_error`, `line` and `module` fields (from the prelude). |
| 10 | Licensing / distribution? | Compiler and WASM package: **Apache-2.0** (SPDX header in the package README, `license` in package.json, `LICENCE` at the tag). Stdlib: **Apache-2.0** (GitHub API). **The Playground repository has no licence file** (GitHub reports `license: null`), so its code is studied as reference only and **nothing is copied**. Redistributing the WASM and stdlib needs the Apache-2.0 notice and attribution. |

---

## 4. What the official compiler generates (evidence for the comparison)

Compiled with the official 1.19.2 WASM build (`codegen-probe` experiment):

| Gleam | Generated JavaScript | Tracing consequence |
| --- | --- | --- |
| `let x = 5` / `let x = x + 2` | `let x = 5; let x$1 = x + 2;` | Shadowing is **visible** as `x$N`, so it maps back cleanly. |
| `let a = 7 / 0` | `let a = 0;` | **Constant folding.** Sub-expressions are not guaranteed to exist in JS; expression-level stepping cannot be read off the JS. |
| `let _ = this` | *(statement removed)* | JS statements are not 1:1 with Gleam statements. |
| `fn class(x)` / `let this = …` | `function class$(x)` / `let this$ = …` | Reserved words get a `$` suffix. |
| non-tail recursion over `case` | `if (n === 0) { return 1; } else { return n * fact(n - 1); }` | `case` becomes if-chains; pattern bindings become `let first = xs.head;` with **no `let` in the source**. |
| self **tail call** | `function loop(loop$n, loop$acc) { while (true) { let n = loop$n; … loop$n = n - 1; } }` | **Physical frames disappear.** Logical frames must be reconstructed per loop iteration (Phase 3). |
| `let y = { let t = 2  t * 3 }` | `let _block; { let t = 2; _block = t * 3; } let y = _block;` | Block scopes become temporaries. |
| `fn(x) { x + k }` | `(x) => { return x + k; }` | Closures are JS closures; captures are implicit. |
| `[1, 2]` | `listPrepend(1, listPrepend(2, $List$Empty$const))` | Lists are prelude objects (`NonEmpty{head,tail}`); identity is real JS identity. |
| `Int` and `Float` | both JS `number` | **Runtime values cannot tell `2` from `2.0`.** Display needs static types (not exposed by WASM). |

### 4.6 CLI source-map precision (decoded, Gleam 1.19.2)

```
js 7:3  "let a = 5;"      -> gleam 6:3
js 8:3  "let b = square"  -> gleam 7:3
js 8:11 "square(a);"      -> gleam 7:11    (the call itself)
js 8:18 "a);"             -> gleam 7:18    (the argument)
js 3:14 "x;"              -> gleam 2:7     (right operand of x * x)
```

The compiler already knows expression-level locations. Exposing source maps from the WASM build (e.g. a `compile_package` option) would give the tracer precise, compiler-authoritative anchors.

---

## 5. Comparison of the three approaches

Scale: ●●● strong · ●● adequate · ● weak.

| Criterion | A: Gleam source/AST instrumentation | B: compiled-JS instrumentation (**recommended**, with alignment) | C: limited interpreter |
| --- | --- | --- | --- |
| Semantic correctness | ●● Instrumented Gleam is compiled by the real compiler, but rewriting must keep types, evaluation order and exhaustiveness intact | ●●● Real compiler output and real prelude; instrumentation only observes | ● Every rule (int division, `%`, short-circuit, string ops) re-implemented; drift risk with every Gleam release |
| Real execution fidelity | ●●● Runs real compiled code | ●●● Runs real compiled code; a differential run verifies it | ● Simulated; "real" only by agreement |
| Implementation difficulty | ● **Needs a full Gleam parser + printer** (none exposed); inserted code must type-check | ●● JS parser (acorn) + alignment; grows with each construct's codegen shape | ●● Small subset is easy; grows fastest with language and stdlib |
| Source-line mapping | ●●● Own parser gives exact spans | ●● Today via alignment with a subset recogniser; **●●● if WASM exposes source maps** | ●●● Exact (own parser) |
| Function frames | ●●● | ●●● Entry/exit hooks on compiled functions | ●●● |
| Recursion | ●●● | ●● Non-tail: direct. Tail calls become `while` loops, so logical frames need loop-aware instrumentation | ●●● |
| Immutable bindings | ●●● | ●●● JS `let` never reassigned (except TCO loop vars) | ●●● by construction |
| Shadowing | ●●● | ●●● `x$N` names map back reliably | ●●● |
| Pattern matching | ●● Must instrument patterns without breaking exhaustiveness | ●● if-chains + `xs.head` lets; needs case-clause anchors (source maps or parser) | ●● Must re-implement matching precisely |
| Lists / custom types | ●●● Real runtime values | ●●● Real prelude objects (`NonEmpty`, `CustomType` classes); real sharing | ●● Own representation; sharing is simulated |
| Stdlib imports | ●●● Real stdlib | ●●● Real precompiled stdlib (like the Playground) | ● Each stdlib function re-implemented or bridged |
| Security | ●● Runs untrusted compiled JS (same as B) | ●● Runs untrusted compiled JS; needs a worker plus an origin-isolated sandbox | ●●● Interpreter executes no generated code |
| Browser compatibility | ●●● WASM compiler runs in the browser | ●●● WASM compiler + Worker + `import()` of blob/data modules (as the Playground does) | ●●● Pure TS |
| Long-term extensibility | ●● Parser maintenance per Gleam syntax change | ●● Codegen-shape maintenance per compiler release (pinned version + tests); much less **if source maps are exposed** | ● Re-implements a language that is still evolving |

### Why B

- **Fidelity is the project's top requirement** ("real execution evidence"). Only A and B run the real compiler's output.
- A needs a complete Gleam parser *and* code printer that round-trips through type checking. The WASM API exposes neither, so A carries B's runtime risks plus a much larger front end.
- B's weak point, mapping JS back to Gleam, is **contained and fails safely**: alignment refuses whenever compiled shape and source disagree (tested), and the most likely remedy (source maps) already exists in the compiler.
- B reuses the real stdlib and prelude, so values, printing, division and list structure are exactly Gleam's on the JavaScript target.

### What the recommendation cannot (yet) support

- **Expression-level stepping.** Steps are statement- and call-level. Folded constants (`7 / 0` becomes `0`) and inlined sub-expressions can't be stepped. (Python Tutor is also line-level.)
- **Tail-recursive functions.** They compile to loops, so the POC refuses them. Logical-frame reconstruction is Phase 3 work.
- **`case`, blocks, closures, pipelines, `use`, lists, tuples, custom types, strings, floats, imports and stdlib.** All refused today with a located "not supported yet" message. Each needs either source maps or recogniser growth, plus codegen-shape alignment.
- **Int vs Float display.** Both are JS numbers; a correct display needs static types.
- **The Erlang/BEAM target.** Not traced. JS-target behaviour is what students see (documented in the spec).
- **Arbitrary Gleam programs.** Never claimed.

---

## 6. The proof of concept (`poc/real-trace/`)

### Pipeline

```
source ─► [0] refuse imports (POC has no stdlib)
       ─► [1] official compiler (WASM, in a worker thread) ── error ─► compile_error {title, line, column, message}
       ─► [2] subset recogniser ─────────────────────────────── outside subset ─► unsupported {feature, line, column}
       ─► [3] acorn parse + alignment with source ───────────── mismatch ─► unsupported ("could not map compiled code")
       ─► [4] instrument (recorder calls around compiler's expressions)
       ─► [5] worker thread: run ORIGINAL (baseline) then INSTRUMENTED ── timeout / limit / runtime_error
       ─► [6] differential check: results equal, else internal_error
       ─► [7] normalize → ExecutionTrace (traceKind "real") ─► validateTrace (existing app validator)
```

| File | Role |
| --- | --- |
| `toolchain.json`, `scripts/setup.mjs` | Pinned compiler and prelude URLs with SHA-256; download and verify into `.toolchain/` (git-ignored) |
| `src/compiler.ts`, `src/compile-worker.mjs` | Official WASM compiler in a worker; diagnostic parsing |
| `src/subset.ts` | Tokenizer + recogniser for the subset; source anchors; located refusals |
| `src/instrument.ts` | acorn-based alignment + instrumentation |
| `src/runner.ts`, `src/worker.mjs` | Isolated execution with limits; baseline and traced runs |
| `src/events.ts` | Raw event types, limits and hard ceilings |
| `src/normalize.ts` | Raw events → `ExecutionTrace` (shared immutable snapshots, size cap) |
| `src/traceGleam.ts` | The pipeline above |
| `cli.ts` | `npm run poc:trace -- file.gleam [--json]` |
| `tests/*.test.ts` | 62 focused tests |

### Supported subset (exactly)

Top level: only function definitions (`pub` optional); `pub fn main()` with no parameters is required. Parameters: plain names, optional `: Int` / `: Bool`. Body: zero or more `let name [: Int|Bool] = expr`, then exactly one final expression. Expressions: decimal Int literals, `True`/`False`, variables, calls to functions in the same module, unary `-` and `!`, binary `+ - * / % == != < > <= >= && ||`.

### Explicitly unsupported (refused with a location)

Imports and stdlib · `case` · blocks `{ }` · anonymous functions · functions as values · strings · floats · lists · tuples · custom types and records · labelled arguments and parameters · discard names `_x` · `let assert`, `panic`, `todo`, `echo` · `use` · pipelines · module constants · attributes/externals · expression statements · self tail calls (compiled to loops) · non-decimal literals.

### Evidence that the trace comes from execution, not from recognising examples

Each of these is in `tests/trace.test.ts`:

1. **`a = 5` vs `a = 7`.** Full raw-event sequences are asserted: `bind a=5 … call square(x=5) … return 25 … bind b=25` versus the `7 … 49` equivalent.
2. **Six more inputs** (0, 1, −4, 12, 1000, 123456) and **three different bodies** (`x*x+1`, `x*3-2`, `x-x*x`).
3. **Different program structures**:
   - `add(3, 4)` (the Phase 2B target).
   - Shadowing (`x#1 = 5`, then a new `x#2 = 7`).
   - Nested calls `sq(sq(2))` in real evaluation order.
   - Functions defined after `main`.
   - Recursion through `||` (three logical frames).
4. **Observed behaviour that a mock would have to fake on purpose**:
   - With `a = -3`, `is_pos(a) && is_pos(10)` records **only one** `is_pos` call; with `a = 3` it records two.
   - Gleam's prelude semantics appear in bindings: `17 / 0 = 0`, `-7 % 3 = -1`.
5. **Six randomly generated programs** (seeded) whose recorded events equal values computed independently in the test.
6. **Differential check**: every `ok` run has instrumented result == uninstrumented result.

Example (`npm run poc:trace -- poc/real-trace/samples/square7.gleam`):

```
status: ok   (Gleam 1.19.2, 7 steps, main() = 49)
  1  call   green  -  red  6   main[]
  2  bind   green  6  red  7   main[a=7]
  3  eval   green  7  red  1   main[a=7]
  4  call   green  1  red  2   main[a=7]  square[x=7]
  5  return green  2  red  7   main[a=7]  square(exited)[x=7 ⇒49]
  6  bind   green  7  red  8   main[a=7 b=49]  square(exited)[x=7 ⇒49]
  7  return green  8  red  -   main(exited)[a=7 b=49 ⇒49]  square(exited)[x=7 ⇒49]
```

### What the POC does not demonstrate

- **Running in a browser.** The WASM compiler is browser-native, but the runner uses Node `worker_threads`, a temp directory and `file:` imports. A browser version needs Web Workers and `blob:`/`data:` module imports.
- **Print output.** Imports are refused, so there is no `io.println`. `console.log` capture exists in the worker but is untested.
- **The stdlib.** It isn't provided to the compiler or the runtime.
- **The UI.** The POC is not wired into Visualize Execution. Its traces match the UI's types and validator, but nothing has been rendered in the app.
- **Final step semantics.** The arrow and merge rules in `normalize.ts` are a proposal for Phase 2B.

---

## 7. Execution safety

### Findings

- **A Worker is not a sandbox.** Code in a Web Worker shares the page's origin. It can `fetch` with the user's cookies, read IndexedDB and Cache Storage, and use `importScripts`/`import()`. The Playground runs user code this way, which is acceptable for a playground but not for us.
- **The Gleam language helps.** Gleam code reaches JavaScript only through `@external` functions and the stdlib's FFI. Refusing `@external` and restricting imports to an allowlist (both enforced by the POC: no externals, no imports) leaves only the compiler's codegen and the stdlib as attack surface. That is defence in depth, not a boundary.
- **Resource exhaustion** comes from infinite or exponential recursion, tail-call loops (true infinite loops, since tail calls become `while(true)`), huge lists, and output floods.

### What the POC does (tested in `tests/units.test.ts` and `tests/trace.test.ts`)

| Limit | Default | Hard ceiling | Mechanism |
| --- | --- | --- | --- |
| Wall-clock | 2 s | 10 s | host timer, then `worker.terminate()` (a `while(true){}` program is stopped in about 0.5 s) |
| Events | 5,000 | 50,000 | recorder throws a limit error (Gleam code cannot catch exceptions) |
| Call depth | 500 | 2,000 | recorder |
| Worker heap | 64 MB | 256 MB | `resourceLimits` (allocation bomb gets a `limit` result) |
| Snapshot size | — | 200,000 frame-snapshots | normalizer |
| Stdout | 10,000 chars | 100,000 | worker capture |
| Environment | — | — | worker gets `env: {}` (tested: `process.env` is empty) |

Callers can lower limits but **cannot raise them past the ceilings** (`clampLimits`, tested).

### A real defect found and fixed during the POC

An early version deep-copied every frame into every step. With limits raised to "unlimited", a runaway recursion produced about 30k frames over about 60k steps. **The *host* process (not the worker) died with a fatal out-of-memory error** while normalizing (reproduced three times; the host grew to 1.2–1.9 GB).

Fixes:
1. Frames are immutable and **shared** between steps (tested: unchanged frames are the same object, and earlier snapshots are intact).
2. A snapshot-size cap.
3. Hard ceilings on all limits.

The same input now ends with `limit: Call depth exceeded 2000` in under 100 ms. Lesson for 2B: **the host must bound its own processing of untrusted traces**, not only the worker's execution.

### Recommended browser design (Phase 2C), not yet implemented

1. **A sandboxed, cross-origin iframe** (`sandbox="allow-scripts"`, so it gets an opaque origin, no cookies and no storage) hosting the **compiler Worker** and a **disposable execution Worker**. Results cross back over `postMessage` as plain JSON.
2. **A strict CSP** in the sandbox: `connect-src 'none'`, scripts only from self plus `blob:`.
3. **Terminate and re-create** the execution Worker on timeout or limit, and after every run.
4. **Never `eval` in the main page**, and keep the compiler out of the main thread (it's 4.8 MB of WASM, loaded lazily).
5. **Validate the size and shape of every message from the sandbox before using it** (the OOM lesson above).

---

## 8. Proposed integration interfaces (for 2B/2C)

- Keep `Tracer.trace(source): Promise<TraceResult>` (`src/trace/tracer.ts`) as the only seam. **Widen `TraceResult`** to the POC's statuses:
  ```ts
  | { status: "ok"; trace: ExecutionTrace }
  | { status: "compile_error"; message: string; location?: SourceLocation }
  | { status: "unsupported"; feature: string; message: string; location?: SourceLocation }
  | { status: "runtime_error"; message: string; trace: ExecutionTrace | null }  // partial trace + error step
  | { status: "timeout" | "limit"; message: string }
  ```
- `realTracer` (2C) = browser port of `traceGleam`. `demoTracer` stays for the square fixture.
- **Shadowing history.** Snapshots show visible bindings only; a shadowed name gets a new `bindingId` (`frame:x#2`). Raw events keep the full history. If the UI should show the shadowed binding (greyed out), add an optional `shadowed?: true` to `TraceBinding` in 2B; that's a schema decision for approval.
- **Step semantics proposal.** One step per event. A statement's "about to evaluate" event is merged into its completion when nothing happened in between. Green arrow = this event's location; red = the next event's location (an invariant shared with the demo trace and tested).

---

## 9. Plan

### Phase 2B: minimal real tracing engine (done; see §11)

1. Move the POC core (`subset`, `instrument`, `normalize`, event types) into `src/tracer/` as **pure, environment-independent modules**. Keep Node specifics (temp files, `worker_threads`) behind a `Runtime` interface.
2. Finalize the event model and step semantics (§8). Add `runtime_error`, `timeout` and `limit` to `TraceResult`. Decide the shadowing display.
3. Cover the 2B target list exactly: Int/Bool literals, arithmetic, comparisons, `let`, references, shadowing, functions, arguments, calls, returns. All are already working in the POC; harden them with more golden programs and golden traces (GT-01, GT-03 and the 2B examples).
4. Add the error taxonomy end to end: syntax, type, unsupported, runtime, timeout, internal.
5. **In parallel, ask upstream (gleam-lang/gleam) about exposing JS source maps from `compiler-wasm`.** If that's accepted, replace alignment anchors with source maps and keep the recogniser only for capability detection.

### Phase 2C: integration (done; see §12)

1. Build the browser runtime: a sandboxed iframe with compiler and execution Workers (§7), and lazy loading of the WASM.
2. Implement `realTracer`. In `App.tsx`, try `demoTracer` for the fixture, otherwise `realTracer`. Map statuses to the friendly messages already used in Edit Mode.
3. Mark library examples as traceable only when `realTracer` accepts them (computed, never hard-coded).
4. Run regression on all 82 app tests plus new end-to-end tests: edit, visualize, and a new trace for edited code.

### Later phases (design constraints already respected)

- **Phase 3:** loop-aware instrumentation for tail calls (logical frame per iteration, labelled as logical), closures (`ref` values to function objects with captured bindings).
- **Phase 4:** `case` / lists / tuples / custom types, which need source maps or a real parser for clause anchors; real prelude objects map to `list`, `tuple` and `record` `TraceObject`s.
- **Phase 5:** stdlib (a precompiled stdlib bundle, as in the Playground), pipelines, `Result`/`Option`, and static types for Int/Float display.

---

## 10. Open issues and blockers

| Issue | Impact | Proposed path |
| --- | --- | --- |
| WASM compiler has no source maps or AST | Alignment logic grows per construct | Upstream request/PR; until then, recogniser + alignment with refusal on mismatch |
| No static types at runtime (Int vs Float) | Wrong display of floats | Recogniser annotations for simple cases; ask upstream about type info / `.d.mts` from WASM |
| Tail calls become loops | No physical frames | Loop-aware instrumentation (Phase 3), labelled as logical history |
| Stdlib distribution in the browser | Needed for any `import` | Build-time precompile of `gleam_stdlib` (Apache-2.0), pinned with the compiler version |
| Compiler version coupling | Codegen shapes can change between releases | Pin the version (done), checksum (done), golden codegen tests on upgrade |
| Browser sandbox not built | Unsafe to run untrusted JS in the app as-is | §7 design; security review before 2C ships |
| Playground code has no licence | Cannot reuse its worker/loader code | Re-implemented independently (done) |

---

## 11. Phase 2B status (implemented)

**What changed**

| Item | Result |
| --- | --- |
| Engine moved out of the POC | `src/tracer/` holds pure modules: `events`, `subset`, `instrument`, `normalize`, `runtime`, `traceGleam` and `toTraceResult`. `poc/real-trace/` is gone. |
| Node-specific code | Moved behind `TracerRuntime` in `tracer-node/` (compiler worker, execution worker, `nodeRuntime`). |
| `TraceResult` | Widened to `ok`, `compile_error` (with `details` = the compiler's full text), `unsupported` (with `feature` and `location`), `runtime_error` (partial trace), `timeout`, `limit` and `internal_error`. |
| App handling | Edit Mode shows each status. A runtime error that has a partial trace opens the visualizer, and the trace's last step shows the error. |
| Step semantics | Kept as proposed in §8. |
| Shadowing display | Visible bindings only, as in Python Tutor. Earlier snapshots keep the old binding, and each binding has a distinct `bindingId`. The schema is unchanged; no `shadowed` flag was added. |
| Goldens | GT-01: every step and both arrows, and the final state equals the Demo trace's. GT-03 as written is refused with "Tuples" at 5:3, because tuples are outside 2B; a tuple-free GT-03 golden covers it instead. 2B target-list program. |
| Error taxonomy, end to end | Syntax, type and unknown-variable errors from the official compiler. Unsupported features with locations. Depth and event limits, and an oversized source. Timeouts, runtime errors with a partial trace, compiler crashes, and differential mismatches are tested by injecting fake runtimes. |

**Local preview (2B only, removed in 2C).** During 2B, a Vite dev endpoint ran the engine in Node. Phase 2C replaced it with the browser runtime.

**Still open:** the §10 blockers, and the whole of Phase 2C. That covers:
- the browser runtime and sandboxed iframe;
- marking examples as traceable;
- end-to-end UI tests that use the real tracer.

---

## 12. Phase 2C status (implemented)

| Plan item | Result |
| --- | --- |
| 1. Browser runtime | `src/tracer/browserRuntime.ts`: a sandboxed `srcdoc` iframe (`sandbox="allow-scripts"`, so an opaque origin) with a strict CSP (`connect-src 'none'`, host script allowed only by its hash, `blob:` workers, `'wasm-unsafe-eval'`). It runs one reused compile worker and a **new execution worker per run**. The toolchain is fetched from the same origin and each file is checked against its pinned SHA-256 (`tracer-node/toolchain.json`). Every reply is validated for shape and size (`outcome.ts`). The engine and acorn load as a separate chunk on the first real trace, so the main bundle grows only from 169.6 to about 177 kB. |
| 2. `realTracer` | `main.tsx` uses `withDemoFixture(realTracer)`: the exact demo keeps the fixture and everything else is traced for real. Statuses map to the Edit Mode messages from 2B. |
| 3. Traceable examples | Computed from the code with the engine's subset recogniser (`traceable.ts`), and shown as "(step-through)" in the dropdown. A test checks that this marking agrees with the real engine for every example and sample. **No library example qualifies today**, because all 21 import `gleam/io`. |
| 4. Regression + end to end | App 88/88 and engine 128/128. A new real-browser suite (`e2e/`, system Chrome via `puppeteer-core`, against the production build) covers: demo vs. edited code (49), compile error, unsupported construct, depth limit, the iframe's attributes and CSP, **no network, storage, cache, import or WebSocket access from the execution worker** (with an unsandboxed control), and recovery after an infinite loop. |

**Findings during 2C**
- **Chrome refuses `blob:` module workers in an opaque-origin sandbox.** Classic workers work there and can still `import()` `blob:` modules, so the sandbox uses classic workers.
- **The browser has no per-worker heap limit.** The subset cannot allocate beyond its call stack, and that stack is bounded by the depth limit. Lists and strings (Phase 4+) will need an allocation budget, for example a cap on list length enforced by instrumentation.

**Remaining before a public deployment**
- An independent security review of the sandbox.
- Hosting headers: serve the toolchain with long-cache immutable headers, and consider a page-level CSP for the app itself.
- E2E tests run only in Chrome so far; Firefox and Safari need checking.
- The §10 blockers: source maps, the Int/Float distinction, and the standard library, which would make the library examples traceable.
