// Downloads the pinned official Gleam browser compiler (WASM) and JS prelude
// into tracer-node/.toolchain/ and verifies their SHA-256 checksums, then
// copies the browser runtime's files into public/gleam-toolchain/<version>/.
// Development-only; nothing here is bundled into the app.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = here;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "toolchain.json"), "utf8"));
const dest = path.join(root, ".toolchain", `gleam-${manifest.gleamVersion}`);

async function download(url, expectedSha) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== expectedSha) throw new Error(`Checksum mismatch for ${url}\n  expected ${expectedSha}\n  got      ${sha}`);
  return buf;
}

// Copies the three files the browser runtime loads into public/ (served as
// static files; nothing is fetched from GitHub at run time), verifying each.
function publishBrowserFiles() {
  const out = path.join(root, "..", "public", "gleam-toolchain", manifest.gleamVersion);
  fs.mkdirSync(out, { recursive: true });
  for (const [name, expected] of Object.entries(manifest.browserFiles)) {
    const buf = fs.readFileSync(path.join(dest, name));
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== expected) throw new Error(`Checksum mismatch for ${name}\n  expected ${expected}\n  got      ${sha}`);
    fs.writeFileSync(path.join(out, name), buf);
  }
  console.log(`Browser files: ${out}`);
}

if (fs.existsSync(path.join(dest, "gleam_wasm_bg.wasm")) && fs.existsSync(path.join(dest, "gleam_prelude.mjs"))) {
  console.log(`Toolchain already present: ${dest}`);
  publishBrowserFiles();
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
console.log(`Downloading Gleam ${manifest.gleamVersion} browser compiler...`);
const tarball = await download(manifest.compiler.url, manifest.compiler.sha256);
const tarPath = path.join(dest, "compiler.tar.gz");
fs.writeFileSync(tarPath, tarball);
execFileSync("tar", ["-xzf", tarPath, "-C", dest]);
fs.rmSync(tarPath);

console.log("Downloading JavaScript prelude...");
fs.writeFileSync(path.join(dest, "gleam_prelude.mjs"), await download(manifest.prelude.url, manifest.prelude.sha256));
console.log(`Done: ${dest}`);
publishBrowserFiles();
