// Browser compile worker: runs the official Gleam WASM compiler inside the sandbox.
// init: { type: "init", glue, wasm } -> { type: "ready" } | { type: "init_failed", error }
// compile: { id, source } -> { id, ok: true, js, warnings } | { id, ok: false, error }
let wasm = null;
let project = 0;
self.onmessage = async ({ data }) => {
  if (data.type === "init") {
    try {
      wasm = await import(URL.createObjectURL(new Blob([data.glue], { type: "text/javascript" })));
      wasm.initSync({ module: data.wasm });
      wasm.initialise_panic_hook(false);
      self.postMessage({ type: "ready" });
    } catch (e) {
      self.postMessage({ type: "init_failed", error: String(e) });
    }
    return;
  }
  const id = data.id;
  const pid = ++project;
  try {
    wasm.write_module(pid, "main", data.source);
    wasm.compile_package(pid, "javascript");
    const warnings = [];
    for (let w = wasm.pop_warning(pid); w; w = wasm.pop_warning(pid)) warnings.push(w.trim());
    self.postMessage({ id, ok: true, js: wasm.read_compiled_javascript(pid, "main"), warnings });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e) });
  } finally {
    try {
      wasm.delete_project(pid);
    } catch {
      /* ignore */
    }
  }
};
