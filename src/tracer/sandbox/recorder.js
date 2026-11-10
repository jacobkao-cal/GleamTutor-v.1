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
const MAX_KEY_CHARS = 200_000;

export class TracerLimit extends Error {}

/**
 * The prelude's list classes, registered by the generated trace module (see
 * src/tracer/link.ts) when the instrumented program loads. Until then lists
 * are recognised by shape.
 */
let classes = null;
const isEmptyList = (v) => (classes ? v instanceof classes.Empty : v?.constructor?.name === "Empty" && typeof v.toArray === "function");
const isNonEmptyList = (v) =>
  classes ? v instanceof classes.NonEmpty : v?.constructor?.name === "NonEmpty" && typeof v.toArray === "function" && "head" in v;

/** Describes a value the tracer cannot display yet, e.g. "Float" or "custom type Some". */
function describeUnsupported(v) {
  if (typeof v === "number") return Number.isFinite(v) ? "Float" : "non-finite number";
  if (typeof v === "function") return "function";
  if (v === null) return "null";
  if (typeof v !== "object") return typeof v;
  const name = v.constructor?.name ?? "object";
  for (let p = Object.getPrototypeOf(v); p; p = Object.getPrototypeOf(p)) {
    if (classes ? p === classes.CustomType.prototype : p.constructor?.name === "CustomType") return `custom type ${name}`;
  }
  if (Array.isArray(v)) return "tuple";
  return name;
}

/**
 * Structural text for a value, the same for equal Gleam values in different
 * runs (list cells have no ids here). Used to compare the instrumented and
 * uninstrumented results.
 */
export function valueKey(v) {
  let out = "";
  const walk = (x) => {
    if (out.length > MAX_KEY_CHARS) return;
    if (isNonEmptyList(x) || isEmptyList(x)) {
      out += "[";
      for (let c = x; isNonEmptyList(c); c = c.tail) {
        walk(c.head);
        out += ",";
      }
      out += "]";
    } else if (typeof x === "string") out += JSON.stringify(x);
    else if (x === undefined) out += "Nil";
    else if (typeof x === "number" || typeof x === "boolean") out += String(x);
    else out += `<${describeUnsupported(x)}>`;
  };
  walk(v);
  return out;
}

export function describeError(e) {
  return e instanceof RangeError && /call stack|recursion/i.test(e.message)
    ? "Stack overflow (recursion too deep)"
    : `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`;
}

