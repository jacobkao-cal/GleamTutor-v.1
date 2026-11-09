# Real Gleam tracing: engine, runtimes and tests

The tracing engine lives in `src/tracer/`. It is pure TypeScript, and an injected `TracerRuntime` compiles and runs programs. There are two runtimes:

| Runtime | Where | Used by |
| --- | --- | --- |
| **Browser** (`src/tracer/browserRuntime.ts`, Phase 2C) | sandboxed iframe + Web Workers | the app (`npm run dev`, production builds) |
| **Node** (`tracer-node/nodeRuntime.ts`) | worker threads | engine tests, the CLI |

Both runtimes share:
- the same recorder and linker (`src/tracer/sandbox/recorder.js`);
- the same pinned official Gleam 1.19.2 compiler;
- the same pinned official `gleam_stdlib` 1.0.5, precompiled into one bundle.

## Run it

```sh
npm install
npm run tracer:setup      # downloads the pinned compiler, JS prelude and gleam_stdlib (SHA-256 checked),
                          # precompiles + bundles the stdlib (output SHA-256 checked: reproducible),
                          # and copies the browser runtime's files into public/gleam-toolchain/1.19.2/
npm run dev               # the app: edited code is traced for real in the browser
npm run tracer:test       # engine tests (Node)
npm run build && npm run e2e   # real-browser end-to-end tests (system Google Chrome via puppeteer-core)
npm run tracer:typecheck
npm run tracer:trace -- tracer-node/samples/square7.gleam           # step table
npm run tracer:trace -- tracer-node/samples/square7.gleam --json    # full result: trace, raw events, compiled JS
npm run tracer:audit      # compile / execute / trace every library example -> docs/PHASE_2D_COMPATIBILITY.md table
```

If `tracer:setup` has not been run, the app still works. The Demo trace still plays, and any other program shows "Gleam Tutor hit an internal problem ... run: npm run tracer:setup".

## Standard library (Phase 2D)

| Stage | What happens |
| --- | --- |
| **Pinned inputs** (`toolchain.json`) | Compiler `gleam-v1.19.2-browser.tar.gz`, prelude from tag `v1.19.2`, and `gleam_stdlib-1.0.5.tar` from repo.hex.pm, each checked by SHA-256. All are Apache-2.0. |
| **Setup** (`setup.mjs`) | Compiles the stdlib's Gleam sources to JavaScript with the same WASM compiler. Bundles them with the prelude and the stdlib's own FFI files (`gleam_stdlib.mjs`, `dict.mjs`) into **one** ES module, using esbuild 0.21.5. The stdlib's modules import each other in cycles, which `blob:` URLs can't express, so they're bundled. The output is checked against pinned checksums, so the build is reproducible. Setup also writes `stdlib.json` (each module's exports, and each public function's declared result type read from the stdlib's own sources) and `stdlib.sources.json`. Nothing is fetched while a program runs. |
| **Compile** | The compiler gets every stdlib module's real source, so imports type-check exactly as with `gleam build`. Only `main` is read back. Compiling with the whole stdlib takes about 50–130 ms. |
| **Link** (`src/tracer/link.ts`) | The program's `./gleam.mjs` and `./gleam/<module>.mjs` imports are cut out at parsed positions and pointed at small generated facades. Each facade re-exports one namespace of the bundle. Program and stdlib share one prelude instance. Any other import is refused. |
| **Run** | Real stdlib code runs. Stdlib code is never instrumented, so a stdlib call is one atomic step with no frame, while user functions keep their frames. |

### Which stdlib calls can be traced

A call `module.fn(...)` is traceable when `fn` is public and its declared result type is exactly `Int`, `Bool`, `String` or `Nil`. This is derived automatically from the stdlib sources; there is no hand-made list. It covers, for example:
- `io.println` and `io.print`;
- `int.to_string`, `int.max` and `int.absolute_value`;
- `string.uppercase`, `string.length`, `string.repeat` and `string.replace`;
- `bool.to_string`.

Results of type `Float` or a generic type (`a`) are refused, because Int and Float are both JS numbers at run time and the display would be wrong. So are results such as `List`, `Result`, `Option` and `Dict`, which can't be drawn yet. `int.random` is refused because it gives a different result on each run, which would break the check that compares the instrumented and uninstrumented runs.

### Print Output

| Aspect | Behaviour |
| --- | --- |
| **Capture** | The stdlib really runs. `io.println` / `io.println_error` reach `console.log` / `console.error`, and `io.print` / `io.print_error` reach `process.stdout` / `process.stderr`.write. The recorder captures both. In the browser, the execution worker has an output-only `process` stand-in (just `stdout.write` and `stderr.write`). Without it, the stdlib's browser fallback would add a newline after every `io.print`. With it, output is identical in Node, in the browser, and under `gleam run`. |
| **Ordering** | Output is recorded as events in the order it happens. Each step's Print Output is everything printed up to that step, so stepping backward hides later output and stepping forward shows it again, exactly once. |
| **stderr** | It goes into the same Print Output, interleaved. |
| **Limits** | 10,000 characters of output by default (hard ceiling 100,000); 10,000 characters per String value; 1,000,000 characters of String values per run. |
| **Differential check** | The instrumented run must print exactly what the uninstrumented run printed. |

## Browser runtime (Phase 2C)

