/**
 * Phase 2C end to end, in a real browser: the production build compiles and
 * runs edited Gleam code inside the sandboxed iframe, and the sandbox cannot
 * reach the network, storage or the page.
 *
 * Needs Google Chrome (or CHROME_PATH), `npm run tracer:setup` and `npm run build`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { preview, type PreviewServer } from "vite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const SQUARE = (a: number) => `pub fn square(x: Int) -> Int {
  x * x
}

pub fn main() {
  let a = ${a}
  let b = square(a)
  b
}
`;

let server: PreviewServer;
let browser: Browser;
let page: Page;
let base: string;

beforeAll(async () => {
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) throw new Error("Run npm run build first");
  if (!fs.existsSync(path.join(root, "dist", "gleam-toolchain"))) throw new Error("Run npm run tracer:setup, then npm run build");
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);
  server = await preview({ root, logLevel: "error", preview: { port: 0, host: "127.0.0.1" } });
  base = server.resolvedUrls!.local[0];
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", "--no-default-browser-check"] });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((ok) => server?.httpServer.close(() => ok()));
});

beforeEach(async () => {
  page?.isClosed() === false && (await page.close());
  page = await browser.newPage();
  await page.goto(base, { waitUntil: "load" });
});

async function setSource(code: string) {
  await page.evaluate((text) => {
    const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Gleam source code"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }, code);
}

async function visualize() {
  await page.click("button.visualize-button");
  await page.waitForFunction(() => document.querySelector(".step-counter") || document.querySelector('[role="alert"]'), { timeout: 45_000 });
}

const text = (sel: string) => page.$eval(sel, (el) => el.textContent ?? "");

describe("real tracing in the browser", () => {
  it("the exact demo keeps its predefined Demo trace and loads no sandbox", async () => {
    await visualize();
    expect(await text(".viz-language")).toContain("Demo trace (predefined");
    expect(await page.$("iframe.gleam-sandbox")).toBeNull();
  });

  it("edited code (a = 7) is compiled and run for real: 49", async () => {
    await setSource(SQUARE(7));
    await visualize();
    expect(await text(".viz-language")).toContain("Live trace");
    expect(await text(".step-counter")).toBe("Step 1 of 7");
    await page.click("xpath/.//button[contains(., 'Last')]");
    const ret = await text('[data-frame-id="frame-main-1"] [data-binding="__return"]');
    expect(ret).toContain("49");
    expect(await text('[data-frame-id="frame-square-2"] [data-binding="x"]')).toContain("7");
  });

  it("compile errors come from the official compiler", async () => {
    await setSource("pub fn main() {\n  y\n}\n");
    await visualize();
    const alert = await text('[role="alert"]');
    expect(alert).toContain("The Gleam compiler found a problem: Unknown variable (line 2, column 3)");
    expect(await text('[role="alert"] pre')).toContain("main.gleam:2:3");
  });

  it("unsupported programs get a located notice", async () => {
    await setSource("pub fn main() {\n  let pair = #(1, 2)\n  1\n}\n");
    await visualize();
    expect(await text('[role="alert"]')).toContain("doesn't support tuples yet");
    expect(await text('[role="alert"]')).toContain("(line 2, column 14)");
  });

  it("runaway recursion is stopped by the depth limit", async () => {
    await setSource("fn down(n: Int) -> Int {\n  1 + down(n + 1)\n}\n\npub fn main() {\n  down(0)\n}\n");
    await visualize();
    expect(await text('[role="alert"]')).toContain("Call depth exceeded 500");
  });
});

describe("the sandbox boundary", () => {
  /** Initializes the sandbox through the app, then talks to it directly like the page does. */
  async function sandboxRun(js: string, timeoutMs = 2000) {
    await setSource(SQUARE(3));
    await visualize();
    return page.evaluate(
      (code, timeout) =>
        new Promise<unknown>((resolve) => {
          const frame = document.querySelector<HTMLIFrameElement>("iframe.gleam-sandbox")!;
          const id = 900_000 + Math.floor(Math.random() * 1000);
          window.addEventListener("message", (ev) => {
            if (ev.source === frame.contentWindow && ev.data?.id === id) resolve(ev.data.outcome);
          });
          const limits = { timeoutMs: timeout, maxEvents: 5000, maxDepth: 500, maxStdout: 10000, maxHeapMb: 64 };
          // A linked program of two standalone modules (see src/tracer/stdlib.ts).
          const program = {
            modules: [
              { id: "original.mjs", parts: [code], deps: [] },
              { id: "main.mjs", parts: [code], deps: [] },
            ],
            original: "original.mjs",
            instrumented: "main.mjs",
          };
          frame.contentWindow!.postMessage({ type: "execute", id, program, limits, recorderSymbol: "gleam-tutor.tracer" }, "*");
        }),
      js,
      timeoutMs,
    );
  }

  it("is a sandboxed srcdoc iframe with an opaque origin and a strict CSP", async () => {
    await setSource(SQUARE(3));
    await visualize();
    const info = await page.$eval("iframe.gleam-sandbox", (f) => {
      let sameOrigin = true;
      try {
        void (f as HTMLIFrameElement).contentDocument!.body;
      } catch {
        sameOrigin = false;
      }
      return { sandbox: f.getAttribute("sandbox"), contentDocument: (f as HTMLIFrameElement).contentDocument, sameOrigin, srcdoc: (f as HTMLIFrameElement).srcdoc };
    });
    expect(info.sandbox).toBe("allow-scripts");
    expect(info.contentDocument).toBeNull(); // the page cannot reach into it, and vice versa
    expect(info.srcdoc).toContain("connect-src 'none'");
  });

  it("code in the execution worker cannot use the network, storage, caches or the page", async () => {
    const origin = new URL(base).origin;
    const probe = `
      let leaks = 0;
      try { await fetch(${JSON.stringify(origin + "/")}); leaks |= 1; } catch {}
      try { await new Promise((ok, no) => { const r = indexedDB.open("x"); r.onsuccess = ok; r.onerror = no; }); leaks |= 2; } catch {}
      try { await import(${JSON.stringify(origin + "/gleam-toolchain/1.19.2/gleam_wasm.js")}); leaks |= 4; } catch {}
      try { await caches.open("x"); leaks |= 8; } catch {}
      if (typeof document !== "undefined" || typeof window !== "undefined") leaks |= 16;
      try { const ws = new WebSocket(${JSON.stringify(origin.replace("http", "ws"))}); await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; }); leaks |= 32; } catch {}
      export function main() { return leaks; }
    `;
    const outcome = (await sandboxRun(probe)) as { status: string; result?: { value: string } };
    expect(outcome.status).toBe("ok");
    expect(outcome.result?.value).toBe("0");

    // Control: the same probe in an ordinary (unsandboxed) worker of the page DOES reach the network,
    // so the zero above is the sandbox's doing, not a broken probe.
    const control = await page.evaluate(
      (src) =>
        new Promise<number>((resolve) => {
          const body = src.replace("export function main() { return leaks; }", "postMessage(leaks);");
          const w = new Worker(URL.createObjectURL(new Blob([`(async () => {${body}})()`], { type: "text/javascript" })));
          w.onmessage = (e) => resolve(e.data as number);
        }),
      probe,
    );
    expect(control & 1).toBe(1);
  });

  it("an infinite loop is stopped, and the sandbox keeps working afterwards", async () => {
    const t0 = Date.now();
    const outcome = (await sandboxRun("export function main() { while (true) {} }\n", 500)) as { status: string };
    expect(outcome.status).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(15_000);
    await page.click("xpath/.//a[contains(., 'Edit this code')]");
    await setSource(SQUARE(4));
    await visualize();
    await page.click("xpath/.//button[contains(., 'Last')]");
    expect(await text('[data-frame-id="frame-main-1"] [data-binding="__return"]')).toContain("16");
  });
});

