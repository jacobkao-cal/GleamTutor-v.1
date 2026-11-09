/**
 * Read-only view over the example library in /examples.js (the only copy of
 * the examples). Examples are editor content only: loading one never runs or
 * traces it, and none of them has a trace.
 */
import { GT_EXAMPLES, type GleamExample } from "../../examples.js";

export type { GleamExample };

export interface ExampleGroup {
  group: string;
  examples: GleamExample[];
}

export const EXAMPLES: readonly GleamExample[] = GT_EXAMPLES;

/** Groups examples by category, keeping first-appearance order of groups and examples. */
export function groupExamples(examples: readonly GleamExample[] = EXAMPLES): ExampleGroup[] {
  const groups: ExampleGroup[] = [];
  for (const ex of examples) {
    let g = groups.find((x) => x.group === ex.group);
    if (!g) {
      g = { group: ex.group, examples: [] };
      groups.push(g);
    }
    g.examples.push(ex);
  }
  return groups;
}

export function findExampleById(id: string): GleamExample | undefined {
  return EXAMPLES.find((e) => e.id === id);
}

/** The example whose code exactly equals `source`, if any (used to show the current selection). */
export function findExampleBySource(source: string): GleamExample | undefined {
  return EXAMPLES.find((e) => e.code === source);
}
