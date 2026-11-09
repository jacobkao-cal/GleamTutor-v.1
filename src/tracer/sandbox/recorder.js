// Execution recorder, shared VERBATIM by both runtimes:
//  - Node: imported by tracer-node/worker.mjs
//  - Browser: its text is prepended to runWorker.js to form the sandboxed execution worker
// Plain JavaScript with no imports, so the same text runs in both places.
// It only observes values the compiled program computes; it never computes values.

export function serializeValue(v) {
  if (typeof v === "number" && Number.isInteger(v)) return { kind: "int", value: String(v) };
  if (typeof v === "boolean") return { kind: "bool", value: v };
  return { kind: "unsupported", jsType: typeof v };
}

export function describeError(e) {
  return e instanceof RangeError && /call stack|recursion/i.test(e.message)
    ? "Stack overflow (recursion too deep)"
    : `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`;
}

export class TracerLimit extends Error {}

/** Returns { recorder, events }. The recorder throws TracerLimit past maxEvents / maxDepth. */
export function createRecorder(limits) {
  const events = [];
  let nextFrame = 1;
  let depth = 0;
  const push = (e) => {
    if (events.length >= limits.maxEvents) throw new TracerLimit(`Trace is longer than ${limits.maxEvents} events`);
    events.push(e);
  };
  const recorder = {
    call(fn, loc, args) {
      if (depth >= limits.maxDepth) throw new TracerLimit(`Call depth exceeded ${limits.maxDepth}`);
      const frame = nextFrame++;
      depth++;
      push({ t: "call", frame, fn, loc, args: args.map(([n, v]) => [n, serializeValue(v)]) });
      return frame;
    },
    line(frame, loc) {
      push({ t: "line", frame, loc });
    },
    bind(frame, name, value, loc) {
      push({ t: "bind", frame, name, value: serializeValue(value), loc });
    },
    ret(frame, value, loc) {
      push({ t: "return", frame, value: serializeValue(value), loc });
      depth--;
      return value; // must not change the program's value
    },
  };
  return { recorder, events };
}

/**
 * Runs the baseline module, then the instrumented one with the recorder.
 * `load(name)` imports a module ("original" | "instrumented") and returns it.
 */
export async function runPrograms(load, limits, recorderSymbol) {
  const { recorder, events } = createRecorder(limits);
  globalThis[Symbol.for(recorderSymbol)] = recorder;
  let stdout = "";
  const realLog = console.log;
  console.log = (...args) => {
    stdout = (stdout + args.map(String).join(" ") + "\n").slice(0, limits.maxStdout);
  };
  try {
    let baselineResult;
    try {
      baselineResult = serializeValue((await load("original")).main());
    } catch (e) {
      baselineResult = { kind: "unsupported", jsType: `threw ${describeError(e)}` };
    }
    const traced = await load("instrumented");
    try {
      const result = serializeValue(traced.main());
      return { status: "ok", events, result, baselineResult, stdout };
    } catch (e) {
      return e instanceof TracerLimit
        ? { status: "limit", events, message: e.message }
        : { status: "runtime_error", events, message: describeError(e), stdout };
    }
  } catch (e) {
    return { status: "internal_error", message: describeError(e) };
  } finally {
    console.log = realLog;
  }
}
