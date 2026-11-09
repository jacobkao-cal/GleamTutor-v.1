/**
 * TracerRuntime for the browser (Phase 2C).
 *
 *   page (this file)                      sandbox iframe (sandbox/host.js)
 *   ────────────────                      ─────────────────────────────────
 *   fetch + SHA-256-verify toolchain ──►  <iframe sandbox="allow-scripts" srcdoc>
 *   (compiler + precompiled gleam_stdlib)
 *   postMessage {init, compile, execute}   opaque origin: no cookies, storage or DOM access to the app
 *   validate every reply (outcome.ts)      CSP: connect-src 'none', scripts only by hash or blob:
 *                                          ├─ compile worker (official Gleam WASM compiler + stdlib sources), reused
 *                                          └─ execution worker, new per run, terminated after it or on timeout;
 *                                             links the program to the stdlib bundle via blob: URLs
 *
 * Nothing runs until the first real trace is requested; the 5 MB compiler is
 * loaded then. The page itself never evaluates compiled code.
 */
import { clampLimits } from "./events";
import { RECORDER_SYMBOL } from "./instrument";
import { validateCompileReply, validateRunOutcome } from "./outcome";
import { parseDiagnostic, type CompileOutput, type ProgramFiles, type TracerRuntime } from "./runtime";
import type { StdlibInfo } from "./stdlib";
import { fetchVerified, GLEAM_VERSION, loadStdlibInfo } from "./toolchainFiles";
import compileWorkerSource from "./sandbox/compileWorker.js?raw";
import hostSource from "./sandbox/host.js?raw";
import recorderSource from "./sandbox/recorder.js?raw";
import runWorkerSource from "./sandbox/runWorker.js?raw";

const SANDBOX_START_TIMEOUT_MS = 30_000;
const COMPILE_TIMEOUT_MS = 20_000;
/** Extra time the page waits beyond the sandbox's own execution timeout. */
const EXECUTE_GRACE_MS = 3_000;

export class SandboxError extends Error {}

interface Toolchain {
  glue: string;
  wasm: ArrayBuffer;
  stdlibInfo: StdlibInfo;
  stdlibSources: Record<string, string>;
  stdlibBundle: string;
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

let toolchainPromise: Promise<Toolchain> | null = null;
function loadToolchain(): Promise<Toolchain> {
  toolchainPromise ??= (async () => {
    const names = ["gleam_wasm.js", "gleam_wasm_bg.wasm", "stdlib.sources.json", "stdlib.bundle.mjs"];
    const [[glue, wasm, sources, bundle], stdlibInfo] = await Promise.all([Promise.all(names.map(fetchVerified)), loadStdlibInfo()]);
    const text = (b: ArrayBuffer) => new TextDecoder().decode(b);
    return {
      glue: text(glue),
      wasm,
      stdlibInfo,
      stdlibSources: JSON.parse(text(sources)) as Record<string, string>,
      stdlibBundle: text(bundle),
    };
  })().catch((e) => {
    toolchainPromise = null; // allow a retry
    throw e;
  });
  return toolchainPromise;
}

/** The Content-Security-Policy of the sandbox document. */
export function sandboxCsp(hostScriptHash: string): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${hostScriptHash}' blob: 'wasm-unsafe-eval'`,
    "worker-src blob:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

class Sandbox {
  readonly iframe: HTMLIFrameElement;
  private waiters = new Map<number, (data: unknown) => void>();
  private lifecycle: ((data: { type: string; error?: string }) => void) | null = null;
  private nextId = 1;
  readonly ready: Promise<void>;

  constructor(toolchain: Toolchain) {
    this.iframe = document.createElement("iframe");
    this.iframe.setAttribute("sandbox", "allow-scripts");
    this.iframe.setAttribute("aria-hidden", "true");
    this.iframe.setAttribute("referrerpolicy", "no-referrer");
    this.iframe.title = "Gleam Tutor execution sandbox";
    this.iframe.className = "gleam-sandbox";
    this.iframe.style.display = "none";
    window.addEventListener("message", this.onMessage);
    this.ready = this.start(toolchain);
  }

