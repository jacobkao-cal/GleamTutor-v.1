// Node execution worker (see runner.ts). Uses the SAME support code as the
// browser sandbox (src/tracer/sandbox/recorder.js).
// 1. Links the program's modules to the precompiled gleam_stdlib bundle.
// 2. Runs the UNINSTRUMENTED program -> baseline result and output.
// 3. Runs the INSTRUMENTED program with the recorder -> raw events, output, result.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { describeError, linkModules, runPrograms } from "../src/tracer/sandbox/recorder.js";

const { program, bundlePath, limits, recorderSymbol } = workerData;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gleam-tutor-run-"));
let reply;
try {
  let n = 0;
  const urls = linkModules(program.modules, { stdlib: pathToFileURL(bundlePath).href }, (_id, code) => {
    const file = path.join(dir, `m${n++}.mjs`);
    fs.writeFileSync(file, code);
    return pathToFileURL(file).href;
  });
  reply = await runPrograms((id) => import(urls[id]), program, limits, recorderSymbol);
} catch (e) {
  reply = { status: "internal_error", message: describeError(e) };
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
parentPort.postMessage(reply);
