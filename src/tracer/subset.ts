/**
 * Subset recogniser for the POC language subset.
 *
 * Purpose: (1) capability detection: refuse anything outside the subset with a
 * precise location; (2) source anchoring: record where each function, `let`
 * statement and final expression is, because the official WASM compiler emits
 * no source maps.
 *
 * It does NOT evaluate anything and does NOT decide program meaning: the
 * program only ever runs as JavaScript produced by the official compiler, and
 * this module runs only after the official compiler has accepted the program.
 *
 * Supported subset (Phase 2D):
 *   module      := import* function*
 *   import      := "import" "gleam/..." (a gleam_stdlib module; no `.{...}`, no `as`)
 *   function    := ["pub"] "fn" name "(" [param ("," param)* [","]] ")" ["->" type] "{" body "}"
 *   param       := name [":" type]
 *   type        := "Int" | "Bool" | "String" | "Nil"
 *   body        := statement* expr
 *   statement   := "let" name [":" type] "=" expr  |  expr
 *   expr        := Int/Bool/Nil/String literals, variables, calls to this module's functions,
 *                  calls to stdlib functions (module.fn(...)) whose declared result type is
 *                  Int, Bool, String or Nil, unary - and !,
 *                  binary <> + - * / % == != < > <= >= && ||
 */
import { checkStdlibCall, type StdlibInfo } from "./stdlib";

export interface Loc {
  line: number;
  column: number;
  endLine: number;
  endColumn: number; // exclusive
}

/** A statement before a function's final expression. */
export type SubsetStmt =
  /** `let name = expr`; loc runs from `let` to the end of the initializer. */
  | { kind: "let"; name: string; loc: Loc; hasCall: boolean }
  /** An expression evaluated for its effect, such as `io.println(x)`. */
  | { kind: "expr"; loc: Loc; hasCall: boolean };

export interface SubsetImport {
  /** e.g. "gleam/io" */
  module: string;
  /** The name used in calls, e.g. "io". */
  alias: string;
}

export interface SubsetFunction {
  name: string;
  isPublic: boolean;
  params: string[];
  /** `pub fn name(...) -> T {` */
  header: Loc;
  body: SubsetStmt[];
  /** The final expression whose value the function produces. */
  tail: { loc: Loc; hasCall: boolean };
  /** Signature text for display, e.g. `fn square(x: Int) -> Int`. */
  signature: string;
}

export interface SubsetModule {
  imports: SubsetImport[];
  functions: SubsetFunction[];
}

export interface SubsetOptions {
  /** Stdlib metadata; without it, any import is refused. */
  stdlib?: StdlibInfo;
}

export class UnsupportedError extends Error {
  constructor(
    public feature: string,
    public line: number,
    public column: number,
  ) {
    super(`${feature} (line ${line}, column ${column}) is not supported by the tracer yet`);
  }
}

// ---------------------------------------------------------------- tokenizer

