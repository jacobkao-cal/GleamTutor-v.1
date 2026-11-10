/**
 * Compatibility audit of the example library, from real runs:
 *   Compiles  - the official compiler (with gleam_stdlib) accepts it
 *   Executes  - the UNINSTRUMENTED compiled program runs to completion
 *   Traces    - the tracer produces a validated step-by-step trace
 * Prints a Markdown table.  npm run tracer:audit
 */
import { GT_EXAMPLES } from "../examples.js";
import { linkProgram } from "../src/tracer/link";
import { traceGleam } from "../src/tracer/traceGleam";
import { parseSubset, tokenize, UnsupportedError } from "../src/tracer/subset";
import { compileGleam, loadStdlibInfo } from "./compiler";
import { nodeRuntime } from "./nodeRuntime";
import { runInWorker } from "./runner";

const stdlib = loadStdlibInfo();
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

const CONTEXTUAL = new Set(["case", "if", "[", "]", ".."]);

/** Every unsupported construct we can find: the parser's first refusal, plus other unsupported tokens. */
function missingFeatures(code: string): string[] {
  const found = new Set<string>();
  try {
    parseSubset(code, { stdlib });
  } catch (e) {
    if (e instanceof UnsupportedError) found.add(`${e.feature} (line ${e.line})`);
  }
  for (const t of tokenize(code) as { kind: string; text: string; feature?: string; line: number }[]) {
    // Tokens the parser accepts in the right place (case, guards, lists, discards) are not missing features.
    if (CONTEXTUAL.has(t.text) || t.text.startsWith("_")) continue;
    // `type` and `as` inside an import (`import gleam/option.{type Option}`) are supported.
    if ((t.text === "type" || t.text === "as") && /^\s*import\s/.test(code.split("\n")[t.line - 1] ?? "")) continue;
    if (t.kind === "bad" && ![...found].some((f) => f.startsWith(t.feature!))) found.add(`${t.feature} (line ${t.line})`);
  }
  return [...found];
}

console.log("| Example | Compiles | Executes | Traces | Missing features |");
console.log("|---|---|---|---|---|");
for (const ex of GT_EXAMPLES) {
  const compiled = await compileGleam(ex.code);
  let compiles = "✅";
  let executes = "—";
  if (!compiled.ok) compiles = `❌ ${compiled.diagnostic.title}`;
  else {
    const run = await runInWorker(linkProgram(compiled.js, compiled.js, stdlib));
    executes =
      run.status === "ok"
        ? `✅ (${run.stdout.split("\n").filter(Boolean).length} lines printed)`
        : run.status === "runtime_error"
          ? `⚠️ crashes: ${run.message.slice(0, 60)}`
          : `❌ ${run.status}`;
  }
  const traced = await traceGleam(ex.code, nodeRuntime);
  const traces = traced.status === "ok" ? `✅ ${traced.trace.steps.length} steps` : `❌ ${traced.status}`;
  const missing = traced.status === "ok" ? "—" : missingFeatures(ex.code).join("; ") || (traced.status === "unsupported" ? traced.message : traced.status);
  console.log(`| ${cell(ex.title)} (\`${ex.id}\`) | ${compiles} | ${cell(executes)} | ${traces} | ${cell(missing)} |`);
}
