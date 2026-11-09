/**
 * Native example dropdown. Selection is derived from the editor text: it shows
 * an example only while the source exactly equals that example's code, so a
 * manual edit returns it to the placeholder. It changes the source only when
 * the user picks an option (never while typing) and never runs anything.
 */
import { findExampleBySource, groupExamples } from "../examples/library";
import { looksTraceable } from "../tracer/traceable";

interface Props {
  source: string;
  onPick: (exampleId: string) => void;
}

const GROUPS = groupExamples();
/** Computed from each example's code with the tracer's own subset check; never hard-coded. */
const TRACEABLE = new Set(GROUPS.flatMap((g) => g.examples).filter((ex) => looksTraceable(ex.code)).map((ex) => ex.id));
export const TRACEABLE_SUFFIX = " (step-through)";

export function ExamplePicker({ source, onPick }: Props) {
  const selected = findExampleBySource(source)?.id ?? "";
  return (
    <select
      className="example-picker"
      aria-label="Example programs"
      value={selected}
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
      }}
    >
      <option value="" disabled>
        Choose an example...
      </option>
      {GROUPS.map((g) => (
        <optgroup key={g.group} label={g.group}>
          {g.examples.map((ex) => (
            <option key={ex.id} value={ex.id}>
              {ex.title}
              {TRACEABLE.has(ex.id) ? TRACEABLE_SUFFIX : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