/** Returns { recorder, events, emit, value }. Throws TracerLimit past maxEvents / maxDepth / maxStdout. */
export function createRecorder(limits) {
  const events = [];
  let nextFrame = 1;
  let depth = 0;
  let printed = 0;
  let stringChars = 0;
  const nodeIds = new WeakMap();
  let nextNode = 1;
  /** Set by a tail-call marker: the next call to this function is a self tail call. */
  let pendingTail = null;
  const push = (e) => {
    if (events.length >= limits.maxEvents) throw new TracerLimit(`Trace is longer than ${limits.maxEvents} events`);
    events.push(e);
  };

  /** A value as recorded data. New list cells are recorded once, as `node` events. */
  const value = (v) => {
    if (typeof v === "number" && Number.isInteger(v)) return { kind: "int", value: String(v) };
    if (typeof v === "boolean") return { kind: "bool", value: v };
    if (typeof v === "string") {
      if (v.length > MAX_STRING_VALUE) throw new TracerLimit(`A String value is longer than ${MAX_STRING_VALUE} characters`);
      stringChars += v.length;
      if (stringChars > MAX_RECORDED_STRING_CHARS) throw new TracerLimit(`Recorded String values exceed ${MAX_RECORDED_STRING_CHARS} characters`);
      return { kind: "string", value: v };
    }
    if (v === undefined) return { kind: "nil" }; // Gleam's Nil is `undefined` on the JavaScript target
    if (isEmptyList(v)) return { kind: "list", node: null };
    if (isNonEmptyList(v)) {
      // Cells not seen before, front to back; stop at the first known cell or [].
      const fresh = [];
      let c = v;
      while (isNonEmptyList(c) && !nodeIds.has(c)) {
        fresh.push(c);
        c = c.tail;
      }
      // Record from the back, so every cell's tail is recorded before it.
      for (let i = fresh.length - 1; i >= 0; i--) {
        const cell = fresh[i];
        const head = value(cell.head);
        const id = nextNode++;
        nodeIds.set(cell, id);
        const tail = isNonEmptyList(cell.tail) ? nodeIds.get(cell.tail) : null;
        push({ t: "node", id, head, tail });
      }
      return { kind: "list", node: nodeIds.get(v) };
    }
    return { kind: "unsupported", jsType: describeUnsupported(v) };
  };

  /** The latest `call` or `match` event of `frame` (arguments and pattern variables attach to it). */
  const latest = (frame, t) => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.t === "node" || e.t === "out") continue;
      if (e.t === t && e.frame === frame) return e;
      break;
    }
    throw new Error(`internal: no ${t} event to attach to`);
  };

  const recorder = {
    useClasses(c) {
      classes = c;
    },
    call(fn, loc, args) {
      if (depth >= limits.maxDepth) throw new TracerLimit(`Call depth exceeded ${limits.maxDepth}`);
      const frame = nextFrame++;
      depth++;
      const tail = pendingTail !== null && pendingTail.fn === fn;
      pendingTail = null;
      push({ t: "call", frame, fn, loc, args: args.map(([n, v]) => [n, value(v)]), ...(tail ? { tail: true } : {}) });
      return frame;
    },
    /** A parameter of the latest call. */
    arg(frame, name, v) {
      const recorded = value(v);
      latest(frame, "call").args.push([name, recorded]);
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
    match(frame, caseId, loc) {
      push({ t: "match", frame, caseId, loc, binds: [] });
    },
    /** A pattern variable of the latest match. */
    pvar(frame, name, v) {
      const recorded = value(v);
      latest(frame, "match").binds.push([name, recorded]);
    },
    close(frame, caseId) {
      push({ t: "close", frame, caseId });
    },
    /** A block starts: its bindings end at the matching close. */
    open(frame, scopeId) {
      push({ t: "open", frame, scopeId });
    },
    /** The next call to `fn` is a self tail call that the compiled program runs as a loop. */
    tail(frame, fn) {
      pendingTail = { frame, fn };
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
  return { recorder, events, emit, value };
}

/**
 * Captures what the program prints. gleam_stdlib's io.println / io.println_error
 * call console.log / console.error (a newline is added, as a console does);
 * io.print writes to process.stdout where it exists. Returns a function that
 * restores the originals.
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
 * Creates every module of a linked program (see src/tracer/link.ts) in
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
 * Loads both programs, runs the uninstrumented one (baseline), then the
 * instrumented one with the recorder. `load(id)` imports a linked module.
 */
export async function runPrograms(load, program, limits, recorderSymbol) {
  const { recorder, events, emit, value } = createRecorder(limits);
  globalThis[Symbol.for(recorderSymbol)] = recorder;

  let original;
  let traced;
  try {
    // Loading the instrumented module first lets its trace module register the prelude's classes.
    traced = await load(program.instrumented);
    original = await load(program.original);
  } catch (e) {
    return { status: "internal_error", message: `Could not load the program: ${describeError(e)}` };
  }

  let baselineStdout = "";
  let restore = captureOutput((text) => {
    if (baselineStdout.length <= limits.maxStdout) baselineStdout += text;
  });
  let baselineKey;
  try {
    baselineKey = valueKey(original.main());
  } catch (e) {
    baselineKey = `<threw ${describeError(e)}>`;
  } finally {
    restore();
  }

  let stdout = "";
  restore = captureOutput((text) => {
    emit(text);
    stdout += text;
  });
  try {
    const main = traced.main();
    const result = value(main);
    return { status: "ok", events, result, resultKey: valueKey(main), baselineKey, stdout, baselineStdout };
  } catch (e) {
    return e instanceof TracerLimit
      ? { status: "limit", events, message: e.message }
      : { status: "runtime_error", events, message: describeError(e), stdout };
  } finally {
    restore();
  }
}
