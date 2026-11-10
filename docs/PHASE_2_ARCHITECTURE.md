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

---

## 13. Phase 2D status: standard library, Strings, Print Output

The details are in `tracer-node/README.md` (sections "Standard library" and "Print Output"). The per-example results are in `docs/PHASE_2D_COMPATIBILITY.md`.

| Item | Result |
| --- | --- |
| Stdlib integration | Official `gleam_stdlib` **1.0.5** (Hex tarball, SHA-256 pinned), matching compiler **1.19.2**. The compiler gets the real stdlib sources. At run time, programs link to the stdlib precompiled by the same compiler and bundled with esbuild 0.21.5; the bundle's SHA-256 is pinned, so the build is reproducible. The Playground's approach was studied but no code was copied, since that repository has no licence. |
| Why a bundle | `gleam_stdlib.mjs` (the FFI) imports compiled stdlib modules that import it back. Each module would need its URL before its own text could be written, which `blob:` URLs can't express for a cycle. One bundle plus generated facades has no cycles. Facades are created by cutting import specifiers out at parsed positions, so no program text is ever search-and-replaced. |
| Stdlib calls | Atomic: the stdlib is never instrumented. A call is traceable only if its declared result type is `Int`, `Bool`, `String` or `Nil`, read from the stdlib sources. Floats and generic results stay out because they would display incorrectly. `int.random` is refused because it breaks the run-twice comparison. |
| Strings | Literals (escapes, Unicode, multi-line), bindings, arguments, results and `<>`. They are shown as Gleam literals (`"say \"hi\"\n"`). Each value is capped at 10k characters and each run at 1M in total. |
| Print Output | Captured from the real stdlib output paths, recorded as events, and placed at the step where it happened. Playback shows the output printed so far. The differential check also compares output. The browser worker gets an output-only `process` stand-in so `io.print` adds no newline, as under Node and `gleam run`. |
| Expression statements | `io.println(x)` lines become steps. A statement records "about to evaluate" and "finished" events, merged into one step when only output happened in between. |
| Capability detection | The same recogniser with the same stdlib metadata, run on the editor's current text. Visualize Execution always re-checks with the real engine, and the dropdown marks are computed. Refusals are lazy: the message names the first construct the parser can't handle, for example "Unqualified imports" rather than a later token. |
| Examples | **3 of 20 traceable:** Hello world, Assignments and shadowing, Functions. All 20 compile and run. The other 17 need `case`, lists, tuples, custom types, closures, labelled arguments, pipelines, `use` or `let assert`. |
| Tests | Engine 159 (26 new in `phase2d.test.ts`: programs A–H, Unicode, limits, playback invariants, the three examples). App 98 (new: Gleam string formatting, Print Output across playback). Browser e2e 14 (new: computed dropdown marks; hello, assignments and functions in Chrome; `io.print` without a newline). |

**Security, unchanged from 2C:**
- The sandbox iframe and per-run workers.
- `connect-src 'none'`.
- Every reply is validated, and now also has budgets for total output and String characters.

New in 2D:
- **The sandbox now holds the 210 KB stdlib bundle.** It is pinned by checksum and comes from the same origin.
- **The `process` stand-in exposes only two no-op `write` functions,** and the recorder replaces those while a run is captured.
- **Programs can now call any traceable stdlib function.** None of them can reach the network or storage; the CSP and the opaque origin still apply.
- **Still open:** there is no per-worker memory limit in browsers. The subset still can't build large structures (no lists), and Strings are capped.

**Known limitations:**
- **stderr** is merged into Print Output.
- **A stdlib call is one step,** so a crash inside the stdlib is reported at the student's line, not inside the stdlib.
- **Bundling:** the whole 210 KB stdlib bundle is loaded by each run's worker, even when the program uses one module. A warm run of Hello world still finishes in roughly 0.4 s in the e2e suite.

---

## 14. Phase 3A status: lists and pattern matching

### Architecture change: instrument the Gleam source, not the compiled JavaScript

The compiled code of `case` expressions can't be mapped back to clauses. The official compiler turns `case` into a decision tree:
- **Clauses get reordered:** for `[a, b, ..] / [a] / _`, the `_` body is emitted first.
- **Clause bodies get rewritten:** `0 -> 0` became `return n`.
- **Tail calls become loops:** self tail calls compile to `while (true)`.
- **`let x = case …` changes shape:** it compiles to `let _block; if … _block = …`.

