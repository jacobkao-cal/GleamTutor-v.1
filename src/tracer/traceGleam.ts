/**
 * The Phase 2B tracing engine pipeline:
 *
 *   Gleam source -> official compiler (Runtime) -> subset check + source anchors
 *   -> instrumentation -> isolated execution (Runtime) -> raw events
 *   -> differential check -> normalized ExecutionTrace -> validateTrace
 *
 * Pure orchestration: no Node or browser APIs. Never fabricates events: every
 * value in a trace was observed in the compiled program while it ran.
 */
import type { ExecutionTrace } from "../trace/types";
import { validateTrace } from "../trace/validate";
import { clampLimits, type RawEvent, type RawValue, type RunLimits } from "./events";
import { AlignmentError, instrument } from "./instrument";
import { NormalizeError, NormalizeLimitError, normalize } from "./normalize";
import type { Diagnostic, TracerRuntime } from "./runtime";
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

  // 0. Imports are refused before compiling: the engine gives the compiler no
  //    standard library yet, so it would wrongly report valid imports as errors.
  const importLine = source.split("\n").findIndex((l) => /^\s*import\s/.test(l)) + 1;
  if (importLine > 0) {
    const feature = "Imports (e.g. gleam/io)";
    return { status: "unsupported", feature, line: importLine, column: 1, message: `${feature} (line ${importLine}, column 1) is not supported by the tracer yet` };
  }

  // 1. The official compiler decides validity; its diagnostics win.
  let compiled;
  try {
    compiled = await runtime.compile(source);
  } catch (e) {
    return { status: "internal_error", message: `Compiler failed: ${describe(e)}` };
  }
  if (!compiled.ok) return { status: "compile_error", diagnostic: compiled.diagnostic };

  // 2. Capability check + source anchors (only after the compiler accepted the program).
  let module: SubsetModule;
  try {
    module = parseSubset(source);
  } catch (e) {
    if (e instanceof UnsupportedError) return { status: "unsupported", feature: e.feature, line: e.line, column: e.column, message: e.message };
    return { status: "internal_error", message: `Subset check failed: ${describe(e)}` };
  }

  // 3. Align the compiled JS with the source, then instrument. A mismatch is refused, never guessed.
  let instrumentedJs: string;
  try {
    instrumentedJs = instrument(compiled.js, module);
  } catch (e) {
    if (e instanceof AlignmentError) {
      return { status: "unsupported", feature: "Compiled code shape", message: `Could not map the compiled code back to the source (${e.message})` };
    }
    return { status: "internal_error", message: `Instrumentation failed: ${describe(e)}` };
  }

  // 4. Run in isolation. Limits are clamped to the hard ceilings here AND by the runtime.
  let run;
  try {
    run = await runtime.execute({ instrumented: instrumentedJs, original: compiled.js }, clampLimits(limits));
  } catch (e) {
    return { status: "internal_error", message: `Execution failed: ${describe(e)}` };
  }
  if (run.status === "timeout" || run.status === "internal_error" || run.status === "limit") return run;

  try {
    if (run.status === "runtime_error") {
      const trace = run.events.length ? normalize(source, module, run.events, { kind: "runtime", message: run.message }) : null;
      return { status: "runtime_error", message: run.message, events: run.events, trace };
    }
    // 5. Differential check: instrumentation must not change the program's result.
    if (JSON.stringify(run.result) !== JSON.stringify(run.baselineResult)) {
      return {
        status: "internal_error",
        message: `Instrumented result ${JSON.stringify(run.result)} differs from uninstrumented ${JSON.stringify(run.baselineResult)}`,
      };
    }
    if (run.result.kind === "unsupported") {
      return { status: "unsupported", feature: "main's result type", message: "main() returned a value outside the supported subset (Int or Bool)" };
    }
    const trace = normalize(source, module, run.events);
    const problems = validateTrace(trace, source);
    if (problems.length) return { status: "internal_error", message: `Invalid trace: ${problems.join("; ")}` };
    return { status: "ok", trace, events: run.events, result: run.result, compiledJs: compiled.js, instrumentedJs, gleamVersion: runtime.gleamVersion };
  } catch (e) {
    if (e instanceof NormalizeError) return { status: "unsupported", feature: "Recorded value", message: e.message };
    if (e instanceof NormalizeLimitError) return { status: "limit", message: e.message, events: [] };
    return { status: "internal_error", message: `Normalization failed: ${describe(e)}` };
  }
}
