/**
 * Source-level instrumentation (Phase 3A).
 *
 * The program is instrumented in GLEAM, then compiled by the official
 * compiler like any other program. Each region the recogniser recorded
 * (subset.ts) is wrapped with calls to "probe" functions, declared at the end
 * of the module as typed @external functions:
 *
 *   fn body      let gleam_tutor_frame = gleam_tutor_enter("f", loc) + one gleam_tutor_arg per parameter
 *   let x = e    gleam_tutor_line(...)  let x = e  gleam_tutor_bind(..., "x", x, ...)
 *   e (stmt)     gleam_tutor_line(...)  e  gleam_tutor_done(...)
 *   final e      gleam_tutor_line(...)  gleam_tutor_ret(..., e)
 *   case ...     gleam_tutor_close(..., id, case ...)
 *   p -> body    p -> { gleam_tutor_match(..., id, loc)  gleam_tutor_pvar(..., "v", v)...  body }
 *   { ... }      gleam_tutor_close(..., id, { gleam_tutor_open(..., id)  { ... } })
 *   f(a, b)      f(a, gleam_tutor_tail(..., "f", b))   for a self tail call in a function the
 *                compiler turned into a loop (marks the next call as a logical tail-call frame)
 *
 * Why the source and not the compiled JavaScript: the compiler turns `case`
 * into a decision tree that reorders clauses, merges or rewrites clause
 * bodies, and turns self tail calls into loops, so compiled branches cannot
 * be mapped back to clauses reliably. A probe inside a clause body runs
 * exactly when that clause is selected, however the tree is arranged.
 *
 * Every probe is an identity or a Nil-returning observer: `ret` and `close`
 * return their argument unchanged, so the program computes the same values.
 * The pipeline checks this on every run: the instrumented program's result
 * and output must equal the uninstrumented program's.
 *
 * Locations are passed as Int literals taken from the ORIGINAL source, so
 * the inserted text never shifts what the trace reports.
 */
import type { Loc, Region, SubsetModule } from "./subset";

/** The module the probe externals come from; link.ts supplies it. */
export const TRACE_MODULE_SPECIFIER = "./gleam_tutor_trace.mjs";

const FRAME = "gleam_tutor_frame";

export interface InstrumentOptions {
  /**
   * Functions the official compiler turned into loops (self tail calls). Only
   * their tail call sites are marked, so a frame is labelled a tail call only
   * when the compiled program really reuses the caller's frame.
   */
  loopFunctions?: Set<string>;
}
const loc = (l: Loc) => `${l.line}, ${l.column}, ${l.endLine}, ${l.endColumn}`;
const str = (s: string) => JSON.stringify(s); // Gleam string literal for an identifier (ASCII only)

function prefix(r: Region, o: InstrumentOptions): string {
  switch (r.kind) {
    case "fnbody":
      return (
        `\n  let ${FRAME} = gleam_tutor_enter(${str(r.name!)}, ${loc(r.loc)})\n` +
        (r.vars ?? []).map((v) => `  gleam_tutor_arg(${FRAME}, ${str(v)}, ${v})\n`).join("")
      );
    case "let":
    case "expr":
      return `gleam_tutor_line(${FRAME}, ${loc(r.loc)})\n  `;
    case "tail":
      return `gleam_tutor_line(${FRAME}, ${loc(r.loc)})\n  gleam_tutor_ret(${FRAME}, ${loc(r.loc)}, `;
    case "case":
      return `gleam_tutor_close(${FRAME}, ${r.caseId}, `;
    case "clause":
      return (
        `{\n gleam_tutor_match(${FRAME}, ${r.caseId}, ${loc(r.loc)})\n` +
        (r.vars ?? []).map((v) => ` gleam_tutor_pvar(${FRAME}, ${str(v)}, ${v})\n`).join("")
      );
    case "block":
      return `gleam_tutor_close(${FRAME}, ${r.caseId}, {\n gleam_tutor_open(${FRAME}, ${r.caseId})\n`;
    case "tailarg":
      return o.loopFunctions?.has(r.name!) ? `gleam_tutor_tail(${FRAME}, ${str(r.name!)}, ` : "";
    case "tailcall0":
      return o.loopFunctions?.has(r.name!) ? `{\n gleam_tutor_tail(${FRAME}, ${str(r.name!)}, Nil)\n` : "";
    case "plain":
      return "";
  }
}

