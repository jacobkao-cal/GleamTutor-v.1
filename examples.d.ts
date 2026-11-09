/** Types for examples.js, the single source of the Gleam example library. */
export interface GleamExample {
  /** Category; dropdown groups appear in first-appearance order. */
  group: string;
  /** Stable unique identifier. */
  id: string;
  title: string;
  /** Gleam source loaded into the editor. */
  code: string;
}

export declare const GT_EXAMPLES: readonly GleamExample[];
