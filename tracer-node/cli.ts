/**
 * Command line: trace a Gleam file with the real engine and print the steps.
 *   npm run tracer:trace -- path/to/program.gleam
 *   npm run tracer:trace -- path/to/program.gleam --json
 */
import fs from "node:fs";
import { traceGleam } from "../src/tracer/traceGleam";
import { nodeRuntime } from "./nodeRuntime";

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error("usage: npm run tracer:trace -- <file.gleam> [--json]");
  process.exit(2);
}
const result = await traceGleam(fs.readFileSync(file, "utf8"), nodeRuntime);
if (flag === "--json") {
  console.log(JSON.stringify(result, null, 2));
} else if (result.status !== "ok") {
  console.log(`status: ${result.status}`);
  console.log(JSON.stringify(result, (k, v) => (k === "events" || k === "trace" ? undefined : v), 2));
} else {
  const show = (v: { kind: string; value?: unknown; id?: string }) => (v.kind === "ref" ? `→${v.id}` : String(v.value));
  console.log(`status: ok   (Gleam ${result.gleamVersion}, ${result.trace.steps.length} steps, main() = ${show(result.result)})\n`);
  for (const s of result.trace.steps) {
    const frames = s.frames
      .filter((f) => f.status !== "module")
      .map((f) => {
        const vars = f.bindings.map((b) => `${b.name}=${show(b.value)}`).join(" ");
        const ret = f.returnValue ? ` ⇒${show(f.returnValue)}` : "";
        return `${f.functionName}${f.status === "exited" ? "(exited)" : ""}[${vars}${ret}]`;
      })
      .join("  ");
    const arrow = (l: { line: number } | null) => (l ? String(l.line) : "-");
    console.log(
      `${String(s.index + 1).padStart(3)}  ${s.event.padEnd(6)} green ${arrow(s.justExecuted).padStart(2)}  red ${arrow(s.nextToExecute).padStart(2)}   ${frames}`,
    );
  }
}