describe("Phase 2D: gleam_stdlib, Strings and Print Output in the browser", () => {
  const output = () => page.$eval('textarea[aria-label="Print output"]', (t) => (t as HTMLTextAreaElement).value);
  const pick = async (title: string) => {
    const value = await page.$eval(
      'select[aria-label="Example programs"]',
      (sel, t) => [...(sel as HTMLSelectElement).options].find((o) => o.textContent!.startsWith(t as string))!.value,
      title,
    );
    await page.select('select[aria-label="Example programs"]', value);
  };
  const button = (label: string) => page.click(`xpath/.//button[contains(., '${label}')]`);

  it("the dropdown marks exactly the examples the tracer supports, computed from their code", async () => {
    await page.waitForFunction(() => [...document.querySelectorAll("option")].some((o) => o.textContent!.includes("(step-through)")));
    const marked = await page.$$eval("option", (os) => os.filter((o) => o.textContent!.includes("(step-through)")).map((o) => o.value));
    // Computed from each example's code; the engine suite checks these agree with real runs.
    expect(marked.sort()).toEqual(["assignments", "functions", "hello", "list-recursion", "lists", "partitions", "recursion", "tail-calls"]);
  });

  it("Hello world prints both lines, step by step, and playback rewinds the output", async () => {
    await pick("Hello world");
    await visualize();
    expect(await text(".viz-language")).toContain("Live trace");
    expect(await text(".step-counter")).toBe("Step 1 of 3");
    expect(await output()).toBe("");
    await button("Next");
    expect(await output()).toBe("Hello, Joe!\n");
    await button("Last");
    expect(await output()).toBe("Hello, Joe!\nHello, Mike!\n");
    await button("Prev");
    expect(await output()).toBe("Hello, Joe!\n");
    await button("First");
    expect(await output()).toBe("");
  });

  it("Assignments and shadowing shows String values as Gleam literals", async () => {
    await pick("Assignments and shadowing");
    await visualize();
    await button("Last");
    expect(await output()).toBe("Original\nOriginal\nNew\nOriginal\n");
    expect(await text('[data-frame-id="frame-main-1"] [data-binding="x"] .value-string')).toBe('"New"');
    expect(await text('[data-frame-id="frame-main-1"] [data-binding="y"] .value-string')).toBe('"Original"');
  });

  it("Functions shows user frames, real values and the printed result", async () => {
    await pick("Functions");
    await visualize();
    await button("Last");
    expect(await output()).toBe("10\n");
    const frames = await page.$$eval("[data-frame-id]", (fs) => fs.map((f) => f.getAttribute("data-frame-id")));
    expect(frames).toEqual(["module-main", "frame-main-1", "frame-add-2", "frame-double-3", "frame-multiply-4"]);
    expect(await text('[data-frame-id="frame-main-1"] [data-binding="doubled"]')).toContain("10");
  });

  it("io.print adds no newline in the browser either; Unicode output is kept", async () => {
    await setSource('import gleam/io\n\npub fn main() {\n  io.print("a")\n  io.print("b")\n  io.println("c 🌟")\n}\n');
    await visualize();
    await button("Last");
    expect(await output()).toBe("abc 🌟\n");
  });

  it("an example the tracer cannot step through stays editable, with the reason", async () => {
    await pick("Tuples");
    await visualize();
    expect(await text('[role="alert"]')).toContain("doesn't support tuples yet");
    expect(await page.$('textarea[aria-label="Gleam source code"]')).not.toBeNull();
  });
});

