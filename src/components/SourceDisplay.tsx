/**
 * Read-only source with line numbers and Python Tutor-style arrows.
 * Green = just executed, red = next to execute. When a step has a column range,
 * the exact expression is underlined in the arrow's colour so several events on
 * one line (e.g. `square(a)` then `let b = ...`) stay distinguishable.
 */
import type { SourceLocation } from "../trace/types";

interface Props {
  source: string;
  justExecuted: SourceLocation | null;
  nextToExecute: SourceLocation | null;
}

export const GREEN_ARROW = "#9fd49f";
export const RED_ARROW = "#e93f34";

export function Arrow({ color, title }: { color: string; title: string }) {
  return (
    <svg className="line-arrow" width="18" height="10" viewBox="0 0 18 10" role="img" aria-label={title}>
      <path d="M0 3.5 H11 V0 L18 5 L11 10 V6.5 H0 Z" fill={color} />
    </svg>
  );
}

type Mark = "next" | "just" | null;

function markColumns(text: string, line: number, just: SourceLocation | null, next: SourceLocation | null): Mark[] {
  const marks: Mark[] = Array.from({ length: text.length }, () => null);
  const paint = (loc: SourceLocation | null, mark: Mark) => {
    if (!loc || loc.line !== line || loc.column === undefined) return;
    const start = loc.column - 1;
    const end = loc.endLine && loc.endLine !== line ? text.length : (loc.endColumn ?? text.length + 1) - 1;
    for (let i = Math.max(start, 0); i < Math.min(end, text.length); i++) marks[i] = mark;
  };
  paint(just, "just");
  paint(next, "next"); // next wins where ranges overlap
  return marks;
}

function MarkedLine({ text, line, just, next }: { text: string; line: number; just: SourceLocation | null; next: SourceLocation | null }) {
  const marks = markColumns(text, line, just, next);
  const parts: { text: string; mark: Mark }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.mark === marks[i]) last.text += text[i];
    else parts.push({ text: text[i], mark: marks[i] });
  }
  return (
    <>
      {parts.map((p, i) =>
        p.mark ? (
          <span key={i} className={p.mark === "next" ? "range-next" : "range-just"}>
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

export function SourceDisplay({ source, justExecuted, nextToExecute }: Props) {
  const lines = source.split("\n");
  return (
    <table className="source-display" aria-label="Program source">
      <tbody>
        {lines.map((text, i) => {
          const line = i + 1;
          const isNext = nextToExecute?.line === line;
          const isJust = justExecuted?.line === line;
          return (
            <tr key={i} data-line={line} data-arrow={isNext ? "next" : isJust ? "just" : undefined}>
              <td className="arrow-cell">
                {isNext ? (
                  <Arrow color={RED_ARROW} title="next line to execute" />
                ) : isJust ? (
                  <Arrow color={GREEN_ARROW} title="line that just executed" />
                ) : null}
              </td>
              <td className="line-number">{line}</td>
              <td className="source-line">
                <MarkedLine text={text} line={line} just={justExecuted} next={nextToExecute} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
