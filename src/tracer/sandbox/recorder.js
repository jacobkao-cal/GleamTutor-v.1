// Execution support shared VERBATIM by both runtimes:
//  - Node: imported by tracer-node/worker.mjs
//  - Browser: its text (minus `export` keywords) is prepended to runWorker.js
//    to form the sandboxed execution worker
// Plain JavaScript with no imports, so the same text runs in both places.
// It only observes values and output the compiled program produces; it never
// computes program values itself.

// Keep in step with src/tracer/events.ts.
const MAX_STRING_VALUE = 10_000;
const MAX_RECORDED_STRING_CHARS = 1_000_000;

export class TracerLimit extends Error {}

/** Describes a value the tracer cannot display yet, e.g. "List" or "custom type Some". */
function describeUnsupported(v) {
  if (typeof v === "number") return Number.isFinite(v) ? "Float" : "non-finite number";
  if (typeof v === "function") return "function";
  if (v === null) return "null";
  if (typeof v !== "object") return typeof v;
  const name = v.constructor?.name ?? "object";
  if (name === "Empty" || name === "NonEmpty") return "List";
  for (let p = Object.getPrototypeOf(v); p; p = Object.getPrototypeOf(p)) {
    if (p.constructor?.name === "CustomType") return `custom type ${name}`;
  }
  return name;
}

export function serializeValue(v) {
  if (typeof v === "number" && Number.isInteger(v)) return { kind: "int", value: String(v) };
  if (typeof v === "boolean") return { kind: "bool", value: v };
  if (typeof v === "string") {
    if (v.length > MAX_STRING_VALUE) throw new TracerLimit(`A String value is longer than ${MAX_STRING_VALUE} characters`);
    return { kind: "string", value: v };
  }
  if (v === undefined) return { kind: "nil" }; // Gleam's Nil is `undefined` on the JavaScript target
  return { kind: "unsupported", jsType: describeUnsupported(v) };
}

export function describeError(e) {
  return e instanceof RangeError && /call stack|recursion/i.test(e.message)
    ? "Stack overflow (recursion too deep)"
    : `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`;
}

/** Returns { recorder, events, emit }. Throws TracerLimit past maxEvents / maxDepth / maxStdout. */
export function createRecorder(limits) {
  const events = [];
  let nextFrame = 1;
  let depth = 0;
  let printed = 0;
  let stringChars = 0;
  /** serializeValue plus the run-wide budget for recorded String values. */
  const value = (v) => {
    const s = serializeValue(v);
    if (s.kind === "string") {
      stringChars += s.value.length;
      if (stringChars > MAX_RECORDED_STRING_CHARS) throw new TracerLimit(`Recorded String values exceed ${MAX_RECORDED_STRING_CHARS} characters`);
    }
    return s;
  };
  const push = (e) => {
    if (events.length >= limits.maxEvents) throw new TracerLimit(`Trace is longer than ${limits.maxEvents} events`);
    events.push(e);
  };
  const recorder = {
    call(fn, loc, args) {
      if (depth >= limits.maxDepth) throw new TracerLimit(`Call depth exceeded ${limits.maxDepth}`);
      const frame = nextFrame++;
      depth++;
      push({ t: "call", frame, fn, loc, args: args.map(([n, v]) => [n, value(v)]) });
      return frame;
    },
    line(frame, loc) {
      push({ t: "line", frame, loc });
    },
    bind(frame, name, v, loc) {
      push({ t: "bind", frame, name, value: value(v), loc });
    },
    done(frame, loc) {
      push({ t: "done", frame, loc });
    },
    ret(frame, v, loc) {
      push({ t: "return", frame, value: value(v), loc });
      depth--;
      return v; // must not change the program's value
    },
  };
  /** Records printed text as an event, so output can be placed at the right step. */
  const emit = (text) => {
    printed += text.length;
    if (printed > limits.maxStdout) throw new TracerLimit(`Printed output is longer than ${limits.maxStdout} characters`);
    push({ t: "out", text });
  };
  return { recorder, events, emit };
}

/**
 * Captures what the program prints. gleam_stdlib's io.println / io.println_error
 * call console.log / console.error (a newline is added, as a console does);
 * io.print writes to process.stdout where it exists (Node) and otherwise uses
 * console.log. Returns a function that restores the originals.
 */
function captureOutput(sink) {
  const restore = [];
  const patch = (obj, key, fn) => {
    if (!obj || typeof obj[key] !== "function") return;
    const original = obj[key];
    obj[key] = fn;
    restore.push(() => (obj[key] = original));
  };
  const line = (...args) => sink(args.map(String).join(" ") + "\n");
  patch(console, "log", line);
  patch(console, "error", line);
  if (typeof process === "object" && process) {
    patch(process.stdout, "write", (chunk) => (sink(String(chunk)), true));
    patch(process.stderr, "write", (chunk) => (sink(String(chunk)), true));
  }
  return () => restore.reverse().forEach((r) => r());
}

/**
 * Creates every module of a linked program (see src/tracer/stdlib.ts) in
 * order: each module's import holes are filled with the URLs of modules
 * created before it. `urls` starts with the stdlib bundle's URL.
 */
export function linkModules(modules, urls, makeUrl) {
  for (const m of modules) {
    let code = m.parts[0];
    for (let i = 0; i < m.deps.length; i++) {
      const url = urls[m.deps[i]];
      if (!url) throw new Error(`Unknown module ${m.deps[i]}`);
      code += JSON.stringify(url) + m.parts[i + 1];
    }
    urls[m.id] = makeUrl(m.id, code);
  }
  return urls;
}

/**
 * Runs the uninstrumented program (baseline), then the instrumented one with
 * the recorder. `load(id)` imports a linked module and returns its namespace.
 */
export async function runPrograms(load, program, limits, recorderSymbol) {
  const { recorder, events, emit } = createRecorder(limits);
  globalThis[Symbol.for(recorderSymbol)] = recorder;

  let baselineStdout = "";
  let restore = captureOutput((text) => {
    if (baselineStdout.length <= limits.maxStdout) baselineStdout += text;
  });
  let baselineResult;
  try {
    baselineResult = serializeValue((await load(program.original)).main());
  } catch (e) {
    baselineResult = { kind: "unsupported", jsType: `threw ${describeError(e)}` };
  } finally {
    restore();
  }

  let traced;
  try {
    traced = await load(program.instrumented);
  } catch (e) {
    return { status: "internal_error", message: `Could not load the instrumented program: ${describeError(e)}` };
  }
  let stdout = "";
  restore = captureOutput((text) => {
    emit(text);
    stdout += text;
  });
  try {
    const result = serializeValue(traced.main());
    return { status: "ok", events, result, baselineResult, stdout, baselineStdout };
  } catch (e) {
    return e instanceof TracerLimit
      ? { status: "limit", events, message: e.message }
      : { status: "runtime_error", events, message: describeError(e), stdout };
  } finally {
    restore();
  }
}
