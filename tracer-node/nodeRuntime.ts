/**
 * TracerRuntime for Node: the official Gleam WASM compiler in a worker thread,
 * and execution in a disposable, resource-limited worker thread.
 *
 * Node worker threads are not a security sandbox. This runtime is for tests,
 * the CLI and the local development preview only (see README.md).
 */
import { clampLimits } from "../src/tracer/events";
import type { TracerRuntime } from "../src/tracer/runtime";
import { compileGleam, GLEAM_VERSION } from "./compiler";
import { runInWorker } from "./runner";

export const nodeRuntime: TracerRuntime = {
  gleamVersion: GLEAM_VERSION,
  compile: compileGleam,
  execute: (program, limits) => runInWorker(program, clampLimits(limits)),
};
