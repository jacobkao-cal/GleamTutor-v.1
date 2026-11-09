# Real Gleam tracing: engine, runtimes and tests

The tracing engine lives in `src/tracer/`. It is pure TypeScript, and an injected `TracerRuntime` compiles and runs programs. There are two runtimes:

| Runtime | Where | Used by |
| --- | --- | --- |
| **Browser** (`src/tracer/browserRuntime.ts`, Phase 2C) | sandboxed iframe + Web Workers | the app (`npm run dev`, production builds) |
| **Node** (`tracer-node/nodeRuntime.ts`) | worker threads | engine tests, the CLI |

Both runtimes use the same recorder (`src/tracer/sandbox/recorder.js`) and the same pinned official Gleam 1.19.2 compiler.

## Run it

```sh
npm install
npm run tracer:setup      # downloads the pinned compiler and JS prelude into tracer-node/.toolchain/ (SHA-256 checked)
                          # and copies the browser runtime's files into public/gleam-toolchain/1.19.2/
npm run dev               # the app: edited code is traced for real in the browser
npm run tracer:test       # engine tests (Node)
npm run build && npm run e2e   # real-browser end-to-end tests (system Google Chrome via puppeteer-core)
npm run tracer:typecheck
npm run tracer:trace -- tracer-node/samples/square7.gleam           # step table
npm run tracer:trace -- tracer-node/samples/square7.gleam --json    # full result: trace, raw events, compiled JS
```

If `tracer:setup` has not been run, the app still works. The Demo trace still plays, and any other program shows "Gleam Tutor hit an internal problem ... run: npm run tracer:setup".

## Browser runtime (Phase 2C)

```
page                                     <iframe sandbox="allow-scripts" srcdoc=…>   (opaque origin)
────                                     ────────────────────────────────────────
fetch toolchain (same origin), check  ─► CSP: default-src 'none'; script-src 'sha256-<host>' blob: 'wasm-unsafe-eval';
  each file's SHA-256 against                 worker-src blob:; connect-src 'none'
  tracer-node/toolchain.json             host.js
postMessage init / compile / execute       ├─ compile worker: official Gleam WASM compiler (reused)
validate every reply (outcome.ts)  ◄──     └─ execution worker: NEW per run, terminated after it or on timeout
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
| `src/tracer/traceable.ts` | Computed "traceable" marking for the example dropdown |
| `tracer-node/nodeRuntime.ts` | `TracerRuntime` for Node (`compiler.ts` + `compile-worker.mjs`, `runner.ts` + `worker.mjs`) |
| `e2e/browser.e2e.test.ts` | Real-browser end-to-end and sandbox-boundary tests |

## Supported subset

- **Top level:** function definitions only (`pub` optional). Requires `pub fn main()` with no parameters.
- **Types** (annotations optional): `Int`, `Bool`.
- **Function body:** `let name = expr` lines, then one final expression, which is the function's value.
- **Expressions:**
  - Int literals, `True`/`False`, and variables.
  - Calls to this module's functions.
  - `-x`, `!b`, `+ - * / %`, `== != < > <= >=`, `&& ||`.
- **Also works:** shadowing (`let x = x + 1`), nested calls, and recursion that is not a tail call.

Everything else is refused with a located, plain-language message, including:

- imports and the standard library;
- `case` and blocks;
- anonymous functions;
- strings, floats, lists, tuples and custom types;
- labelled arguments;
- `let assert`, `panic`, `todo`, `echo` and `use`;
- pipelines;
- self tail calls, which the compiler turns into loops.

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