  private onMessage = (ev: MessageEvent) => {
    if (ev.source !== this.iframe.contentWindow) return; // only our sandbox
    const data = ev.data as { type?: unknown; id?: unknown };
    if (!data || typeof data !== "object") return;
    if ((data.type === "compiled" || data.type === "executed") && typeof data.id === "number") {
      const waiter = this.waiters.get(data.id);
      this.waiters.delete(data.id);
      waiter?.(data);
    } else if (typeof data.type === "string") {
      this.lifecycle?.(data as { type: string; error?: string });
    }
  };

  private waitFor(type: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SandboxError(`sandbox did not report "${type}" in time`)), timeoutMs);
      this.lifecycle = (d) => {
        if (d.type === type) {
          clearTimeout(timer);
          resolve();
        } else if (d.type === "init_failed") {
          clearTimeout(timer);
          reject(new SandboxError(`sandbox failed to start: ${String(d.error).slice(0, 300)}`));
        }
      };
    });
  }

  private async start(toolchain: Toolchain): Promise<void> {
    const host = hostSource.split("__PARENT_ORIGIN__").join(JSON.stringify(window.location.origin));
    const csp = sandboxCsp(await sha256Base64(host));
    const loaded = this.waitFor("loaded", SANDBOX_START_TIMEOUT_MS);
    this.iframe.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${host}</script>`;
    document.body.appendChild(this.iframe);
    await loaded;
    const ready = this.waitFor("ready", SANDBOX_START_TIMEOUT_MS);
    this.iframe.contentWindow!.postMessage(
      {
        type: "init",
        glue: toolchain.glue,
        wasm: toolchain.wasm.slice(0), // a copy; the original stays available for a restart
        stdlibSources: toolchain.stdlibSources,
        stdlibBundle: toolchain.stdlibBundle,
        compileWorkerSource,
        // Classic worker script: recorder.js is an ES module for Node, so drop its `export` keywords.
        runWorkerSource: `${recorderSource.replace(/^export /gm, "")}\n${runWorkerSource}`,
      },
      "*", // an opaque origin cannot be named; only this iframe's window receives it
    );
    await ready;
  }

  /** Sends a request; resolves with the reply, or null if none arrives in time. */
  request(message: Record<string, unknown>, timeoutMs: number): Promise<unknown | null> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(id, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.iframe.contentWindow?.postMessage({ ...message, id }, "*");
    });
  }

  destroy() {
    window.removeEventListener("message", this.onMessage);
    for (const w of this.waiters.values()) w(null);
    this.waiters.clear();
    this.iframe.remove();
  }
}

let current: Sandbox | null = null;

async function getSandbox(): Promise<Sandbox> {
  if (!current) {
    const sandbox = new Sandbox(await loadToolchain());
    current = sandbox;
    sandbox.ready.catch(() => {
      if (current === sandbox) resetSandbox();
    });
  }
  const sandbox = current;
  await sandbox.ready;
  return sandbox;
}

/** Throws the sandbox away (it is re-created on the next request). */
export function resetSandbox() {
  current?.destroy();
  current = null;
}

export const browserRuntime: TracerRuntime = {
  gleamVersion: GLEAM_VERSION,

  loadStdlib: loadStdlibInfo,

  async compile(source: string): Promise<CompileOutput> {
    const sandbox = await getSandbox();
    const raw = await sandbox.request({ type: "compile", source }, COMPILE_TIMEOUT_MS);
    if (raw === null) {
      resetSandbox();
      throw new SandboxError("the compiler did not answer in time");
    }
    const reply = validateCompileReply(raw);
    if (!reply) throw new SandboxError("the compiler sent an invalid reply");
    return reply.ok ? { ok: true, js: reply.js, warnings: reply.warnings } : { ok: false, diagnostic: parseDiagnostic(reply.error) };
  },

  async execute(program: ProgramFiles, requested) {
    const limits = clampLimits(requested);
    const sandbox = await getSandbox();
    const raw = (await sandbox.request(
      { type: "execute", program, limits, recorderSymbol: RECORDER_SYMBOL },
      limits.timeoutMs + EXECUTE_GRACE_MS,
    )) as { outcome?: unknown } | null;
    if (raw === null) {
      // The sandbox itself stopped answering: discard it entirely.
      resetSandbox();
      return { status: "timeout", message: `Execution took longer than ${limits.timeoutMs} ms and was stopped` };
    }
    return (
      validateRunOutcome(raw.outcome, limits) ?? { status: "internal_error", message: "The execution sandbox sent an invalid result" }
    );
  },
};
