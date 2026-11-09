// Node execution worker (see runner.ts). Uses the SAME recorder as the browser
// sandbox (src/tracer/sandbox/recorder.js).
// 1. Runs the UNINSTRUMENTED compiled program -> baseline result.
// 2. Runs the INSTRUMENTED program with the recorder -> raw events + result.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { describeError, runPrograms } from "../src/tracer/sandbox/recorder.js";

const { files, limits, recorderSymbol } = workerData;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gleam-tutor-run-"));
let reply;
try {
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  const file = { original: "original.mjs", instrumented: "main.mjs" };
  reply = await runPrograms((name) => import(pathToFileURL(path.join(dir, file[name])).href), limits, recorderSymbol);
} catch (e) {
  reply = { status: "internal_error", message: describeError(e) };
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
parentPort.postMessage(reply);
