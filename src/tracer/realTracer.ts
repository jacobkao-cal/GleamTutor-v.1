/**
 * The real tracer used by the app: the Phase 2B engine on the browser runtime
 * (sandboxed iframe + Web Workers). The exact demo source keeps its predefined
 * Demo trace through withDemoFixture (see main.tsx).
 *
 * The engine (with its JavaScript parser) is a separate chunk, loaded on the
 * first real trace, so it does not slow down the first page load.
 */
import type { Tracer } from "../trace/tracer";

export const realTracer: Tracer = {
  async trace(source) {
    const [{ traceGleam }, { browserRuntime }, { toTraceResult }] = await Promise.all([
      import("./traceGleam"),
      import("./browserRuntime"),
      import("./toTraceResult"),
    ]);
    return toTraceResult(await traceGleam(source, browserRuntime));
  },
};