function suffix(r: Region, o: InstrumentOptions): string {
  switch (r.kind) {
    case "let":
      return r.name ? `\n  gleam_tutor_bind(${FRAME}, ${str(r.name)}, ${r.name}, ${loc(r.loc)})` : `\n  gleam_tutor_done(${FRAME}, ${loc(r.loc)})`;
    case "expr":
      return `\n  gleam_tutor_done(${FRAME}, ${loc(r.loc)})`;
    case "tail":
    case "case":
      return ")";
    case "clause":
      return "\n}";
    case "block":
      return "\n})";
    case "tailarg":
      return o.loopFunctions?.has(r.name!) ? ")" : "";
    case "tailcall0":
      return o.loopFunctions?.has(r.name!) ? "\n}" : "";
    default:
      return "";
  }
}

function render(source: string, regions: Region[], start: number, end: number, o: InstrumentOptions): string {
  let out = "";
  let at = start;
  for (const r of regions) {
    out += source.slice(at, r.start) + prefix(r, o) + render(source, r.children, r.start, r.end, o) + suffix(r, o);
    at = r.end;
  }
  return out + source.slice(at, end);
}

/** The probe functions, appended to the instrumented module. */
const EXTERNALS = `

// ---- Gleam Tutor probes (added by the tracer; not part of the student's program) ----
@external(javascript, "${TRACE_MODULE_SPECIFIER}", "enter")
fn gleam_tutor_enter(name: String, l: Int, c: Int, el: Int, ec: Int) -> Int
@external(javascript, "${TRACE_MODULE_SPECIFIER}", "arg")
fn gleam_tutor_arg(frame: Int, name: String, value: a) -> Nil
@external(javascript, "${TRACE_MODULE_SPECIFIER}", "line")
fn gleam_tutor_line(frame: Int, l: Int, c: Int, el: Int, ec: Int) -> Nil
@external(javascript, "${TRACE_MODULE_SPECIFIER}", "bind")
fn gleam_tutor_bind(frame: Int, name: String, value: a, l: Int, c: Int, el: Int, ec: Int) -> Nil
@external(javascript, "${TRACE_MODULE_SPECIFIER}", "done")
fn gleam_tutor_done(frame: Int, l: Int, c: Int, el: Int, ec: Int) -> Nil
@external(javascript, "${TRACE_MODULE_SPECIFIER}", "ret")
fn gleam_tutor_ret(frame: Int, l: Int, c: Int, el: Int, ec: Int, value: a) -> a
@external(javascript, "${TRACE_MODULE_SPECIFIER}", "match")
fn gleam_tutor_match(frame: Int, case_id: Int, l: Int, c: Int, el: Int, ec: Int) -> Nil
@external(javascript, "${TRACE_MODULE_SPECIFIER}", "pvar")
fn gleam_tutor_pvar(frame: Int, name: String, value: a) -> Nil
@external(javascript, "${TRACE_MODULE_SPECIFIER}", "close")
fn gleam_tutor_close(frame: Int, case_id: Int, value: a) -> a
@external(javascript, "${TRACE_MODULE_SPECIFIER}", "open")
fn gleam_tutor_open(frame: Int, scope_id: Int) -> Nil
@external(javascript, "${TRACE_MODULE_SPECIFIER}", "tail")
fn gleam_tutor_tail(frame: Int, callee: String, value: a) -> a
`;

/** The instrumented Gleam source for a program the recogniser accepted. */
export function instrumentSource(source: string, module: SubsetModule, options: InstrumentOptions = {}): string {
  const regions = module.functions.map((f) => f.region);
  return render(source, regions, 0, source.length, options) + EXTERNALS;
}

/**
 * Names of the functions the official compiler compiled to a loop: their
 * parameters are renamed `loop$...` and the body is a `while (true)` loop.
 * Read from the uninstrumented compiled JavaScript.
 */
export function loopFunctionsIn(compiledJs: string): Set<string> {
  const out = new Set<string>();
  const re = /function ([A-Za-z_][\w]*\$?)\(([^)]*)\)\s*\{\s*while \(true\) \{/g;
  for (let m = re.exec(compiledJs); m; m = re.exec(compiledJs)) {
    const params = m[2].split(",").map((x) => x.trim()).filter(Boolean);
    if (params.every((x) => x.startsWith("loop$"))) out.add(m[1].replace(/\$$/, ""));
  }
  return out;
}
