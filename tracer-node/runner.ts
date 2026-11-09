/**
 * Executes compiled Gleam JavaScript in a disposable worker thread with
 * resource limits. Node's worker_threads stand in for a browser Web Worker
 * here. Neither is a security sandbox on its own; see the architecture
 * report. Used for engine tests and the CLI; not a production runtime.
 */
import path from "node:path";
import { Worker } from "node:worker_threads";
import { TOOLCHAIN_DIR } from "./compiler";
import { clampLimits, type RunLimits, type RunOutcome } from "../src/tracer/events";
import { RECORDER_SYMBOL } from "../src/tracer/instrument";
import type { ProgramFiles } from "../src/tracer/runtime";

const WORKER_URL = new URL("./worker.mjs", import.meta.url);

export function runInWorker(program: ProgramFiles, limits: Partial<RunLimits> = {}): Promise<RunOutcome> {
  const lim: RunLimits = clampLimits(limits); // never above MAX_LIMITS
  const bundlePath = path.join(TOOLCHAIN_DIR, "stdlib.bundle.mjs");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };
    const worker = new Worker(WORKER_URL, {
      workerData: { program, bundlePath, limits: lim, recorderSymbol: RECORDER_SYMBOL },
      resourceLimits: { maxOldGenerationSizeMb: lim.maxHeapMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true, // keep the worker's own console away from ours
      stderr: true,
      env: {}, // no environment variables
    });
    const timer = setTimeout(
      () => finish({ status: "timeout", message: `Execution took longer than ${lim.timeoutMs} ms and was stopped` }),
      lim.timeoutMs,
    );
    worker.once("message", (msg: RunOutcome) => finish(msg));
    worker.once("error", (err: Error & { code?: string }) =>
      finish(
        err.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? { status: "limit", events: [], message: `Memory limit of ${lim.maxHeapMb} MB exceeded` }
          : { status: "internal_error", message: String(err) },
      ),
    );
    worker.once("exit", (code) => finish({ status: "internal_error", message: `Worker exited (code ${code}) without a result` }));
  });
}
