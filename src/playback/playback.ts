/**
 * Playback controller: a single clamped step index over a recorded trace.
 * Moving backward reads an earlier snapshot; nothing is re-executed.
 */
import { useCallback, useState } from "react";

export type PlaybackAction = "first" | "prev" | "next" | "last" | { seek: number };

export function clampStep(index: number, stepCount: number): number {
  if (stepCount <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), stepCount - 1);
}

export function applyPlayback(current: number, action: PlaybackAction, stepCount: number): number {
  if (action === "first") return 0;
  if (action === "last") return clampStep(stepCount - 1, stepCount);
  if (action === "prev") return clampStep(current - 1, stepCount);
  if (action === "next") return clampStep(current + 1, stepCount);
  return clampStep(action.seek, stepCount);
}

export interface Playback {
  index: number;
  stepCount: number;
  atStart: boolean;
  atEnd: boolean;
  go: (action: PlaybackAction) => void;
}

export function usePlayback(stepCount: number): Playback {
  const [index, setIndex] = useState(0);
  const go = useCallback((action: PlaybackAction) => setIndex((i) => applyPlayback(i, action, stepCount)), [stepCount]);
  const safe = clampStep(index, stepCount);
  return { index: safe, stepCount, atStart: safe === 0, atEnd: safe >= stepCount - 1, go };
}
