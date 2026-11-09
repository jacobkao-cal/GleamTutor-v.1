/**
 * A small, display-only Gleam tokenizer for syntax colouring.
 * It does not parse or validate Gleam; unknown text is left uncoloured.
 */
export type TokenKind = "keyword" | "type" | "string" | "number" | "comment" | "operator" | "plain";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set([
  "as", "assert", "case", "const", "echo", "fn", "if", "import", "let", "opaque",
  "panic", "pub", "todo", "type", "use",
]);

const RULES: [TokenKind | "word", RegExp][] = [
  ["comment", /\/\/[^\n]*/y],
  ["string", /"(?:[^"\\]|\\.)*"?/y],
  ["number", /\d[\d_]*(?:\.[\d_]*)?(?:e-?\d+)?/y],
  ["word", /[A-Za-z_][A-Za-z0-9_]*/y],
  ["operator", /->|<-|\|>|\.\.|<>|[+\-*/%]\.?|==|!=|<=\.?|>=\.?|<\.?|>\.?|&&|\|\||[=!|]/y],
];

export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let plain = "";
  const flush = () => {
    if (plain) tokens.push({ kind: "plain", text: plain });
    plain = "";
  };
  outer: while (pos < line.length) {
    for (const [kind, re] of RULES) {
      re.lastIndex = pos;
      const m = re.exec(line);
      if (m && m[0].length > 0) {
        flush();
        const text = m[0];
        const k: TokenKind =
          kind === "word" ? (KEYWORDS.has(text) ? "keyword" : /^[A-Z]/.test(text) ? "type" : "plain") : kind;
        if (k === "plain") plain += text;
        else tokens.push({ kind: k, text });
        pos += text.length;
        continue outer;
      }
    }
    plain += line[pos++];
  }
  flush();
  return tokens;
}
