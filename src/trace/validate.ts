/**
 * Structural checks applied before any trace is displayed. Returns a list of
 * problems (empty = valid). This guards both the fixture and future real traces.
 */
import { hashSource } from "./source";
import { TRACE_SCHEMA_VERSION, type ExecutionTrace, type SourceLocation, type TraceValue } from "./types";

export function validateTrace(trace: ExecutionTrace, source: string): string[] {
  const problems: string[] = [];
  if (trace.schemaVersion !== TRACE_SCHEMA_VERSION) problems.push(`unknown schemaVersion ${trace.schemaVersion}`);
  if (trace.sourceHash !== hashSource(source)) problems.push("trace does not belong to this source");
  if (trace.steps.length === 0) problems.push("trace has no steps");

  const lineCount = source.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n").length;
  const checkLoc = (loc: SourceLocation | null, where: string) => {
    if (loc && (loc.line < 1 || loc.line > lineCount)) problems.push(`${where}: line ${loc.line} out of range`);
  };

  trace.steps.forEach((step, i) => {
    const where = `step ${i}`;
    if (step.index !== i) problems.push(`${where}: index is ${step.index}`);
    checkLoc(step.source, `${where}.source`);
    checkLoc(step.justExecuted, `${where}.justExecuted`);
    checkLoc(step.nextToExecute, `${where}.nextToExecute`);

    const objectIds = new Set(step.objects.map((o) => o.id));
    const frameIds = new Set<string>();
    const checkValue = (v: TraceValue, ctx: string) => {
      if (v.kind === "ref" && !objectIds.has(v.id)) problems.push(`${where}: ${ctx} refers to missing object ${v.id}`);
    };
    for (const f of step.frames) {
      if (frameIds.has(f.id)) problems.push(`${where}: duplicate frame id ${f.id}`);
      frameIds.add(f.id);
      f.bindings.forEach((b) => checkValue(b.value, `${f.id}.${b.name}`));
      if (f.returnValue) checkValue(f.returnValue, `${f.id} return value`);
    }
    for (const f of step.frames) {
      if (f.parentId !== null && !frameIds.has(f.parentId)) problems.push(`${where}: ${f.id} has missing parent ${f.parentId}`);
    }
    if (i > 0 && !step.stdout.startsWith(trace.steps[i - 1].stdout)) problems.push(`${where}: stdout is not cumulative`);
  });
  return problems;
}
