// Browser execution worker (classic script; one per run, terminated afterwards).
// Created by the sandbox host inside the opaque-origin iframe; its text is
// recorder.js (minus `export`) + this file.
// Input: { program: ProgramFiles, bundle, limits, recorderSymbol }.
// Every module becomes a blob: URL, because nothing can be fetched here:
// first the precompiled gleam_stdlib bundle, then the program's modules,
// whose import holes are filled with those URLs (see linkModules).
// Output-only stand-in for Node's `process`, so gleam_stdlib's io.print and
// io.print_error take the same path as under Node / `gleam run` (write the
// text exactly, with no added newline) instead of the console.log fallback,
// which would end every io.print with a newline. runPrograms captures these
// writes; nothing else is provided.
if (typeof process === "undefined") {
  self.process = { stdout: { write: () => true }, stderr: { write: () => true } };
}

self.onmessage = async ({ data }) => {
  const { program, bundle, limits, recorderSymbol } = data;
  let reply;
  try {
    const blobUrl = (code) => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    const urls = linkModules(program.modules, { stdlib: blobUrl(bundle) }, (_id, code) => blobUrl(code));
    reply = await runPrograms((id) => import(urls[id]), program, limits, recorderSymbol);
  } catch (e) {
    reply = { status: "internal_error", message: describeError(e) };
  }
  self.postMessage(reply);
};
