/**
 * Fetching the pinned toolchain files that tracer:setup publishes under
 * /gleam-toolchain/<version>/. Every file is checked against its pinned
 * SHA-256 (tracer-node/toolchain.json) before it is used.
 */
import manifest from "../../tracer-node/toolchain.json";
import type { StdlibInfo } from "./stdlib";

export const GLEAM_VERSION: string = manifest.gleamVersion;
export const STDLIB_VERSION: string = manifest.stdlib.version;
export const TOOLCHAIN_BASE = `/gleam-toolchain/${GLEAM_VERSION}/`;
/** Pinned SHA-256 of every file the browser loads (downloaded and generated). */
const PINNED: Record<string, string> = { ...manifest.browserFiles, ...manifest.generated };

export class ToolchainError extends Error {}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fetchVerified(name: string): Promise<ArrayBuffer> {
  const url = TOOLCHAIN_BASE + name;
  const res = await fetch(url);
  if (!res.ok) throw new ToolchainError(`could not load ${url} (HTTP ${res.status}); run: npm run tracer:setup`);
  const buf = await res.arrayBuffer();
  if (!PINNED[name] || (await sha256Hex(buf)) !== PINNED[name]) throw new ToolchainError(`${url} does not match its pinned checksum`);
  return buf;
}

let infoPromise: Promise<StdlibInfo> | null = null;
/** gleam_stdlib metadata (exports and function result types); small, cached. */
export function loadStdlibInfo(): Promise<StdlibInfo> {
  infoPromise ??= fetchVerified("stdlib.json")
    .then((b) => JSON.parse(new TextDecoder().decode(b)) as StdlibInfo)
    .catch((e) => {
      infoPromise = null;
      throw e;
    });
  return infoPromise;
}
