import { applyPlayback, clampStep } from "./playback";

describe("playback controller", () => {
  const N = 9;
  it("moves within bounds", () => {
    expect(applyPlayback(0, "prev", N)).toBe(0);
    expect(applyPlayback(0, "next", N)).toBe(1);
    expect(applyPlayback(8, "next", N)).toBe(8);
    expect(applyPlayback(5, "first", N)).toBe(0);
    expect(applyPlayback(2, "last", N)).toBe(8);
  });
  it("seeks in both directions and clamps", () => {
    expect(applyPlayback(1, { seek: 6 }, N)).toBe(6);
    expect(applyPlayback(6, { seek: 2 }, N)).toBe(2);
    expect(applyPlayback(0, { seek: 99 }, N)).toBe(8);
    expect(applyPlayback(0, { seek: -3 }, N)).toBe(0);
    expect(applyPlayback(0, { seek: NaN }, N)).toBe(0);
  });
  it("handles an empty trace", () => {
    expect(clampStep(4, 0)).toBe(0);
  });
});
