/**
 * The only environment-specific part of the tracing engine.
 *
 * Everything else in src/tracer/ is pure TypeScript that runs unchanged in
 * Node and in a browser. A Runtime supplies the two things that are not pure:
 * running the official Gleam compiler, and executing the compiled JavaScript
 * in isolation with resource limits.
 *
 * Implementations:
 *  - tracer-node/nodeRuntime.ts: Node worker_threads (engine tests, CLI)
 *  - src/tracer/browserRuntime.ts: sandboxed iframe + Web Workers (the app)
 */
import type { RunLimits, RunOutcome } from "./events";
import type { ProgramFiles } from "./link";
import type { StdlibInfo } from "./stdlib";

export type { ProgramFiles } from "./link";

export interface Diagnostic {
  /** e.g. "Syntax error", "Type mismatch", "Unknown variable" */
  title: string;
  line?: number;
  column?: number;
  /** Full compiler message, unmodified. */
  message: string;
}

export type CompileOutput = { ok: true; js: string; warnings: string[] } | { ok: false; diagnostic: Diagnostic };

export interface TracerRuntime {
  /** Version of the official Gleam compiler this runtime uses. */
  readonly gleamVersion: string;
  /** Metadata of the pinned gleam_stdlib that compile() and execute() use. */
  loadStdlib(): Promise<StdlibInfo>;
  /** Compiles one module named `main` (with gleam_stdlib available) to JavaScript with the official compiler. */
  compile(source: string): Promise<CompileOutput>;
  /**
   * Links `program` to the stdlib bundle, then runs the baseline and the
   * instrumented program in a disposable, isolated context. Must enforce
   * `limits` itself (the caller has already clamped them).
   */
  execute(program: ProgramFiles, limits: RunLimits): Promise<RunOutcome>;
}

/** Parses the compiler's diagnostic text: "error: Title\n  ┌─ /src/main.gleam:LINE:COL". */
export function parseDiagnostic(text: string): Diagnostic {
  const title = /^error:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "Compile error";
  const loc = /┌─\s*\S+?\.gleam:(\d+):(\d+)/.exec(text);
  return { title, message: text.trim(), ...(loc ? { line: Number(loc[1]), column: Number(loc[2]) } : {}) };
}
