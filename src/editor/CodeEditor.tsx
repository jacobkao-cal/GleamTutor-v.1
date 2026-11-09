/**
 * Plain code editor: a transparent <textarea> laid over a highlighted <pre>,
 * with a line-number gutter, all inside one scroll container so they stay
 * aligned. Kept deliberately simple to match Python Tutor's editor proportions.
 */
import { useState, type KeyboardEvent } from "react";
import { HighlightedLine } from "./HighlightedLine";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

const INDENT = "  ";

export function CodeEditor({ value, onChange }: Props) {
  const [cursorLine, setCursorLine] = useState(1);
  const lines = value.split("\n");

  const trackCursor = (el: HTMLTextAreaElement) => {
    setCursorLine(el.value.slice(0, el.selectionStart).split("\n").length);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab inserts spaces instead of leaving the editor (Shift+Tab still moves focus).
    if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: end } = el;
      const next = value.slice(0, s) + INDENT + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = s + INDENT.length;
      });
    }
  };

  return (
    <div className="code-editor">
      <div className="code-editor-inner">
        <div className="code-editor-gutter" aria-hidden="true">
          {lines.map((_, i) => (
            <div key={i} className={i + 1 === cursorLine ? "gutter-line gutter-line-active" : "gutter-line"}>
              {i + 1}
            </div>
          ))}
        </div>
        <div className="code-editor-area">
          <pre className="code-editor-highlight" aria-hidden="true">
            {lines.map((line, i) => (
              <div key={i} className="code-editor-hl-line">
                <HighlightedLine text={line} />
              </div>
            ))}
          </pre>
          <textarea
            className="code-editor-input"
            aria-label="Gleam source code"
            value={value}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            wrap="off"
            onChange={(e) => {
              onChange(e.target.value);
              trackCursor(e.target);
            }}
            onKeyDown={onKeyDown}
            onSelect={(e) => trackCursor(e.currentTarget)}
            onClick={(e) => trackCursor(e.currentTarget)}
          />
        </div>
      </div>
    </div>
  );
}
