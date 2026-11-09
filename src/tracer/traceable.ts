/**
 * Cheap, computed capability check used to mark examples as traceable.
 * It runs the same subset recogniser the engine uses, without compiling or
 * running anything; the engine remains the final authority (a test checks that
 * every example marked here is accepted by the real engine, and vice versa).
 */
import { parseSubset } from "./subset";

export function looksTraceable(source: string): boolean {
  if (/^\s*import\s/m.test(source)) return false;
  try {
    parseSubset(source);
    return true;
  } catch {
    return false;
  }
}