All of these were observed in Gleam 1.19.2. Statement-by-statement alignment therefore had to go. The rest of the architecture is unchanged: the recogniser (extended), the sandbox, the recorder, the stdlib linking, the normaliser, the schema (extended) and the UI.

`src/tracer/instrument.ts` now inserts **probe calls into the student's Gleam source** at regions the recogniser records:

| Region | Probe |
| --- | --- |
| Function entry and parameters | `enter`, `arg` |
| `let` and expression statements | `line`, then `bind` or `done` |
| A function's final expression | `ret`, which returns its argument unchanged |
| Each `case` expression | `close`, which returns its argument unchanged |
| Each clause body | `match`, plus `pvar` for each pattern variable |

The probes are typed `@external` functions appended to the module. The official compiler compiles the instrumented module, and `link.ts` supplies their implementation module. That module also registers the prelude's list classes with the recorder.

Properties:
- **The selected clause is observed, not inferred.** The `match` probe sits inside the clause body, so it runs exactly when that clause is selected, in whatever order the decision tree tests clauses.
- **Values are still observed, never computed.** The probes are identity functions or return Nil. The run-twice check still requires the instrumented program's result and output to equal the uninstrumented program's. Results are now compared structurally (`valueKey`), so list cells match by content, not identity.
- **Locations come from the original source** (Int literals in the probes), so inserted text never shifts what the trace reports.
- **Tail calls:** in the instrumented program, `ret` wraps the final call, so the call is no longer in tail position. Self tail calls therefore run as ordinary recursion, one *logical* frame per call; the uninstrumented baseline still runs the compiler's loop. This is what Phase 3B needs. Labelling those frames as logical in the UI is 3B work. A tail call that never ends really does run forever (the baseline loops), so it ends in `timeout`. Previously it was refused.

### Lists

