/**
 * Subset recogniser.
 *
 * Purpose: (1) capability detection: refuse anything outside the subset with a
 * precise location; (2) source anchoring: record the source regions the
 * instrumenter wraps with probes (instrument.ts), with their locations,
 * because the official WASM compiler emits no source maps.
 *
 * It does NOT evaluate anything and does NOT decide program meaning: the
 * program only ever runs as JavaScript produced by the official compiler, and
 * this module runs only after the official compiler has accepted the program.
 *
 * Supported subset (Phase 3C):
 *   module      := import* function*
 *   import      := "import" "gleam/..." ["." "{" item ("," item)* "}"] ["as" name]
 *                  (a gleam_stdlib module; item := name ["as" name] | "type" Name ["as" Name] | Name)
 *   function    := ["pub"] "fn" name "(" [param ("," param)* [","]] ")" ["->" type] "{" body "}"
 *   param       := name [":" type]
 *   type        := "Int" | "Bool" | "String" | "Nil" | "List(" type ")" | type variable
 *   body        := statement* expr
 *   statement   := "let" (name | _discard) [":" type] "=" expr  |  expr
 *   expr        := Int/Bool/Nil/String literals, variables, calls to this module's functions,
 *                  calls to stdlib functions (module.fn(...), or fn(...) when imported unqualified)
 *                  whose declared result type can be shown (stdlib.ts: isDisplayableType),
 *                  list literals [a, b] / [a, ..rest] / [], case expressions, blocks { ... },
 *                  unary - and !, binary <> + - * / % == != < > <= >= && ||
 *   case        := "case" expr ("," expr)* "{" clause+ "}"
 *   clause      := pattern ("," pattern)* ["if" expr] "->" (expr | "{" body "}")
 *   pattern     := Int/String/True/False/Nil literal | name | _discard
 *                | "[" [pattern ("," pattern)*] ["," ".." [name | _discard]] "]"
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
  /** `let name = expr`; loc runs from `let` to the end of the initializer. `name` is null for a discard. */
  | { kind: "let"; name: string | null; loc: Loc; hasCall: boolean }
  /** An expression evaluated for its effect, such as `io.println(x)`. */
  | { kind: "expr"; loc: Loc; hasCall: boolean };

/**
 * A source region the instrumenter wraps with probes. `start`/`end` are
 * offsets into the source; `children` are the regions nested inside it, in
 * source order.
 *  - fnbody: the inside of a function body (enter + parameters)
 *  - let / expr: a statement (about-to-evaluate, then bind / done)
 *  - tail: a function's final expression (about-to-evaluate, then return)
 *  - case: a case expression (its clause's variables go out of scope after it)
 *  - clause: a clause body (the clause was selected; pattern variables)
 *  - block: a `{ ... }` expression (its bindings go out of scope after it)
 *  - tailarg / tailcall0: a self-call in tail position (the last argument, or
 *    the whole call when it has none); marked so the trace can label the
 *    frame it creates as logical, when the compiler made the function a loop
 *  - plain: no probe of its own; holds nested regions (a block's final
 *    expression, or a possible tail call that turned out not to be one)
 */
export interface Region {
  kind: "fnbody" | "let" | "expr" | "tail" | "case" | "clause" | "block" | "tailarg" | "tailcall0" | "plain";
  start: number;
  end: number;
  loc: Loc;
  /** fnbody: function name; let: bound name (null for a discard); tailarg / tailcall0: the called function. */
  name?: string | null;
  /** A possible tail call: the kind it becomes if it turns out to be in tail position. */
  ifTail?: "tailarg" | "tailcall0";
  /** fnbody: parameters; clause: pattern variables. */
  vars?: string[];
  /** case / clause / block: which scope (case expression or block). */
  caseId?: number;
  children: Region[];
}

export interface SubsetImport {
  /** e.g. "gleam/io" */
  module: string;
  /** The name used in qualified calls, e.g. "io" (or the `as` alias). */
  alias: string;
  /** Unqualified value imports: local name -> the module's function name (`import gleam/io.{println as say}`). */
  values: Map<string, string>;
}

