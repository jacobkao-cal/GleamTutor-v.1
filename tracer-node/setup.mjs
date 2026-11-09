// Sets up the pinned Gleam toolchain for the tracer. Development-time only;
// nothing is fetched from the network when a program runs.
//
// 1. Downloads the official Gleam browser compiler (WASM), the JavaScript
//    prelude and the official gleam_stdlib package from Hex, and verifies
//    each download's SHA-256 against toolchain.json.
// 2. Precompiles gleam_stdlib to JavaScript with that same compiler, then
//    bundles it with the prelude and the stdlib's own FFI files into one
//    ES module (esbuild). The stdlib's modules import each other in cycles,
//    which blob: URLs cannot express, so the browser sandbox loads this one
//    bundle instead of separate files.
// 3. Writes metadata (each module's exports and public function result
//    types, read from the stdlib's own sources) and the Gleam sources the
//    compiler needs for type checking.
// 4. Verifies the generated files against their pinned SHA-256 (the build
//    is reproducible) and copies the browser runtime's files to public/.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "toolchain.json"), "utf8"));
const dest = path.join(here, ".toolchain", `gleam-${manifest.gleamVersion}`);
const stdlibDir = path.join(here, ".toolchain", `gleam_stdlib-${manifest.stdlib.version}`);
const publicDir = path.join(here, "..", "public", "gleam-toolchain", manifest.gleamVersion);
const PRINT_HASHES = process.env.GLEAM_TUTOR_PRINT_HASHES === "1";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function download(url, expectedSha) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = sha256(buf);
  if (sha !== expectedSha) throw new Error(`Checksum mismatch for ${url}\n  expected ${expectedSha}\n  got      ${sha}`);
  return buf;
}

// ---------------------------------------------------------------- 1. downloads

if (!fs.existsSync(path.join(dest, "gleam_wasm_bg.wasm")) || !fs.existsSync(path.join(dest, "gleam_prelude.mjs"))) {
  fs.mkdirSync(dest, { recursive: true });
  console.log(`Downloading Gleam ${manifest.gleamVersion} browser compiler...`);
  const tarPath = path.join(dest, "compiler.tar.gz");
  fs.writeFileSync(tarPath, await download(manifest.compiler.url, manifest.compiler.sha256));
  execFileSync("tar", ["-xzf", tarPath, "-C", dest]);
  fs.rmSync(tarPath);
  console.log("Downloading JavaScript prelude...");
  fs.writeFileSync(path.join(dest, "gleam_prelude.mjs"), await download(manifest.prelude.url, manifest.prelude.sha256));
}

if (!fs.existsSync(path.join(stdlibDir, "src", "gleam", "io.gleam"))) {
  console.log(`Downloading gleam_stdlib ${manifest.stdlib.version} from Hex...`);
  fs.mkdirSync(stdlibDir, { recursive: true });
  const outer = path.join(stdlibDir, "package.tar");
  fs.writeFileSync(outer, await download(manifest.stdlib.url, manifest.stdlib.sha256));
  execFileSync("tar", ["-xf", outer, "-C", stdlibDir, "contents.tar.gz"]);
  execFileSync("tar", ["-xzf", path.join(stdlibDir, "contents.tar.gz"), "-C", stdlibDir]);
  fs.rmSync(outer);
  fs.rmSync(path.join(stdlibDir, "contents.tar.gz"));
}

// ---------------------------------------------------------------- 2. precompile + bundle

const wasm = await import(pathToFileURL(path.join(dest, "gleam_wasm.js")).href);
wasm.initSync({ module: fs.readFileSync(path.join(dest, "gleam_wasm_bg.wasm")) });
wasm.initialise_panic_hook(false);

/** Gleam module name ("gleam/io") -> source, sorted for determinism. */
const sources = {};
const walk = (dir, prefix) => {
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, `${prefix}${f}/`);
    else if (f.endsWith(".gleam")) sources[`${prefix}${f.slice(0, -".gleam".length)}`] = fs.readFileSync(p, "utf8");
  }
};
walk(path.join(stdlibDir, "src", "gleam"), "gleam/");
const moduleNames = Object.keys(sources).sort();