describe("Phase 3A: lists and case in the browser", () => {
  const button = (label: string) => page.click(`xpath/.//button[contains(., '${label}')]`);
  const FIRST = `pub fn first(xs: List(Int)) -> Int {
  case xs {
    [] -> 0
    [head, ..tail] -> head
  }
}

pub fn main() {
  first([3, 4, 5])
}
`;
  /** The cells drawn in the Objects column, row by row, as "head|tail". */
  const rows = () =>
    page.$$eval(".heap-row", (rs) =>
      rs
        .map((r) => [...r.querySelectorAll(".heap-cons")].map((c) => `${c.querySelector(".cons-head")!.textContent}|${c.querySelector(".cons-tail .ref-dot") ? "•" : c.querySelector(".cons-tail")!.textContent}`))
        .filter((r) => r.length > 0),
    );

  it("first([3, 4, 5]): the selected clause, head = 3, tail pointing into the same list, return 3", async () => {
    await setSource(FIRST);
    await visualize();
    expect(await text(".viz-language")).toContain("Live trace");
    for (let i = 0; i < 4; i++) await button("Next");
    expect(await text(".step-counter")).toBe("Step 5 of 7");
    expect(await page.$eval('tr[data-arrow="just"]', (r) => r.getAttribute("data-line"))).toBe("4"); // [head, ..tail] -> head
    expect(await text('[data-frame-id="frame-first-2"] [data-binding="head"] .frame-var-value')).toBe("3");
    expect(await rows()).toEqual([["3|•", "4|•", "5|[]"]]);
    const target = (b: string) => page.$eval(`[data-frame-id="frame-first-2"] [data-binding="${b}"] [data-ref-target]`, (e) => e.getAttribute("data-ref-target"));
    const cellIds = await page.$$eval(".heap-cons", (cs) => cs.map((c) => c.getAttribute("data-obj-id")));
    expect(await target("xs")).toBe(cellIds[0]);
    expect(await target("tail")).toBe(cellIds[1]); // the rest of the same cells, not a copy
    await button("Last");
    expect(await text('[data-frame-id="frame-first-2"] [data-binding="__return"]')).toContain("3");
    await button("First");
    expect(await rows()).toEqual([]); // nothing exists before main runs
  });

  it("sum([1, 2, 3]) shows four logical frames and [] inline for the empty list", async () => {
    await setSource(`pub fn sum(xs: List(Int)) -> Int {
  case xs {
    [] -> 0
    [first, ..rest] -> first + sum(rest)
  }
}

pub fn main() {
  sum([1, 2, 3])
}
`);
    await visualize();
    await button("Last");
    const frames = await page.$$eval('[data-frame-id^="frame-sum"]', (fs) =>
      fs.map((f) => [f.querySelector('[data-binding="xs"] .frame-var-value')!.textContent, f.querySelector('[data-binding="__return"] .frame-var-value')!.textContent]),
    );
    expect(frames).toEqual([
      ["", "6"],
      ["", "5"],
      ["", "3"],
      ["[]", "0"],
    ]); // the first three xs are pointers into the list (dots), the last is []
    expect(await rows()).toEqual([["1|•", "2|•", "3|[]"]]);
  });
});