export interface SubsetFunction {
  name: string;
  isPublic: boolean;
  params: string[];
  /** `pub fn name(...) -> T {` */
  header: Loc;
  /** Top-level statements of the body. */
  body: SubsetStmt[];
  /** The final expression whose value the function produces. */
  tail: { loc: Loc; hasCall: boolean };
  /** Signature text for display, e.g. `fn square(x: Int) -> Int`. */
  signature: string;
  /** The body region (kind "fnbody") with every nested region. */
  region: Region;
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

/** Identifiers the instrumenter uses; student code may not use them. */
export const RESERVED_PREFIX = "gleam_tutor";

// ---------------------------------------------------------------- tokenizer

/** "bad": a construct outside the subset (or allowed only in certain places); the parser reports `feature` if it reaches it. */
type TokKind = "int" | "string" | "lname" | "uname" | "kw" | "op" | "bad" | "eof";
interface Tok {
  kind: TokKind;
  feature?: string;
  text: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** Source offsets: [start, end). */
  start: number;
  end: number;
}

const KEYWORDS = new Set(["pub", "fn", "let", "import"]);
/** Gleam keywords outside the subset (or allowed only in certain places), with the feature name shown to students. */
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
    const start = i;
    const push = (kind: TokKind, text: string, feature?: string) => {
      advance(text.length);
      toks.push({ kind, text, line: startLine, col: startCol, endLine: line, endCol: col, start, end: i, ...(feature ? { feature } : {}) });
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
  toks.push({ kind: "eof", text: "", line, col, endLine: line, endCol: col, start: i, end: i });
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
  first: Tok;
  last: Tok;
  /**
   * Self-calls that would be tail calls if this whole expression is in tail
   * position: the expression itself, or the bodies of a case / the end of a
   * block that it is. Anything combined with an operator is not.
   */
  tails?: Region[];
}

interface PendingName {
  name: string;
  tok: Tok;
  kind: "value" | "call";
  locals: Set<string>;
}

const isDiscard = (t: Tok) => t.kind === "bad" && t.text.startsWith("_");

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
  const locOf = (start: Tok, end: Tok): Loc => ({ line: start.line, column: start.col, endLine: end.endLine, endColumn: end.endCol });
  const checkName = (t: Tok) => {
    if (t.text.startsWith(RESERVED_PREFIX)) fail(`Names starting with ${RESERVED_PREFIX} (reserved by Gleam Tutor)`, { ...t, kind: "op" });
  };

  // Regions are attached to the innermost open region, in source order.
  const open: Region[][] = [];
  const addRegion = (r: Region) => {
    open[open.length - 1].push(r);
    return r;
  };
  const inside = <T,>(r: Region, f: () => T): T => {
    open.push(r.children);
    try {
      return f();
    } finally {
      open.pop();
    }
  };
  let caseCount = 0;
  /** The function being parsed (self-calls are possible tail calls). */
  let currentFn = "";

  const parseType = (): string => {
    const t = peek();
    if (t.kind === "kw" && t.text === "fn") fail("Function types");
    if (t.kind === "lname") {
      next();
      return t.text; // a type variable
    }
    if (t.kind !== "uname") fail("This type annotation");
    if (t.text === "List") {
      next();
      expect("(", "This type annotation");
      const inner = parseType();
      expect(")", "This type annotation");
      return `List(${inner})`;
    }
    if (!["Int", "Bool", "String", "Nil"].includes(t.text)) fail(`The type ${t.text}`);
    next();
    if (peek().text === "(") fail("Generic types");
    return t.text;
  };

  /**
   * Arguments of a call, from "(" to ")"; the call itself counts as a call.
   * For a self-call (`self`), each argument gets a region, so the last one
   * can carry the tail-call marker if the call turns out to be a tail call.
   */
  const parseArgs = (locals: Set<string>, first: Tok, self?: string): ExprInfo => {
    next(); // (
    const argRegions: Region[] = [];
    while (peek().text !== ")") {
      if (peek().kind === "lname" && toks[p + 1]?.text === ":") fail("Labelled arguments");
      if (peek().text === "_") fail("Function captures (like add(10, _))", { ...peek(), kind: "op" });
      if (self) {
        const at = peek();
        const r = addRegion({ kind: "plain", start: at.start, end: at.end, loc: locOf(at, at), children: [] });
        r.end = inside(r, () => parseExpr(locals, 0)).last.end;
        argRegions.push(r);
      } else parseExpr(locals, 0);
      if (peek().text === ",") next();
      else if (peek().text !== ")") fail("This argument syntax");
    }
    const close = next();
    if (peek().text === "(") fail("Calling the result of a call");
    if (!self) return { hasCall: true, first, last: close };
    const candidate =
      argRegions.length > 0
        ? Object.assign(argRegions[argRegions.length - 1], { name: self, ifTail: "tailarg" as const })
        : addRegion({ kind: "plain", start: first.start, end: close.end, loc: locOf(first, close), name: self, ifTail: "tailcall0", children: [] });
    return { hasCall: true, first, last: close, tails: [candidate] };
  };