/** "bad": a construct outside the subset; the parser reports `feature` if it reaches it. */
type TokKind = "int" | "string" | "lname" | "uname" | "kw" | "op" | "bad" | "eof";
interface Tok {
  kind: TokKind;
  feature?: string;
  text: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

const KEYWORDS = new Set(["pub", "fn", "let", "import"]);
/** Gleam keywords outside the subset, with the feature name shown to students. */
const UNSUPPORTED_KEYWORDS: Record<string, string> = {
  case: "case expressions",
  type: "Custom types",
  const: "Module constants",
  use: "use expressions",
  assert: "assert",
  panic: "panic",
  todo: "todo",
  echo: "echo",
  opaque: "Opaque types",
  as: "Aliases (as)",
  if: "if",
};
const OPERATORS = [
  "<=.", ">=.", "->", "<-", "||", "&&", "==", "!=", "<=", ">=", "<>", "|>", "..", "+.", "-.", "*.", "/.", "<.", ">.",
  "+", "-", "*", "/", "%", "<", ">", "=", "!", ":", ",", "(", ")", "{", "}", ".", "#", "[", "]", "@", "|",
];
const UNSUPPORTED_OPERATORS: Record<string, string> = {
  "<-": "use expressions",
  "|>": "Pipelines",
  "..": "List spreads and record updates",
  "+.": "Floats",
  "-.": "Floats",
  "*.": "Floats",
  "/.": "Floats",
  "<.": "Floats",
  ">.": "Floats",
  "<=.": "Floats",
  ">=.": "Floats",
  "#": "Tuples",
  "[": "Lists",
  "]": "Lists",
  "@": "Attributes and externals",
  "|": "Alternative patterns",
};

export function tokenize(source: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };
  while (i < source.length) {
    const rest = source.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      advance(ws[0].length);
      continue;
    }
    if (rest.startsWith("//")) {
      advance(/^[^\n]*/.exec(rest)![0].length);
      continue;
    }
    const startLine = line;
    const startCol = col;
    const push = (kind: TokKind, text: string, feature?: string) => {
      advance(text.length);
      toks.push({ kind, text, line: startLine, col: startCol, endLine: line, endCol: col, ...(feature ? { feature } : {}) });
    };
    if (rest[0] === '"') {
      // A Gleam string literal (it may span lines). The official compiler has
      // already accepted the program, so only its extent matters here.
      let j = 1;
      while (j < rest.length && rest[j] !== '"') j += rest[j] === "\\" ? 2 : 1;
      push("string", rest.slice(0, j + 1));
      continue;
    }
    const nonDecimal = /^0[xXoObB][0-9a-fA-F_]*/.exec(rest);
    if (nonDecimal) {
      push("bad", nonDecimal[0], "Non-decimal Int literals");
      continue;
    }
    const float = /^\d[\d_]*\.[\d_]*(?:e-?\d+)?/.exec(rest);
    if (float) {
      push("bad", float[0], "Floats");
      continue;
    }
    const num = /^\d[\d_]*/.exec(rest);
    if (num) {
      push("int", num[0]);
      continue;
    }
    const lname = /^[a-z_][a-z0-9_]*/.exec(rest);
    if (lname) {
      const w = lname[0];
      if (w.startsWith("_")) push("bad", w, "Discard names (starting with _)");
      else if (UNSUPPORTED_KEYWORDS[w]) push("bad", w, UNSUPPORTED_KEYWORDS[w]);
      else push(KEYWORDS.has(w) ? "kw" : "lname", w);
      continue;
    }
    const uname = /^[A-Z][A-Za-z0-9]*/.exec(rest);
    if (uname) {
      push("uname", uname[0]);
      continue;
    }
    const op = OPERATORS.find((o) => rest.startsWith(o));
    if (op) {
      if (UNSUPPORTED_OPERATORS[op]) push("bad", op, UNSUPPORTED_OPERATORS[op]);
      else push("op", op);
      continue;
    }
    push("bad", rest[0], `Character ${JSON.stringify(rest[0])}`);
  }
  toks.push({ kind: "eof", text: "", line, col, endLine: line, endCol: col });
  return toks;
}

// ---------------------------------------------------------------- parser

const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  ">": 4,
  "<=": 4,
  ">=": 4,
  "<>": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};

interface ExprInfo {
  hasCall: boolean;
  last: Tok;
}

interface PendingName {
  name: string;
  tok: Tok;
  kind: "value" | "call";
  locals: Set<string>;
}

