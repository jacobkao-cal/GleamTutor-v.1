// Browser execution worker (classic script; one per run, terminated afterwards). Created by the
// sandbox host inside the opaque-origin iframe; its text is recorder.js + this file.
// Input: { files: { instrumented, original, prelude }, limits, recorderSymbol }.
// The compiled modules import "./gleam.mjs" (the prelude); that specifier is
// rewritten to a blob: URL because nothing can be fetched from the network here.
self.onmessage = async ({ data }) => {
  const { files, limits, recorderSymbol } = data;
  const blobUrl = (text) => URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  const preludeUrl = blobUrl(files.prelude);
  const link = (js) => js.split('from "./gleam.mjs"').join(`from ${JSON.stringify(preludeUrl)}`);
  const urls = { original: blobUrl(link(files.original)), instrumented: blobUrl(link(files.instrumented)) };
  const reply = await runPrograms((name) => import(urls[name]), limits, recorderSymbol);
  self.postMessage(reply);
};