  /** `[a, b]`, `[a, ..rest]`, `[]` */
  const parseListLiteral = (locals: Set<string>): ExprInfo => {
    const openTok = next(); // [
    let hasCall = false;
    while (peek().text !== "]") {
      if (peek().text === "..") {
        next();
        hasCall = parseExpr(locals, 0).hasCall || hasCall;
        break;
      }
      hasCall = parseExpr(locals, 0).hasCall || hasCall;
      if (peek().text === ",") next();
      else if (peek().text !== "]") fail("This list syntax");
    }
    return { hasCall, first: openTok, last: expect("]", "This list syntax") };
  };

  /** A pattern; names it binds are added to `vars`. */
  const parsePattern = (vars: string[]): void => {
    const t = peek();
    if (t.kind === "int") {
      next();
      return;
    }
    if (t.text === "-" && toks[p + 1]?.kind === "int") {
      next();
      next();
      return;
    }
    if (t.kind === "string") {
      next();
      if (peek().text === "<>") fail('String prefix patterns ("a" <> rest)');
      return;
    }
    if (t.kind === "uname") {
      if (t.text !== "True" && t.text !== "False" && t.text !== "Nil") fail("Custom type constructors in patterns");
      next();
      return;
    }
    if (t.kind === "lname") {
      checkName(t);
      if (vars.includes(t.text)) fail(`Binding ${t.text} twice in one pattern`);
      vars.push(t.text);
      next();
      return;
    }
    if (isDiscard(t)) {
      next();
      return;
    }
    if (t.text === "[") {
      next();
      while (peek().text !== "]") {
        if (peek().text === "..") {
          next();
          const rest = peek();
          if (rest.kind === "lname" || isDiscard(rest)) parsePattern(vars);
          break;
        }
        parsePattern(vars);
        if (peek().text === ",") next();
        else if (peek().text !== "]" && peek().text !== "..") fail("This list pattern");
      }
      expect("]", "This list pattern");
      return;
    }
    fail("This pattern");
  };

  /** `case subjects { clauses }` */
  const parseCase = (locals: Set<string>): ExprInfo => {
    const caseTok = next(); // case
    const caseId = ++caseCount;
    const region = addRegion({ kind: "case", start: caseTok.start, end: caseTok.end, loc: locOf(caseTok, caseTok), caseId, children: [] });
    return inside(region, () => {
      let subjects = 0;
      for (;;) {
        parseExpr(locals, 0);
        subjects++;
        if (peek().text === ",") next();
        else break;
      }
      expect("{", "This case expression");
      const tails: Region[] = [];
      do {
        const patStart = peek();
        const vars: string[] = [];
        for (let i = 0; i < subjects; i++) {
          parsePattern(vars);
          if (i < subjects - 1) expect(",", "A clause with too few patterns");
        }
        const bodyLocals = new Set([...locals, ...vars]);
        if (peek().text === "if") {
          next();
          parseExpr(bodyLocals, 0); // a guard
        }
        const arrow = expect("->", "This clause");
        const clause = addRegion({
          kind: "clause",
          start: peek().start,
          end: peek().end,
          loc: locOf(patStart, arrow),
          caseId,
          vars,
          children: [],
        });
        inside(clause, () => {
          if (peek().text === "{") {
            next();
            tails.push(...(parseBlockBody(bodyLocals).tails ?? []));
            clause.end = expect("}", "This block").end;
          } else {
            const body = parseExpr(bodyLocals, 0);
            tails.push(...(body.tails ?? []));
            clause.end = body.last.end;
          }
        });
      } while (peek().text !== "}" && peek().kind !== "eof");
      const close = expect("}", "This case expression");
      region.end = close.end;
      region.loc = locOf(caseTok, close);
      return { hasCall: true, first: caseTok, last: close, tails };
    });
  };