export function parseSubset(source: string, options: SubsetOptions = {}): SubsetModule {
  const toks = tokenize(source);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  // The first construct the parser cannot handle is reported; if that is an
  // unsupported token, its own feature name is the clearer message.
  const fail = (feature: string, t: Tok = peek()): never => {
    throw new UnsupportedError(t.kind === "bad" ? t.feature! : feature, t.line, t.col);
  };
  const expect = (text: string, feature: string) => {
    if (peek().text !== text || peek().kind === "eof") fail(feature);
    return next();
  };
  const names: PendingName[] = [];

  const parseType = (): string => {
    const t = peek();
    if (t.kind === "kw" && t.text === "fn") fail("Function types");
    if (t.kind !== "uname") fail("This type annotation");
    if (!["Int", "Bool", "String", "Nil"].includes(t.text)) fail(`The type ${t.text}`);
    next();
    if (peek().text === "(") fail("Generic types");
    return t.text;
  };

  const parsePrimary = (locals: Set<string>): ExprInfo => {
    const t = peek();
    if (t.kind === "int" || t.kind === "string") {
      next();
      return { hasCall: false, last: t };
    }
    if (t.kind === "uname") {
      if (t.text !== "True" && t.text !== "False" && t.text !== "Nil") fail("Custom type constructors");
      next();
      return { hasCall: false, last: t };
    }
    if (t.kind === "op" && (t.text === "-" || t.text === "!")) {
      next();
      return parsePrimary(locals);
    }
    if (t.kind === "lname") {
      next();
      if (peek().text === ".") {
        // module.function(...) for an imported stdlib module
        const imp = imports.find((i) => i.alias === t.text);
        if (!imp || locals.has(t.text)) fail("Record field access", peek());
        next();
        const fnTok = peek();
        if (fnTok.kind !== "lname") fail("Module constants and constructors", fnTok);
        next();
        if (peek().text !== "(") fail(`Using ${t.text}.${fnTok.text} as a value`, fnTok);
        const check = checkStdlibCall(options.stdlib!, imp!.module, imp!.alias, fnTok.text);
        if (!check.ok) fail(check.feature, t);
        return parseArgs(locals);
      }
      if (peek().text === "(") {
        names.push({ name: t.text, tok: t, kind: "call", locals: new Set(locals) });
        return parseArgs(locals);
      }
      names.push({ name: t.text, tok: t, kind: "value", locals: new Set(locals) });
      return { hasCall: false, last: t };
    }
    if (t.kind === "kw" && t.text === "fn") fail("Anonymous functions");
    if (t.text === "{") fail("Blocks");
    if (t.text === "(") fail("Parenthesised expressions");
    return fail("This expression");
  };

  /** Arguments of a call, from "(" to ")"; the call itself counts as a call. */
  const parseArgs = (locals: Set<string>): ExprInfo => {
    next(); // (
    while (peek().text !== ")") {
      if (peek().kind === "lname" && toks[p + 1]?.text === ":") fail("Labelled arguments");
      if (peek().text === "_") fail("Function captures (like add(10, _))", { ...peek(), kind: "op" });
      parseExpr(locals, 0);
      if (peek().text === ",") next();
      else if (peek().text !== ")") fail("This argument syntax");
    }
    const close = next();
    if (peek().text === "(") fail("Calling the result of a call");
    return { hasCall: true, last: close };
  };

  const parseExpr = (locals: Set<string>, minPrec: number): ExprInfo => {
    let left = parsePrimary(locals);
    for (;;) {
      const op = peek();
      const prec = op.kind === "op" ? BINARY_PRECEDENCE[op.text] : undefined;
      if (prec === undefined || prec <= minPrec) return left;
      next();
      const right = parseExpr(locals, prec);
      left = { hasCall: left.hasCall || right.hasCall, last: right.last };
    }
  };

  const locOf = (start: Tok, end: Tok): Loc => ({ line: start.line, column: start.col, endLine: end.endLine, endColumn: end.endCol });

  const imports: SubsetImport[] = [];
  while (peek().text === "import") {
    const importTok = next();
    const parts: string[] = [];
    for (;;) {
      const seg = peek();
      if (seg.kind !== "lname") fail("This import", seg);
      parts.push(next().text);
      if (peek().text !== "/") break;
      next();
    }
    const module = parts.join("/");
    if (peek().text === ".") fail("Unqualified imports (import module.{...})");
    if (!options.stdlib?.modules[module]) {
      fail(`Importing ${module} (only gleam_stdlib modules can be imported)`, importTok);
    }
    const alias = parts[parts.length - 1];
    if (imports.some((i) => i.alias === alias)) fail(`Two imports named ${alias}`, importTok);
    imports.push({ module, alias });
  }

  const functions: SubsetFunction[] = [];
  while (peek().kind !== "eof") {
    if (peek().text === "import") fail("Imports after function definitions");
    const start = peek();
    let isPublic = false;
    if (peek().text === "pub") {
      next();
      isPublic = true;
    }
    if (peek().text !== "fn") fail("Only function definitions are supported at the top level; this");
    next();
    const nameTok = peek();
    if (nameTok.kind !== "lname") fail("This function name");
    next();
    expect("(", "This function header");
    const params: string[] = [];
    const sigParams: string[] = [];
    while (peek().text !== ")") {
      const pt = peek();
      if (pt.kind !== "lname") fail("This parameter");
      next();
      if (peek().kind === "lname") fail("Labelled parameters");
      let typeText = "";
      if (peek().text === ":") {
        next();
        typeText = parseType();
      }
      params.push(pt.text);
      sigParams.push(typeText ? `${pt.text}: ${typeText}` : pt.text);
      if (peek().text === ",") next();
      else if (peek().text !== ")") fail("This parameter list");
    }
    next(); // )
    let returnType = "";
    if (peek().text === "->") {
      next();
      returnType = parseType();
    }
    const open = expect("{", "This function body");
    const locals = new Set(params);
    const body: SubsetStmt[] = [];
    let tail: SubsetFunction["tail"] | null = null;
    while (peek().text !== "}") {
      if (peek().kind === "eof") fail("An unclosed function body");
      const stmtStart = peek();
      if (stmtStart.text === "let") {
        next();
        const n = peek();
        if (n.text === "assert") fail("let assert");
        if (n.kind !== "lname") fail("Destructuring patterns in let");
        next();
        if (peek().text === ":") {
          next();
          parseType();
        }
        expect("=", "This let statement");
        const e = parseExpr(locals, 0);
        body.push({ kind: "let", name: n.text, loc: locOf(stmtStart, e.last), hasCall: e.hasCall });
        locals.add(n.text);
      } else {
        const e = parseExpr(locals, 0);
        const stmt = { loc: locOf(stmtStart, e.last), hasCall: e.hasCall };
        if (peek().text === "}") tail = stmt;
        else body.push({ kind: "expr", ...stmt });
      }
    }
    if (!tail) fail("A function body that ends with a let (it needs a final expression)");
    next(); // }
    functions.push({
      name: nameTok.text,
      isPublic,
      params,
      header: locOf(start, open),
      body,
      tail: tail!,
      signature: `fn ${nameTok.text}(${sigParams.join(", ")})${returnType ? ` -> ${returnType}` : ""}`,
    });
  }

  // Name checks after all functions are known (calls may refer to later functions).
  const fnNames = new Set(functions.map((f) => f.name));
  for (const n of names) {
    if (n.kind === "value" && !n.locals.has(n.name) && fnNames.has(n.name)) {
      throw new UnsupportedError(`Using the function ${n.name} as a value`, n.tok.line, n.tok.col);
    }
    if (n.kind === "call" && (n.locals.has(n.name) || !fnNames.has(n.name))) {
      throw new UnsupportedError("Calling a function that is not defined in this module", n.tok.line, n.tok.col);
    }
  }
  const main = functions.find((f) => f.name === "main");
  if (!main || !main.isPublic || main.params.length > 0) {
    throw new UnsupportedError("Programs without `pub fn main()`", 1, 1);
  }
  return { imports, functions };
}
