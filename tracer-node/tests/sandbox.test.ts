/**
 * Phase 2C pieces that can be tested in Node: validation of everything the
 * browser sandbox sends back, and the computed "traceable" marking of examples.
 * The sandbox itself is exercised in a real browser by `npm run e2e`.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GT_EXAMPLES } from "../../examples.js";
import { DEFAULT_LIMITS, type RawEvent } from "../../src/tracer/events";
import { validateCompileReply, validateRunOutcome } from "../../src/tracer/outcome";
import { looksTraceable } from "../../src/tracer/traceable";
import { expectOk, traceGleam } from "./helpers";

const call: RawEvent = { t: "call", frame: 1, fn: "main", loc: [1, 1, 1, 16], args: [] };
const ret: RawEvent = { t: "return", frame: 1, value: { kind: "int", value: "6" }, loc: [2, 3, 2, 8] };
const okOutcome = { status: "ok", events: [call, ret], result: { kind: "int", value: "6" }, baselineResult: { kind: "int", value: "6" }, stdout: "" };

describe("validateRunOutcome (sandbox replies are untrusted)", () => {
  it("accepts a well-formed outcome", () => {
    expect(validateRunOutcome(okOutcome, DEFAULT_LIMITS)).toEqual(okOutcome);
  });

  it("accepts a real outcome produced by the shared recorder", async () => {
    const r = expectOk(await traceGleam("fn sq(x: Int) -> Int {\n  x * x\n}\n\npub fn main() {\n  sq(3)\n}\n"));
    const outcome = { status: "ok", events: r.events, result: r.result, baselineResult: r.result, stdout: "" };
    expect(validateRunOutcome(JSON.parse(JSON.stringify(outcome)), DEFAULT_LIMITS)).not.toBeNull();
  });

  it.each([
    ["not an object", 42],
    ["unknown status", { status: "pwned" }],
    ["events not an array", { ...okOutcome, events: "x" }],
    ["too many events (checked before walking them)", { ...okOutcome, events: new Array(DEFAULT_LIMITS.maxEvents + 1).fill(call) }],
    ["unknown event kind", { ...okOutcome, events: [{ ...call, t: "eval" }] }],
    ["bad location", { ...okOutcome, events: [{ ...call, loc: [1, 2, 3] }] }],
    ["negative frame", { ...okOutcome, events: [{ ...call, frame: -1 }] }],
    ["non-numeric int", { ...okOutcome, result: { kind: "int", value: "1e9" } }],
    ["huge name", { ...okOutcome, events: [{ ...call, fn: "f".repeat(10_000) }] }],
    ["oversized stdout", { ...okOutcome, stdout: "x".repeat(DEFAULT_LIMITS.maxStdout + 1) }],
    ["value of unknown kind", { ...okOutcome, result: { kind: "ref", id: "x" } }],
    ["timeout without message", { status: "timeout" }],
  ])("rejects %s", (_label, outcome) => {
    expect(validateRunOutcome(outcome, DEFAULT_LIMITS)).toBeNull();
  });

  it("validates compile replies", () => {
    expect(validateCompileReply({ ok: true, js: "x", warnings: [] })).toEqual({ ok: true, js: "x", warnings: [] });
    expect(validateCompileReply({ ok: false, error: "error: Syntax error" })).toEqual({ ok: false, error: "error: Syntax error" });
    expect(validateCompileReply({ ok: true, js: 1, warnings: [] })).toBeNull();
    expect(validateCompileReply({ ok: true, js: "x", warnings: [3] })).toBeNull();
    expect(validateCompileReply(null)).toBeNull();
  });
});

describe("traceable marking is computed and agrees with the real engine", () => {
  const samplesDir = path.join(__dirname, "..", "samples");
  const programs = [
    ...GT_EXAMPLES.map((e) => [`example ${e.id}`, e.code] as const),
    ...fs.readdirSync(samplesDir).map((f) => [`sample ${f}`, fs.readFileSync(path.join(samplesDir, f), "utf8")] as const),
    ["case expression", "pub fn main() {\n  case 1 {\n    _ -> 2\n  }\n}\n"] as const,
  ];

  it.each(programs)("%s", async (_name, code) => {
    const engineAccepts = (await traceGleam(code)).status === "ok";
    expect(looksTraceable(code)).toBe(engineAccepts);
  });

  it("no library example is traceable yet (all of them import gleam/io)", () => {
    expect(GT_EXAMPLES.filter((e) => looksTraceable(e.code))).toEqual([]);
  });
});
