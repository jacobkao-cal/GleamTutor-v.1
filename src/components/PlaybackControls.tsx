import type { Playback } from "../playback/playback";

/** Slider, << First / < Prev / Next > / Last >> buttons, and the step counter. */
export function PlaybackControls({ playback }: { playback: Playback }) {
  const { index, stepCount, atStart, atEnd, go } = playback;
  return (
    <div className="playback-controls">
      <input
        className="step-slider"
        type="range"
        min={0}
        max={Math.max(stepCount - 1, 0)}
        step={1}
        value={index}
        aria-label="Execution step"
        disabled={stepCount <= 1}
        onChange={(e) => go({ seek: Number(e.target.value) })}
      />
      <div className="vcr-buttons">
        <button type="button" onClick={() => go("first")} disabled={atStart}>
          {"<< First"}
        </button>
        <button type="button" onClick={() => go("prev")} disabled={atStart}>
          {"< Prev"}
        </button>
        <button type="button" onClick={() => go("next")} disabled={atEnd}>
          {"Next >"}
        </button>
        <button type="button" onClick={() => go("last")} disabled={atEnd}>
          {"Last >>"}
        </button>
      </div>
      <div className="step-counter" aria-live="polite">
        Step {index + 1} of {stepCount}
      </div>
    </div>
  );
}
