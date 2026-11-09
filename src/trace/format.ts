/**
 * Displays values the way they are written in Gleam source.
 */

/**
 * A Gleam string literal for `s`: quotes and backslashes escaped, \n \r \t \f
 * written as escapes, other control characters as \u{XX}; every other
 * character (including emoji and non-Latin text) shown as itself.
 */
export function gleamStringLiteral(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) out += `\\u{${code.toString(16).toUpperCase()}}`;
    else out += ch;
  }
  return out + '"';
}