describe("Phase 3B: recursion and scope in the browser", () => {
  const button = (label: string) => page.click(`xpath/.//button[contains(., '${label}')]`);

  it("GT-06: tail calls are drawn as labelled logical frames; the first call is a real frame", async () => {
    await setSource(`pub fn count_down(n: Int, acc: Int) -> Int {
  case n {
    0 -> acc
    _ -> count_down(n - 1, acc + 1)
  }
}

pub fn main() {
  count_down(3, 0)
}
`);
    await visualize();
    await button("Last");
    const frames = await page.$$eval('[data-frame-id^="frame-count_down"]', (fs) =>
      fs.map((f) => `${f.querySelector('[data-binding="n"] .frame-var-value')!.textContent}:${f.querySelector(".frame-tag")?.textContent ?? "real"}`),
    );
    expect(frames).toEqual(["3:real", "2:tail call", "1:tail call", "0:tail call"]);
    expect(await text('[data-frame-id="frame-main-1"] [data-binding="__return"]')).toContain("3");
  });

  it("a block's bindings disappear when it ends", async () => {
    await setSource("pub fn main() {\n  let x = 1\n  let y = {\n    let x = 10\n    x + 1\n  }\n  x + y\n}\n");
    await visualize();
    const names = () => page.$$eval('[data-frame-id="frame-main-1"] [data-binding]', (bs) => bs.map((b) => `${b.getAttribute("data-binding")}=${b.querySelector(".frame-var-value")!.textContent}`));
    // Step to the inner `let x = 10`.
    for (let i = 0; i < 3; i++) await button("Next");
    expect(await names()).toEqual(["x=10"]);
    await button("Last");
    expect(await names()).toEqual(["x=1", "y=11", "__return=12"]);
  });
});

describe("Phase 3C: imports and output in the browser", () => {
  const button = (label: string) => page.click(`xpath/.//button[contains(., '${label}')]`);

  it("unqualified and qualified stdlib imports; a list result is drawn as cells; output is real", async () => {
    await setSource(`import gleam/io.{println}
import gleam/list
import gleam/string

pub fn main() {
  let words = string.split("c,b,a", ",")
  let sorted = list.reverse(words)
  println(string.join(sorted, " "))
}
`);
    await visualize();
    await button("Last");
    expect(await page.$eval('textarea[aria-label="Print output"]', (t) => (t as HTMLTextAreaElement).value)).toBe("a b c\n");
    const heads = await page.$$eval(".heap-cons .cons-head", (cs) => cs.map((c) => c.textContent));
    expect(heads.sort()).toEqual(['"a"', '"a"', '"b"', '"b"', '"c"', '"c"']); // two lists of three cells
  });

  it("a higher-order stdlib call is refused with a reason", async () => {
    await setSource("import gleam/int\nimport gleam/list\n\npub fn main() {\n  list.map([1], int.to_string)\n}\n");
    await visualize();
    expect(await text('[role="alert"]')).toContain("doesn't support using int.to_string as a value yet");
  });
});
