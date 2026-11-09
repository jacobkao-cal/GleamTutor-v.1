/**
 * Validates messages coming back from the execution sandbox before the page
 * uses them. Whatever crosses the sandbox boundary is untrusted: the page
 * checks its shape AND bounds its size (the Phase 2A host out-of-memory
 * lesson), and never trusts a count or length it did not check.
 */
import { MAX_RECORDED_STRING_CHARS, MAX_STRING_VALUE, type RawEvent, type RawLoc, type RawValue, type RunLimits, type RunOutcome } from "./events";

const MAX_TEXT = 100_000;
const MAX_NAME = 200;
const MAX_ARGS = 255;

const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
const isText = (x: unknown, max = MAX_TEXT): x is string => typeof x === "string" && x.length <= max;

function isLoc(x: unknown): x is RawLoc {
  return Array.isArray(x) && x.length === 4 && x.every((n) => isInt(n) && n >= 0 && n < 1_000_000);
}

function isValue(x: unknown): x is RawValue {
  const v = x as RawValue;
  if (!v || typeof v !== "object") return false;
  if (v.kind === "int") return isText(v.value, 400) && /^-?\d+$/.test(v.value);
  if (v.kind === "bool") return typeof v.value === "boolean";
  if (v.kind === "string") return isText(v.value, MAX_STRING_VALUE);
  if (v.kind === "nil") return true;
  if (v.kind === "unsupported") return isText(v.jsType, MAX_NAME);
  return false;
}

function isEvent(x: unknown, limits: RunLimits): x is RawEvent {
  const e = x as RawEvent;
  if (e && typeof e === "object" && e.t === "out") return isText(e.text, limits.maxStdout);
  if (!e || typeof e !== "object" || !isInt(e.frame) || e.frame < 1 || !isLoc(e.loc)) return false;
  switch (e.t) {
    case "call":
      return (
        isText(e.fn, MAX_NAME) &&
        Array.isArray(e.args) &&
        e.args.length <= MAX_ARGS &&
        e.args.every((a) => Array.isArray(a) && a.length === 2 && isText(a[0], MAX_NAME) && isValue(a[1]))
      );
    case "line":
    case "done":
      return true;
    case "bind":
      return isText(e.name, MAX_NAME) && isValue(e.value);
    case "return":
      return isValue(e.value);
    default:
      return false;
  }
}

function isEvents(x: unknown, limits: RunLimits): x is RawEvent[] {
  // Check the length BEFORE walking the array.
  if (!Array.isArray(x) || x.length > limits.maxEvents || !x.every((e) => isEvent(e, limits))) return false;
  // Printed text in total is bounded too, not just each piece.
  let printed = 0;
  let stringChars = 0;
  const count = (v: RawValue) => {
    if (v.kind === "string") stringChars += v.value.length;
  };
  for (const e of x as RawEvent[]) {
    if (e.t === "out") printed += e.text.length;
    else if (e.t === "bind" || e.t === "return") count(e.value);
    else if (e.t === "call") e.args.forEach(([, v]) => count(v));
  }
  return printed <= limits.maxStdout && stringChars <= MAX_RECORDED_STRING_CHARS;
}

/** Returns the outcome if it is well formed and within limits, otherwise null. */
export function validateRunOutcome(x: unknown, limits: RunLimits): RunOutcome | null {
  const o = x as RunOutcome;
  if (!o || typeof o !== "object") return null;
  switch (o.status) {
    case "ok":
      return isEvents(o.events, limits) &&
        isValue(o.result) &&
        isValue(o.baselineResult) &&
        isText(o.stdout, limits.maxStdout) &&
        isText(o.baselineStdout, limits.maxStdout + MAX_TEXT)
        ? { status: "ok", events: o.events, result: o.result, baselineResult: o.baselineResult, stdout: o.stdout, baselineStdout: o.baselineStdout }
        : null;
    case "runtime_error":
      return isEvents(o.events, limits) && isText(o.message) && isText(o.stdout, limits.maxStdout)
        ? { status: "runtime_error", events: o.events, message: o.message, stdout: o.stdout }
        : null;
    case "limit":
      return isEvents(o.events, limits) && isText(o.message) ? { status: "limit", events: o.events, message: o.message } : null;
    case "timeout":
    case "internal_error":
      return isText(o.message) ? { status: o.status, message: o.message } : null;
    default:
      return null;
  }
}

/** Validates a compile reply: { ok: true, js, warnings } | { ok: false, error }. */
export function validateCompileReply(x: unknown): { ok: true; js: string; warnings: string[] } | { ok: false; error: string } | null {
  const r = x as { ok?: unknown; js?: unknown; warnings?: unknown; error?: unknown };
  if (!r || typeof r !== "object") return null;
  if (r.ok === true && isText(r.js, 2_000_000) && Array.isArray(r.warnings) && r.warnings.length <= 1000 && r.warnings.every((w) => isText(w))) {
    return { ok: true, js: r.js, warnings: r.warnings as string[] };
  }
  if (r.ok === false && isText(r.error)) return { ok: false, error: r.error };
  return null;
}
