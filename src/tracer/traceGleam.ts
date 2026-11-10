/**
 * The Phase 2B tracing engine pipeline:
 *
 *   Gleam source -> official compiler, with gleam_stdlib (Runtime)
 *   -> subset check + source regions -> probe-instrumented Gleam source
 *   -> official compiler again -> link both programs to the stdlib
 *   -> isolated execution (Runtime) -> raw events + printed output
 *   -> differential check -> normalized ExecutionTrace -> validateTrace
 *
 * Pure orchestration: no Node or browser APIs. Never fabricates events: every
 * value in a trace was observed in the compiled program while it ran.
 */
import type { ExecutionTrace } from "../trace/types";
import { validateTrace } from "../trace/validate";
import { clampLimits, type RawEvent, type RawValue, type RunLimits } from "./events";
import { instrumentSource, loopFunctionsIn } from "./instrument";
import { NormalizeError, NormalizeLimitError, normalize } from "./normalize";
import type { Diagnostic, TracerRuntime } from "./runtime";
import { LinkError, linkProgram } from "./link";
import type { StdlibInfo } from "./stdlib";
import { parseSubset, UnsupportedError, type SubsetModule } from "./subset";

/** Largest source accepted, in characters (the host bounds its own work too). */
export const MAX_SOURCE_CHARS = 20_000;

export type EngineResult =
  | {
      status: "ok";
      trace: ExecutionTrace;
      events: RawEvent[];
      /** Value of main(), from the instrumented run. */
      result: RawValue;
      compiledJs: string;
      /** The probe-instrumented Gleam source (instrument.ts). */
      instrumentedSource: string;
      instrumentedJs: string;
      gleamVersion: string;
    }
  | { status: "compile_error"; diagnostic: Diagnostic }
  | { status: "unsupported"; feature: string; line?: number; column?: number; message: string }
  | { status: "runtime_error"; message: string; events: RawEvent[]; trace: ExecutionTrace | null }
  | { status: "limit"; message: string; events: RawEvent[] }
  | { status: "timeout"; message: string }
  | { status: "internal_error"; message: string };

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function traceGleam(
  source: string,
  runtime: TracerRuntime,
  limits: Partial<RunLimits> = {},
): Promise<EngineResult> {
  if (source.length > MAX_SOURCE_CHARS) {
    return { status: "limit", message: `Program is longer than ${MAX_SOURCE_CHARS} characters`, events: [] };
  }

  // 1. The official compiler (with the real gleam_stdlib) decides validity; its diagnostics win.
  let compiled;
  let stdlib: StdlibInfo;
  try {
    compiled = await runtime.compile(source);
    stdlib = await runtime.loadStdlib();
  } catch (e) {
    return { status: "internal_error", message: `Compiler failed: ${describe(e)}` };
  }
  if (!compiled.ok) return { status: "compile_error", diagnostic: compiled.diagnostic };

  // 2. Capability check + source anchors (only after the compiler accepted the program).
  let module: SubsetModule;
  try {
    module = parseSubset(source, { stdlib });
  } catch (e) {
    if (e instanceof UnsupportedError) return { status: "unsupported", feature: e.feature, line: e.line, column: e.column, message: e.message };
    return { status: "internal_error", message: `Subset check failed: ${describe(e)}` };
  }

  // 3. Instrument the Gleam source with probes and compile it with the same official compiler.
  let instrumentedJs: string;
  let instrumentedSource: string;
  try {
    instrumentedSource = instrumentSource(source, module, { loopFunctions: loopFunctionsIn(compiled.js) });
    const again = await runtime.compile(instrumentedSource);
    if (!again.ok) {
      return { status: "internal_error", message: `The instrumented program did not compile (${again.diagnostic.title}, line ${again.diagnostic.line ?? "?"})` };
    }
    instrumentedJs = again.js;
  } catch (e) {
    return { status: "internal_error", message: `Instrumentation failed: ${describe(e)}` };
  }

  // 4. Link both programs to the stdlib bundle, then run in isolation.
  //    Limits are clamped to the hard ceilings here AND by the runtime.
  let program;
  try {
    program = linkProgram(compiled.js, instrumentedJs, stdlib);
  } catch (e) {
    if (e instanceof LinkError) return { status: "unsupported", feature: "Compiled code shape", message: `Could not link the compiled code (${e.message})` };
    return { status: "internal_error", message: `Linking failed: ${describe(e)}` };
  }
  let run;
  try {
    run = await runtime.execute(program, clampLimits(limits));
  } catch (e) {
    return { status: "internal_error", message: `Execution failed: ${describe(e)}` };
  }
  if (run.status === "timeout" || run.status === "internal_error" || run.status === "limit") return run;

  try {
    if (run.status === "runtime_error") {
      const trace = run.events.length ? normalize(source, module, run.events, { kind: "runtime", message: run.message }) : null;
      return { status: "runtime_error", message: run.message, events: run.events, trace };
    }
    // 5. Differential check: instrumentation must not change the program's result or output.
    if (run.resultKey !== run.baselineKey) {
      return {
        status: "internal_error",
        message: `Instrumented result ${run.resultKey.slice(0, 200)} differs from uninstrumented ${run.baselineKey.slice(0, 200)}`,
      };
    }
    if (run.stdout !== run.baselineStdout) {
      return { status: "internal_error", message: "The instrumented program printed different output from the uninstrumented one" };
    }
    if (run.result.kind === "unsupported") {
      return {
        status: "unsupported",
        feature: `A main() result of type ${run.result.jsType}`,
        message: `main() returned a ${run.result.jsType} value, which can't be shown yet`,
      };
    }
    const trace = normalize(source, module, run.events);
    const problems = validateTrace(trace, source);
    if (problems.length) return { status: "internal_error", message: `Invalid trace: ${problems.join("; ")}` };
    return {
      status: "ok",
      trace,
      events: run.events,
      result: run.result,
      compiledJs: compiled.js,
      instrumentedSource,
      instrumentedJs,
      gleamVersion: runtime.gleamVersion,
    };
  } catch (e) {
    if (e instanceof NormalizeError) return { status: "unsupported", feature: "Recorded value", message: e.message };
    if (e instanceof NormalizeLimitError) return { status: "limit", message: e.message, events: [] };
    return { status: "internal_error", message: `Normalization failed: ${describe(e)}` };
  }
}
