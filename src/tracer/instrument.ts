/**
 * Instruments the JavaScript produced by the official Gleam compiler.
 *
 * Each compiled function is first ALIGNED with the subset recogniser's view of
 * the Gleam source: same functions, same parameters, the same `let` bindings
 * in the same order, then one `return`. Any difference (an unexpected compiled
 * shape, a temporary, a loop, a branch) makes the program unsupported; we never
 * guess a mapping.
 *
 * Then recording calls are spliced in. They only observe values that the
 * compiled program computes; they never compute values themselves.
 */
import { parse } from "acorn";
import type { Loc, SubsetFunction, SubsetModule } from "./subset";

export class AlignmentError extends Error {}

/** Name of the per-run recorder; `$__` identifiers cannot come from Gleam source. */
export const RECORDER = "$__gt";
const FRAME = "$__frame";
export const RECORDER_SYMBOL = "gleam-tutor.tracer";

// Minimal ESTree shapes used here (acorn returns these at runtime).
interface Node {
  type: string;
  start: number;
  end: number;
}
interface Identifier extends Node {
  name: string;
}
interface FunctionDeclaration extends Node {
  id: Identifier;
  params: Node[];
  body: Node & { body: Node[] };
}
interface VariableDeclaration extends Node {
  kind: string;
  declarations: (Node & { id: Node; init: Node | null })[];
}
interface ReturnStatement extends Node {
  argument: Node | null;
}

/**
 * Maps a compiler-generated identifier back to its Gleam name. The compiler
 * appends `$` to JS reserved words (`class` -> `class$`) and `$N` to shadowed
 * names (`x` -> `x$1`).
 */
export function gleamNameOf(jsName: string): string {
  return jsName.replace(/\$\d+$/, "").replace(/\$$/, "");
}

const locLiteral = (l: Loc) => `[${l.line}, ${l.column}, ${l.endLine}, ${l.endColumn}]`;

interface Edit {
  at: number;
  text: string;
}

export function instrument(js: string, module: SubsetModule): string {
  const program = parse(js, { ecmaVersion: "latest", sourceType: "module" }) as unknown as Node & { body: Node[] };
  const edits: Edit[] = [];
  const seen = new Set<string>();

  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration") {
      const src = (stmt as Node & { source: { value: string } }).source.value;
      if (src !== "./gleam.mjs") throw new AlignmentError(`unexpected import of ${src}`);
      continue;
    }
    const decl = (stmt.type === "ExportNamedDeclaration" ? (stmt as Node & { declaration: Node | null }).declaration : stmt) as Node | null;
    if (!decl || decl.type !== "FunctionDeclaration") {
      throw new AlignmentError(`unexpected top-level ${decl?.type ?? stmt.type}`);
    }
    const fnNode = decl as FunctionDeclaration;
    const name = gleamNameOf(fnNode.id.name);
    const fn = module.functions.find((f) => f.name === name);
    if (!fn) throw new AlignmentError(`compiled function ${fnNode.id.name} has no source counterpart`);
    if (seen.has(name)) throw new AlignmentError(`duplicate function ${name}`);
    seen.add(name);
    edits.push(...instrumentFunction(fnNode, fn));
  }
  for (const f of module.functions) {
    if (!seen.has(f.name)) throw new AlignmentError(`source function ${f.name} is missing from compiled output`);
  }

  let out = js;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return `const ${RECORDER} = globalThis[Symbol.for(${JSON.stringify(RECORDER_SYMBOL)})];\n` + out;
}

function instrumentFunction(node: FunctionDeclaration, fn: SubsetFunction): Edit[] {
  const params = node.params.map((p) => {
    if (p.type !== "Identifier") throw new AlignmentError(`${fn.name}: non-identifier parameter`);
    return (p as Identifier).name;
  });
  if (params.length !== fn.params.length || params.some((p, i) => gleamNameOf(p) !== fn.params[i])) {
    throw new AlignmentError(`${fn.name}: parameters differ from source`);
  }

  const body = node.body.body;
  if (body.length !== fn.lets.length + 1) {
    throw new AlignmentError(`${fn.name}: compiled body has ${body.length} statements, expected ${fn.lets.length + 1}`);
  }
  const edits: Edit[] = [];
  const args = params.map((p, i) => `[${JSON.stringify(fn.params[i])}, ${p}]`).join(", ");
  edits.push({
    at: node.body.start + 1,
    text: ` const ${FRAME} = ${RECORDER}.call(${JSON.stringify(fn.name)}, ${locLiteral(fn.header)}, [${args}]);`,
  });

  fn.lets.forEach((letStmt, i) => {
    const s = body[i] as VariableDeclaration;
    const d = s.type === "VariableDeclaration" && s.kind === "let" && s.declarations.length === 1 ? s.declarations[0] : null;
    if (!d || d.id.type !== "Identifier" || !d.init) throw new AlignmentError(`${fn.name}: statement ${i + 1} is not a simple let`);
    const jsName = (d.id as Identifier).name;
    if (gleamNameOf(jsName) !== letStmt.name) {
      throw new AlignmentError(`${fn.name}: compiled let ${jsName} does not match source let ${letStmt.name}`);
    }
    edits.push({ at: s.start, text: `${RECORDER}.line(${FRAME}, ${locLiteral(letStmt.loc)}); ` });
    edits.push({ at: s.end, text: ` ${RECORDER}.bind(${FRAME}, ${JSON.stringify(letStmt.name)}, ${jsName}, ${locLiteral(letStmt.loc)});` });
  });

  const ret = body[body.length - 1] as ReturnStatement;
  if (ret.type !== "ReturnStatement" || !ret.argument) throw new AlignmentError(`${fn.name}: last statement is not a return`);
  edits.push({ at: ret.start, text: `${RECORDER}.line(${FRAME}, ${locLiteral(fn.tail.loc)}); ` });
  edits.push({ at: ret.argument.start, text: `${RECORDER}.ret(${FRAME}, (` });
  edits.push({ at: ret.argument.end, text: `), ${locLiteral(fn.tail.loc)})` });
  return edits;
}