const pid = 1;
for (const name of moduleNames) wasm.write_module(pid, name, sources[name]);
wasm.write_module(pid, "main", "pub fn main() {\n  Nil\n}\n");
wasm.compile_package(pid, "javascript");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "gleam-tutor-stdlib-"));
try {
  for (const name of moduleNames) {
    const file = path.join(work, `${name}.mjs`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, wasm.read_compiled_javascript(pid, name));
  }
  fs.writeFileSync(path.join(work, "gleam.mjs"), 'export * from "./gleam_prelude.mjs";\n'); // as the compiler writes it
  fs.copyFileSync(path.join(dest, "gleam_prelude.mjs"), path.join(work, "gleam_prelude.mjs"));
  for (const ffi of fs.readdirSync(path.join(stdlibDir, "src")).filter((f) => f.endsWith(".mjs"))) {
    fs.copyFileSync(path.join(stdlibDir, "src", ffi), path.join(work, ffi));
  }

  // Namespace names: m0 = prelude ("gleam.mjs"), m1.. = stdlib modules in sorted order.
  const entries = [["gleam", "m0", "./gleam.mjs"], ...moduleNames.map((n, i) => [n, `m${i + 1}`, `./${n}.mjs`])];
  fs.writeFileSync(path.join(work, "entry.mjs"), entries.map(([, ns, file]) => `export * as ${ns} from ${JSON.stringify(file)};`).join("\n") + "\n");
  const result = await build({
    entryPoints: ["entry.mjs"],
    absWorkingDir: work, // module path comments stay relative, so the output is reproducible
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    legalComments: "none",
    logLevel: "silent",
    banner: {
      js:
        `// gleam_stdlib ${manifest.stdlib.version} compiled to JavaScript by Gleam ${manifest.gleamVersion}, with the Gleam\n` +
        `// JavaScript prelude and gleam_stdlib's FFI modules. Both are Apache-2.0 (c) the Gleam contributors.\n` +
        `// Generated by tracer-node/setup.mjs; do not edit.`,
    },
  });
  const bundle = result.outputFiles[0].text;
  const bundlePath = path.join(work, "bundle.mjs");
  fs.writeFileSync(bundlePath, bundle);

  // ------------------------------------------------------------ 3. metadata
  const loaded = await import(pathToFileURL(bundlePath).href);
  const meta = {
    gleamVersion: manifest.gleamVersion,
    stdlibVersion: manifest.stdlib.version,
    prelude: { ns: "m0", exports: Object.keys(loaded.m0).sort() },
    modules: {},
  };
  for (const [name, ns] of entries.slice(1)) {
    meta.modules[name] = { ns, exports: Object.keys(loaded[ns]).sort(), functions: publicFunctionResultTypes(sources[name]) };
  }

  // ------------------------------------------------------------ 4. verify + publish
  const generated = {
    "stdlib.bundle.mjs": Buffer.from(bundle),
    "stdlib.json": Buffer.from(JSON.stringify(meta) + "\n"),
    "stdlib.sources.json": Buffer.from(JSON.stringify(sources) + "\n"),
  };
  for (const [name, buf] of Object.entries(generated)) {
    const sha = sha256(buf);
    if (PRINT_HASHES) console.log(`${name}: ${sha}`);
    else if (sha !== manifest.generated[name]) {
      throw new Error(
        `Generated ${name} does not match its pinned checksum (is the esbuild version in package-lock.json unchanged?)\n` +
          `  expected ${manifest.generated[name]}\n  got      ${sha}`,
      );
    }
    fs.writeFileSync(path.join(dest, name), buf);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

fs.mkdirSync(publicDir, { recursive: true });
for (const name of fs.readdirSync(publicDir)) fs.rmSync(path.join(publicDir, name)); // drop files from older layouts
for (const [name, expected] of Object.entries({ ...manifest.browserFiles, ...manifest.generated })) {
  const buf = fs.readFileSync(path.join(dest, name));
  if (!PRINT_HASHES && sha256(buf) !== expected) throw new Error(`Checksum mismatch for ${name}`);
  fs.writeFileSync(path.join(publicDir, name), buf);
}
console.log(`Toolchain ready: ${dest}\nBrowser files: ${publicDir}`);

/**
 * Public function name -> declared result type, read from a stdlib module's
 * Gleam source ("pub fn name(...) -> Type"). Functions without a declared
 * result type are recorded as "".
 */
function publicFunctionResultTypes(source) {
  const out = {};
  const re = /^pub fn ([a-z][a-z0-9_]*)\s*\(/gm;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let i = re.lastIndex;
    for (let depth = 1; depth > 0 && i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    const rest = source.slice(i);
    const arrow = /^\s*->\s*/.exec(rest);
    let type = "";
    if (arrow) {
      const after = rest.slice(arrow[0].length);
      const end = after.search(/\s*\{|\n\s*\n|\n\s*@|\n\s*pub\s|\n\s*fn\s|\n\s*\/\//);
      type = (end === -1 ? after : after.slice(0, end)).replace(/\s+/g, " ").trim();
    }
    out[m[1]] = type;
  }
  return out;
}