- **Recording:** a list value is recorded as a reference to its first cell. Cells are immutable, so each is recorded once, as a `node` event (head value plus the tail cell's id). The recorder tracks cell identity with a `WeakMap`, so shared tails stay shared: `[0, ..old]` adds one cell that points at `old`'s first cell.
- **Schema:** two additions. `TraceValue` gains `empty-list`, and `TraceObject` gains `cons { head, tail }`.
- **Display:** each step's Objects are the function objects plus every cell reachable from that step's frames. The diagram draws cells as `[ head | • ]` chains, one row per chain, with `[]` inline. A pattern variable such as `tail` points into the middle of the same chain.
- **Bounds:** every cell is an event, so the event limit bounds list size (5,000 by default). Snapshot size counts cells too.

### case and patterns

- **Patterns supported:**
  - literals: Int (including negative), String, True, False and Nil;
  - variables and `_` / `_name` discards;
  - list patterns `[]`, `[a, b]`, `[a, ..rest]`, `[a, ..]`, nested to any depth;
  - several subjects (`case a, b`);
  - guards (`x if x < 0`).
- **Clause bodies** can be expressions or blocks.
- **A `match` step** is shown at the clause line with its pattern variables bound.
- **Scope:** pattern variables and a clause block's `let`s belong to the clause. When the case expression ends, the frame's bindings go back to what they were before it, at the frame's next step. At a `return` they're still shown, since they produced the returned value.
- **Not supported yet (refused with a location):**
  - alternative patterns `a | b`, string prefix patterns (`"a" <> rest`), `as`;
  - tuple and constructor patterns;
  - `let` destructuring;
  - blocks outside clause bodies (Phase 3B).

### Results

- **Examples:** 8 of 20 library examples now trace (verified by `npm run tracer:audit`): hello, assignments, lists, functions, recursion, list-recursion, tail-calls and partitions.
- **Engine tests:** 179 (21 new in `phase3a.test.ts`), covering:
  - the spec example `first([3, 4, 5])`;
  - GT-04, GT-05 (frames returning 0, 3, 5, 6) and tuple-free GT-07 (shared cells);
  - decision-tree clause order, guards and several subjects;
  - scope after a `case`, nested list patterns with shadowing, strings in lists with output;
  - arrows, snapshot immutability and reachability;
  - refusals, compiler errors (inexhaustive `case`), and the event limit for long lists.
- **App tests:** 99, including a new component test for drawing list chains with shared tails.
- **Browser e2e:** 16, including `first` and `sum` in Chrome (cells, pointers into the same chain, `[]` inline, and First/Next/Last).

**Known limitations (3A):**
- **Return arrows:** a function whose final expression is a `case` shows its `return` step on the `case` line, not on the selected clause's line.
- **Tail-call frames:** tail-recursive programs show every logical frame, which can be many; the depth limit (500) still applies. They aren't yet labelled as logical frames.
- **Stdlib calls returning lists** (e.g. `list.reverse`) are still refused; that's 3C.
- **Long lists:** each cell is a separate box in a row, so long lists need horizontal scrolling in the Objects panel.

---

## 15. Phase 3B status: recursion and scope

### Logical frames for tail calls

**The problem.** For a self tail call (`_ -> count_down(n - 1, acc + 1)`), the official compiler emits a `while (true)` loop over `loop$` parameters, so the real program has one JavaScript frame. The instrumented program wraps the final expression with `ret`, so there the call is not a tail call and every call gets its own frame. That is right for teaching, but it isn't the runtime stack, and the diagram now says so.

**How a call is labelled.** A frame is labelled "tail call" only when two things agree:
1. **The source:** the recogniser finds a **self-call in tail position**. That position runs through the function's final expression, the bodies of a `case` in tail position, and the final expression of a block in tail position. A call combined with an operator (`1 + f(n - 1)`) is never a tail call.
2. **The compiler:** `loopFunctionsIn` reads the *uninstrumented* compiled JavaScript and confirms the function really became a loop (`function f(loop$…) { while (true) {`).

**How the label reaches the frame.** At such call sites the instrumenter wraps the **last argument** in `gleam_tutor_tail(frame, "f", arg)`, an identity probe. Arguments are evaluated left to right, so the marker is set just before the call. The recorder flags that call's event `tail`, and the normaliser sets `tailCall` on the frame. A call with no arguments is wrapped in a block that sets the marker first.

**Result.**
- The frame created from outside (e.g. by `main`) is a real frame.
- Each recursive tail call is a logical frame. The diagram shows a small dashed "tail call" tag whose tooltip explains this.
- Mutual recursion (`is_even` / `is_odd`) isn't compiled to a loop, so it isn't labelled. Neither is non-tail recursion (`sum`, factorial).
- A test checks, for every library example, that each labelled frame belongs to a function the compiler made a loop.

**Depth limit.** Every logical frame counts toward the call-depth limit (500). Deep tail recursion (e.g. counting down from 10,000) stops with "Call depth exceeded 500", even though the real program, being a loop, would finish.

### Blocks

`{ ... }` is now supported anywhere an expression is:
- `let y = { ... }`;
- a function's final expression;
- grouping, as in `{ 1 + 2 } * 3`;
- arguments.

The instrumenter wraps a block in `gleam_tutor_close(frame, id, { gleam_tutor_open(frame, id) { … } })`. In the normaliser, `open` saves the frame's bindings and `close` restores them at the frame's next step, the same mechanism as `case` clauses (§14). The block's own `let`s, including shadowing an outer name, are visible inside it and gone after it. The outer binding is visible again, with its original `bindingId`.

### Results

- **Engine:** 193 tests (14 new in `phase3b.test.ts`), covering:
  - GT-06, with exact frames and labels;
  - factorial and mutual recursion, never labelled;
  - labels agreeing with the compiler for every example;
  - the Tail calls example, and tail calls found through blocks and nested `case`s;
  - the depth limit on deep tail recursion;
  - `loopFunctionsIn` and the marker rule;
  - block scope, shadowing in blocks, blocks for grouping and as a function's result, return values through nested calls;
  - identical traces on repeated runs.
- **App:** 100 tests, including the "tail call" tag component test.
- **Browser e2e:** 18 tests, including GT-06's labels in Chrome and a block's bindings disappearing.
- **Examples:** unchanged at 8 of 20. No library example uses a block outside a `case` clause; the tail-call examples now carry their labels.

**Known limitations (3B):**
- **Depth limit:** logical frames count toward the depth limit (see above).
- **Blocks have no step of their own:** the steps come from the statements inside them.
- **Return arrows:** a function whose final expression is a `case` still shows its `return` step on the `case` line (§14).

---

## 16. Phase 3C status: imports and output

### Investigation answers

| Question | Answer (verified) |
| --- | --- |
| How does the official compiler resolve stdlib imports? | It needs the stdlib's **Gleam sources** to type-check. The compile worker writes all 19 modules of the pinned `gleam_stdlib` 1.0.5 (from `stdlib.sources.json`) next to `main` on every compile, which takes about 50–130 ms. Compiled code imports `./gleam/<module>.mjs`. At run time those imports are linked to facades over the precompiled stdlib bundle (§13). |
| Which modules are available in the browser runtime? | All 19 (test: each one imports and compiles): `bit_array`, `bool`, `bytes_tree`, `dict`, `dynamic`, `dynamic/decode`, `float`, `function`, `int`, `io`, `list`, `option`, `order`, `pair`, `result`, `set`, `string`, `string_tree`, `uri`. "Available" means the import resolves and the code runs; which **calls** can be traced is decided per function (below). |
| `gleam/io.println` and Print Output | Works since Phase 2D. Captured from the real stdlib output path and shown step by step. |
| `gleam/list`, `gleam/int` | Verified in `phase3c.test.ts` against known Gleam results:<br>• **list:** `reverse`, `append`, `length`, `contains`, `take`, `drop`, `flatten`, `repeat`, `intersperse`, `unique`, `window`<br>• **int:** `to_string`, `max`, `absolute_value`, `sum`, `product`, `is_even`<br>• **string:** `split`, `join`, `uppercase`, `length`, `reverse`, `to_graphemes`, `replace` |
| Arbitrary packages / remote loading | Not possible. The compiler only has the stdlib sources, so any other module is the compiler's "Unknown module" error. The message adds: "Only the Gleam standard library (gleam_stdlib 1.0.5) can be imported". Nothing is fetched at run time. |
| Tracing inside the stdlib | Not done. Stdlib code is never instrumented: each stdlib call is one atomic step with no frame, while user functions keep their frames. |

### Which stdlib calls are traceable

A call is traceable when the function is public and its declared result type (read from the stdlib sources) is **displayable**: `Int`, `Bool`, `String`, `Nil`, `List(...)` of those, or a **type variable**.

**Type variables are safe by parametricity.** A generic function can only return values that came in through its arguments. Every value a traced program can make is already displayable, because Floats, tuples, custom types and function values are refused where they would be created.

**Coverage:** 164 of 353 public stdlib functions have a displayable result type, up from 108 in Phase 2D. Excluding the three random ones below, **161 are traceable**. By module: 42 in `gleam/list` (2 of them random), 25 in `gleam/int` (1 random) and 31 in `gleam/string`.

**Still refused, with a reason:**
- results of type `Float`, `Result`, `Option`, `Dict`, `Order` or tuples;
- higher-order calls (`list.map(xs, f)`), because passing a function as a value isn't supported;
- `int.random`, `float.random`, `list.shuffle` and `list.sample`, because the run-twice comparison needs deterministic results.

**List results** are real stdlib values, recorded cell by cell. Where the stdlib shares structure, the trace shows it. For example, `list.drop(xs, 1)` is the rest of `xs`'s own cells, not a copy.

### Import syntax

- `import gleam/x`
- `import gleam/x as y`
- `import gleam/x.{f, f as g, type T, C}`

Unqualified functions are called by name, with the same traceability check. Types can be imported. Imported constructors (`Some`) are refused where they're used, because custom types are Phase 4. Using an unqualified function as a value is refused.

### Results

- **Engine:** 212 tests (19 new in `phase3c.test.ts`).
- **App:** 100 tests.
- **Browser e2e:** 20 tests (new: unqualified and qualified imports with list results, and a higher-order call refused).
- **Examples:** unchanged at 8 of 20. The option example now gets past its import and stops at `Some(...)` (custom type constructors, Phase 4).

**Known limitations (3C):**
- **stderr** (`io.println_error`) is merged into Print Output.
- **Stdlib crashes** are reported at the student's line, because a stdlib call is one step.
- **Load per run:** the whole 210 KB stdlib bundle is loaded by each run's worker.