  const parsePrimary = (locals: Set<string>): ExprInfo => {
    const t = peek();
    if (t.kind === "int" || t.kind === "string") {
      next();
      return { hasCall: false, first: t, last: t };
    }
    if (t.kind === "uname") {
      if (t.text !== "True" && t.text !== "False" && t.text !== "Nil") fail("Custom type constructors");
      next();
      return { hasCall: false, first: t, last: t };
    }
    if (t.kind === "op" && (t.text === "-" || t.text === "!")) {
      next();
      const e = parsePrimary(locals);
      return { ...e, first: t, tails: [] };
    }
    if (t.text === "[") return parseListLiteral(locals);
    if (t.text === "case") return parseCase(locals);
    if (t.kind === "lname") {
      checkName(t);
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
        const check = checkStdlibCall(options.stdlib!, imp!.module, `${imp!.alias}.${fnTok.text}`, fnTok.text);
        if (!check.ok) fail(check.feature, t);
        return parseArgs(locals, t);
      }
      const unqualified = locals.has(t.text) ? undefined : imports.find((i) => i.values.has(t.text));
      if (unqualified) {
        // A stdlib function imported unqualified: `import gleam/io.{println}` ... `println(x)`
        if (peek().text !== "(") fail(`Using ${t.text} as a value`, t);
        const check = checkStdlibCall(options.stdlib!, unqualified.module, t.text, unqualified.values.get(t.text)!);
        if (!check.ok) fail(check.feature, t);
        return parseArgs(locals, t);
      }
      if (peek().text === "(") {
        names.push({ name: t.text, tok: t, kind: "call", locals: new Set(locals) });
        return parseArgs(locals, t, t.text === currentFn && !locals.has(t.text) ? t.text : undefined);
      }
      names.push({ name: t.text, tok: t, kind: "value", locals: new Set(locals) });
      return { hasCall: false, first: t, last: t };
    }
    if (t.kind === "kw" && t.text === "fn") fail("Anonymous functions");
    if (t.text === "{") {
      // A block: its bindings belong to it and go out of scope after it.
      const openTok = next();
      const region = addRegion({ kind: "block", start: openTok.start, end: openTok.end, loc: locOf(openTok, openTok), caseId: ++caseCount, children: [] });
      return inside(region, () => {
        const final = parseBlockBody(locals);
        const close = expect("}", "This block");
        region.end = close.end;
        region.loc = locOf(openTok, close);
        return { hasCall: true, first: openTok, last: close, tails: final.tails };
      });
    }
    if (t.text === "(") fail("Parenthesised expressions");
    return fail("This expression");
  };

  const parseExpr = (locals: Set<string>, minPrec: number): ExprInfo => {
    let left = parsePrimary(locals);
    for (;;) {
      const op = peek();
      const prec = op.kind === "op" ? BINARY_PRECEDENCE[op.text] : undefined;
      if (prec === undefined || prec <= minPrec) return left;
      next();
      const right = parseExpr(locals, prec);
      left = { hasCall: left.hasCall || right.hasCall, first: left.first, last: right.last, tails: [] };
    }
  };

  /**
   * Statements up to (not including) the closing "}". In a function body the
   * final expression is a "tail" region; in a block it is "plain".
   */
  const parseStatements = (
    locals: Set<string>,
    finalKind: "tail" | "plain",
  ): { stmts: SubsetStmt[]; tail: SubsetFunction["tail"] | null; final: ExprInfo | null } => {
    const stmts: SubsetStmt[] = [];
    let tail: SubsetFunction["tail"] | null = null;
    let final: ExprInfo | null = null;
    while (peek().text !== "}") {
      if (peek().kind === "eof") fail("An unclosed function body");
      const stmtStart = peek();
      if (stmtStart.text === "let") {
        const region = addRegion({ kind: "let", start: stmtStart.start, end: stmtStart.end, loc: locOf(stmtStart, stmtStart), children: [] });
        next();
        const n = peek();
        if (n.text === "assert") fail("let assert");
        let name: string | null = null;
        if (n.kind === "lname") {
          checkName(n);
          name = n.text;
        } else if (!isDiscard(n)) fail("Destructuring patterns in let");
        next();
        if (peek().text === ":") {
          next();
          parseType();
        }
        expect("=", "This let statement");
        const e = inside(region, () => parseExpr(locals, 0));
        region.end = e.last.end;
        region.loc = locOf(stmtStart, e.last);
        region.name = name;
        stmts.push({ kind: "let", name, loc: region.loc, hasCall: e.hasCall });
        if (name) locals.add(name);
      } else {
        const region = addRegion({ kind: "expr", start: stmtStart.start, end: stmtStart.end, loc: locOf(stmtStart, stmtStart), children: [] });
        const e = inside(region, () => parseExpr(locals, 0));
        region.end = e.last.end;
        region.loc = locOf(stmtStart, e.last);
        if (peek().text === "}") {
          region.kind = finalKind;
          tail = { loc: region.loc, hasCall: e.hasCall };
          final = e;
          // The function's final expression: its possible tail calls are tail calls.
          if (finalKind === "tail") for (const r of e.tails ?? []) r.kind = r.ifTail!;
        } else stmts.push({ kind: "expr", loc: region.loc, hasCall: e.hasCall });
      }
    }
    return { stmts, tail, final };
  };

  /** The inside of a `{ ... }` block or clause body; returns its final expression. */
  const parseBlockBody = (locals: Set<string>): ExprInfo => {
    const { final } = parseStatements(new Set(locals), "plain");
    if (!final) fail("A block that ends with a let (it needs a final expression)");
    return final!;
  };

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
    if (!options.stdlib?.modules[module]) {
      fail(`Importing ${module} (only gleam_stdlib modules can be imported)`, importTok);
    }
    const values = new Map<string, string>();
    if (peek().text === ".") {
      // Unqualified imports: functions are callable by name; types and constructors are only named here.
      next();
      expect("{", "This import");
      while (peek().text !== "}") {
        const item = peek();
        if (item.text === "type") {
          next();
          if (peek().kind !== "uname") fail("This import");
          next();
          if (peek().text === "as") {
            next();
            next();
          }
        } else if (item.kind === "uname") {
          next(); // a constructor; using it is refused where it is used
          if (peek().text === "as") {
            next();
            next();
          }
        } else if (item.kind === "lname") {
          next();
          let local = item.text;
          if (peek().text === "as") {
            next();
            const aliasTok = peek();
            if (aliasTok.kind !== "lname") fail("This import");
            local = next().text;
          }
          checkName({ ...item, text: local });
          values.set(local, item.text);
        } else fail("This import");
        if (peek().text === ",") next();
        else if (peek().text !== "}") fail("This import");
      }
      next(); // }
    }
    let alias = parts[parts.length - 1];
    if (peek().text === "as") {
      next();
      const aliasTok = peek();
      if (aliasTok.kind !== "lname") fail("This import");
      alias = next().text;
    }
    if (imports.some((i) => i.alias === alias)) fail(`Two imports named ${alias}`, importTok);
    imports.push({ module, alias, values });
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
    checkName(nameTok);
    next();
    currentFn = nameTok.text;
    expect("(", "This function header");
    const params: string[] = [];
    const sigParams: string[] = [];
    while (peek().text !== ")") {
      const pt = peek();
      if (pt.kind !== "lname") fail("This parameter");
      checkName(pt);
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
    const openTok = expect("{", "This function body");
    const region: Region = { kind: "fnbody", start: openTok.end, end: openTok.end, loc: locOf(start, openTok), name: nameTok.text, vars: params, children: [] };
    const { stmts, tail } = inside(region, () => parseStatements(new Set(params), "tail"));
    if (!tail) fail("A function body that ends with a let (it needs a final expression)");
    region.end = peek().start;
    next(); // }
    functions.push({
      name: nameTok.text,
      isPublic,
      params,
      header: locOf(start, openTok),
      body: stmts,
      tail: tail!,
      signature: `fn ${nameTok.text}(${sigParams.join(", ")})${returnType ? ` -> ${returnType}` : ""}`,
      region,
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
