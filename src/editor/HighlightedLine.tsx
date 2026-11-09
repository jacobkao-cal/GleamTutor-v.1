import { tokenize } from "./highlight";

/** Renders one line of Gleam source with token colour classes. */
export function HighlightedLine({ text }: { text: string }) {
  return (
    <>
      {tokenize(text).map((t, i) =>
        t.kind === "plain" ? t.text : <span key={i} className={`tok-${t.kind}`}>{t.text}</span>,
      )}
    </>
  );
}