```
page                                     <iframe sandbox="allow-scripts" srcdoc=…>   (opaque origin)
────                                     ────────────────────────────────────────
fetch toolchain (same origin), check  ─► CSP: default-src 'none'; script-src 'sha256-<host>' blob: 'wasm-unsafe-eval';
  each file's SHA-256 against                 worker-src blob:; connect-src 'none'
  tracer-node/toolchain.json             host.js
postMessage init / compile / execute       ├─ compile worker: official Gleam WASM compiler + stdlib sources (reused)
validate every reply (outcome.ts)  ◄──     └─ execution worker: NEW per run, terminated after it or on timeout;
                                               links the program to the stdlib bundle via blob: URLs
normalize + validateTrace in the page
```

- **Loading is lazy.** Nothing loads until the first real trace. The engine and its JavaScript parser are a separate chunk, and the 5 MB compiler is fetched only then. The exact `square(5)` demo uses the predefined Demo trace and never starts the sandbox.
- **Isolation:**
  - The iframe has an opaque origin, so it gets no cookies, storage or DOM access to the app.
  - Its CSP blocks all network connections.
  - The page never evaluates compiled code.
  - Code in the execution worker cannot `fetch`, open WebSockets, use IndexedDB or Cache Storage, or import from the server. The e2e suite checks each of these, with a control run in an unsandboxed worker.
- **Classic workers only.** Chrome refuses `blob:` module workers in an opaque-origin sandbox, but classic workers can still `import()` `blob:` modules. The compiled program and the prelude are loaded that way, so the recorder's `export` keywords are stripped for the browser copy.
- **Limits:**
  - *Wall clock:* the sandbox terminates the run worker. If the whole sandbox stops answering, the page discards it and builds a new one.
  - *Events and call depth:* enforced by the recorder.
  - *Messages:* every message from the sandbox is size- and shape-checked before use.
  - *Memory:* the browser has no worker heap limit. The subset (Int and Bool only) cannot allocate beyond its call stack, and that stack is bounded by the depth limit.

## Layout

| Path | Role |
| --- | --- |
| `src/tracer/runtime.ts` | `TracerRuntime` interface (compile + execute) and `parseDiagnostic` |
| `src/tracer/traceGleam.ts` | Pipeline: compile, subset check, instrument, run, differential check, normalize, validate |
| `src/tracer/subset.ts` / `instrument.ts` / `normalize.ts` / `events.ts` | Capability check and source anchors, JS alignment and instrumentation, raw events to `ExecutionTrace`, limits |
| `src/tracer/toTraceResult.ts` | Engine result to the UI's `TraceResult`, with student-facing messages |
| `src/tracer/browserRuntime.ts`, `realTracer.ts` | Browser `TracerRuntime` (sandbox) and the app's real tracer |
| `src/tracer/sandbox/` | Code that runs inside the sandbox: `host.js`, `compileWorker.js`, `runWorker.js`, and `recorder.js` (shared with Node) |
| `src/tracer/outcome.ts` | Validation of everything the sandbox sends back |
| `src/tracer/stdlib.ts`, `link.ts`, `toolchainFiles.ts` | Stdlib metadata and traceable-call rule; linking programs to the stdlib bundle; verified fetching of toolchain files |
| `tracer-node/audit.ts` | The example compatibility audit |
| `src/tracer/traceable.ts` | Computed "traceable" marking for the example dropdown |
| `tracer-node/nodeRuntime.ts` | `TracerRuntime` for Node (`compiler.ts` + `compile-worker.mjs`, `runner.ts` + `worker.mjs`) |
| `e2e/browser.e2e.test.ts` | Real-browser end-to-end and sandbox-boundary tests |

## Supported subset

- **Imports:** `import gleam/<module>` for any `gleam_stdlib` module. Unqualified imports (`.{...}`) and aliases (`as`) aren't supported yet.
- **Top level:** imports, then function definitions (`pub` optional). Requires `pub fn main()` with no parameters.
- **Types** (annotations optional): `Int`, `Bool`, `String`, `Nil`.
- **Function body:** statements, then one final expression, which is the function's value. A statement is either `let name = expr` or an expression evaluated for its effect, such as `io.println(x)`.
- **Expressions:**
  - literals: Int, `True`/`False`, `Nil`, and String, including escapes, Unicode and multi-line strings;
  - variables;
  - calls to this module's functions;
  - calls to traceable stdlib functions (see above);
  - `-x`, `!b`, `<>`, `+ - * / %`, `== != < > <= >=`, `&& ||`.
- **Also works:** shadowing, nested calls, and recursion that is not a tail call.

Everything else is refused with a located, plain-language message. That includes:
- `case` and blocks;
- anonymous functions and function captures;
- floats, lists, tuples and custom types;
- labelled arguments;
- `let assert`, `panic`, `todo`, `echo` and `use`;
- pipelines;
- self tail calls, which the compiler turns into loops.

The refusal names the first construct the parser can't handle. See `docs/PHASE_2D_COMPATIBILITY.md` for every library example.

## Results

| Status | Meaning |
| --- | --- |
| `ok` | trace |
| `compile_error` | official diagnostic with line and column |
| `unsupported` | names the feature and where it is |
| `runtime_error` | partial trace, with the error on its last step |
| `limit` | events, call depth, memory, trace size or source size |
| `timeout` | the run took too long |
| `internal_error` | a Gleam Tutor bug, never blamed on the student |

## Limits

- **Defaults:** 2 s, 5,000 events, call depth 500, 64 MB heap.
- **Hard ceilings,** which callers cannot exceed: 10 s, 50,000 events, call depth 2,000, 256 MB, 200,000 frame snapshots, and 20,000 characters of source.
- **Output and Strings:** printed output is 10,000 characters by default (ceiling 100,000). A single String value can be up to 10,000 characters, and a run can record 1,000,000 characters of String values in total.
