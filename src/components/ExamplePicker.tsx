/**
 * Native example dropdown. Selection is derived from the editor text: it shows
 * an example only while the source exactly equals that example's code, so a
 * manual edit returns it to the placeholder. It changes the source only when
 * the user picks an option (never while typing) and never runs anything.
 */
import { useEffect, useState } from "react";
import { findExampleBySource, groupExamples } from "../examples/library";
import { looksTraceable } from "../tracer/traceable";
import { loadStdlibInfo } from "../tracer/toolchainFiles";

interface Props {
  source: string;
  onPick: (exampleId: string) => void;
}

const GROUPS = groupExamples();
export const TRACEABLE_SUFFIX = " (step-through)";

/**
 * Ids of examples the tracer can step through, computed from each example's
 * code with the tracer's own subset check and stdlib metadata (never a list
 * of names). Empty until the 14 KB metadata has loaded, or if it cannot load.
 */
function useTraceableIds(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    loadStdlibInfo()
      .then((info) => {
        if (live) setIds(new Set(GROUPS.flatMap((g) => g.examples).filter((ex) => looksTraceable(ex.code, info)).map((ex) => ex.id)));
      })
      .catch(() => undefined); // no marks; Visualize still reports the real result
    return () => {
      live = false;
    };
  }, []);
  return ids;
}

export function ExamplePicker({ source, onPick }: Props) {
  const traceable = useTraceableIds();
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
              {traceable.has(ex.id) ? TRACEABLE_SUFFIX : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
