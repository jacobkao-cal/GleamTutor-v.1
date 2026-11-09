// Sandbox host. Runs inline in an <iframe sandbox="allow-scripts" srcdoc=...>:
// an opaque origin with no cookies, storage or same-origin access to the app,
// and a CSP with connect-src 'none'. It owns:
//  - one compile worker (official Gleam WASM compiler), reused;
//  - one execution worker PER RUN, terminated after the run or on timeout.
// The embedding page substitutes the parent-origin placeholder below before computing the CSP hash.
(() => {
  const PARENT_ORIGIN = __PARENT_ORIGIN__;
  const send = (msg) => window.parent.postMessage(msg, PARENT_ORIGIN);
  // Classic workers: Chrome refuses blob: MODULE workers in an opaque-origin
  // sandbox, while classic workers can still import() blob: modules.
  const workerFrom = (text) => new Worker(URL.createObjectURL(new Blob([text], { type: "text/javascript" })));
  let init = null; // { compileWorker, bundle, runWorkerSource }
  const compileWaiters = new Map();

  function startCompiler(m) {
    const compileWorker = workerFrom(m.compileWorkerSource);
    compileWorker.onmessage = ({ data }) => {
      if (data.type === "ready") return send({ type: "ready" });
      if (data.type === "init_failed") return send({ type: "init_failed", error: data.error });
      const reply = compileWaiters.get(data.id);
      compileWaiters.delete(data.id);
      if (reply) reply(data);
    };
    compileWorker.onerror = (e) => send({ type: "init_failed", error: `compile worker error: ${e.message ?? "unknown"}` });
    compileWorker.postMessage({ type: "init", glue: m.glue, wasm: m.wasm, stdlibSources: m.stdlibSources });
    init = { compileWorker, bundle: m.stdlibBundle, runWorkerSource: m.runWorkerSource };
  }

  function execute(m) {
    const worker = workerFrom(init.runWorkerSource);
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      send({ type: "executed", id: m.id, outcome });
    };
    const timer = setTimeout(
      () => finish({ status: "timeout", message: `Execution took longer than ${m.limits.timeoutMs} ms and was stopped` }),
      m.limits.timeoutMs,
    );
    worker.onmessage = ({ data }) => finish(data);
    worker.onerror = (e) => {
      e.preventDefault();
      finish({ status: "internal_error", message: `Execution worker error: ${e.message ?? "unknown"}` });
    };
    worker.postMessage({ program: m.program, bundle: init.bundle, limits: m.limits, recorderSymbol: m.recorderSymbol });
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window.parent) return;
    const m = ev.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "init" && !init) startCompiler(m);
    else if (m.type === "compile" && init) {
      compileWaiters.set(m.id, (r) => send({ type: "compiled", ...r }));
      init.compileWorker.postMessage({ id: m.id, source: m.source });
    } else if (m.type === "execute" && init) execute(m);
  });
  send({ type: "loaded" });
})();
