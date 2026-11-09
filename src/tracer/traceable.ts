/**
 * Cheap, computed capability check used to mark examples as traceable.
 * It runs the same subset recogniser the engine uses (with the same stdlib
 * metadata), without compiling or running anything. The engine remains the
 * final authority: a test checks that this agrees with the real engine for
 * every library example and sample.
 */
import type { StdlibInfo } from "./stdlib";
import { parseSubset } from "./subset";

export function looksTraceable(source: string, stdlib: StdlibInfo): boolean {
  try {
    parseSubset(source, { stdlib });
    return true;
  } catch {
    return false;
  }
}
