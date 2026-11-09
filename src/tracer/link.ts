/**
 * Links a compiled program to the precompiled gleam_stdlib bundle (see
 * stdlib.ts): each stdlib module the program imports is reached through a
 * small generated facade that re-exports one namespace of the bundle.
 */
import { parse } from "acorn";
import type { StdlibInfo } from "./stdlib";

/** Id of the stdlib bundle module; the runtime supplies its text. */
export const STDLIB_BUNDLE_ID = "stdlib";

/**
 * A module whose import specifiers are left as holes: its code is
 * parts[0] + url(deps[0]) + parts[1] + ... The runtime fills each hole with
 * the URL it created for that dependency. Splitting at parsed positions
 * (rather than search-and-replace) means no string inside a program can ever
 * be mistaken for an import.
 */
export interface LinkModule {
  id: string;
  parts: string[];
  deps: string[];
}

/** Modules in dependency order (each refers only to earlier ids or the bundle). */
export interface ProgramFiles {
  modules: LinkModule[];
  /** Id of the uninstrumented program (baseline run). */
  original: string;
  /** Id of the instrumented program. */
  instrumented: string;
}

export class LinkError extends Error {}

interface SourceNode {
  start: number;
  end: number;
  value: unknown;
}
interface Stmt {
  type: string;
  source?: SourceNode | null;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Maps a compiled module's import specifier to a facade id, or throws. */
function facadeFor(specifier: string, info: StdlibInfo): { id: string; ns: string; exports: string[] } {
  if (specifier === "./gleam.mjs") return { id: "gleam.mjs", ...info.prelude };
  const m = /^\.\/(gleam\/[a-z0-9_/]+)\.mjs$/.exec(specifier);
  const mod = m ? info.modules[m[1]] : undefined;
  if (!m || !mod) throw new LinkError(`unexpected import of ${specifier}`);
  return { id: `${m[1]}.mjs`, ns: mod.ns, exports: mod.exports };
}

function splitImports(id: string, code: string, info: StdlibInfo, facades: Map<string, LinkModule>): LinkModule {
  const program = parse(code, { ecmaVersion: "latest", sourceType: "module" }) as unknown as { body: Stmt[] };
  const holes: { start: number; end: number; dep: string }[] = [];
  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration" && stmt.type !== "ExportAllDeclaration" && stmt.type !== "ExportNamedDeclaration") continue;
    if (!stmt.source) continue;
    const f = facadeFor(String(stmt.source.value), info);
    if (!facades.has(f.id)) {
      const names = f.exports.filter((n) => IDENT.test(n));
      facades.set(f.id, {
        id: f.id,
        parts: [`import { ${f.ns} as __gt_ns } from `, `;\nexport const { ${names.join(", ")} } = __gt_ns;\n`],
        deps: [STDLIB_BUNDLE_ID],
      });
    }
    holes.push({ start: stmt.source.start, end: stmt.source.end, dep: f.id });
  }
  holes.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let at = 0;
  for (const h of holes) {
    parts.push(code.slice(at, h.start));
    at = h.end;
  }
  parts.push(code.slice(at));
  return { id, parts, deps: holes.map((h) => h.dep) };
}

/** Links the compiled and instrumented programs to the stdlib bundle through facades. */
export function linkProgram(compiledJs: string, instrumentedJs: string, info: StdlibInfo): ProgramFiles {
  const facades = new Map<string, LinkModule>();
  const original = splitImports("original.mjs", compiledJs, info, facades);
  const instrumented = splitImports("main.mjs", instrumentedJs, info, facades);
  return { modules: [...facades.values(), original, instrumented], original: original.id, instrumented: instrumented.id };
}
