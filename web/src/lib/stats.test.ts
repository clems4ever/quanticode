import { describe, expect, it } from "vitest";
import { computeStats, defaultHalfLife, HALF_LIFE_PRESETS } from "./stats";
import type { FileHeat } from "./api";

const DAY = 86400;
const NOW = 1_700_000_000;

function file(path: string, buckets: [number, number][]): FileHeat {
  const lines = buckets.reduce((s, [, n]) => s + n, 0);
  return {
    p: path,
    l: lines,
    x: "go",
    k: buckets,
    le: Math.max(...buckets.map(([t]) => t)),
    fe: Math.min(...buckets.map(([t]) => t)),
    nc: buckets.length,
    ta: "Ada",
    na: 1,
  };
}

describe("computeStats", () => {
  const files = [
    file("fresh.go", [[NOW - 1 * DAY, 30]]),
    file("stale.go", [[NOW - 100 * DAY, 70]]),
  ];

  it("counts files and lines", () => {
    const s = computeStats(files, NOW, 7, "average");
    expect(s.files).toBe(2);
    expect(s.lines).toBe(100);
  });

  it("counts lines edited inside the half-life window", () => {
    const s = computeStats(files, NOW, 7, "average");
    expect(s.freshLines).toBe(30);
    expect(s.freshShare).toBeCloseTo(0.3, 10);
  });

  it("widens the fresh window as the half-life grows", () => {
    expect(computeStats(files, NOW, 365, "average").freshLines).toBe(100);
  });

  it("finds the median line age by line, not by file", () => {
    // 30 fresh lines then 70 stale ones: the 50th line is stale.
    const s = computeStats(files, NOW, 7, "average");
    expect(s.medianAgeDays).toBeCloseTo(100, 5);
  });

  it("identifies the hottest and coldest file", () => {
    const s = computeStats(files, NOW, 7, "average");
    expect(s.hottest?.path).toBe("fresh.go");
    expect(s.coldest?.path).toBe("stale.go");
    expect(s.hottest!.heat).toBeGreaterThan(s.coldest!.heat);
  });

  it("handles an empty file list without dividing by zero", () => {
    const s = computeStats([], NOW, 7, "average");
    expect(s).toMatchObject({ files: 0, lines: 0, freshLines: 0, freshShare: 0 });
    expect(s.hottest).toBeNull();
    expect(s.coldest).toBeNull();
    expect(Number.isNaN(s.freshShare)).toBe(false);
  });

  it("counts a line edited exactly at the cutoff as fresh", () => {
    const s = computeStats([file("edge.go", [[NOW - 7 * DAY, 1]])], NOW, 7, "average");
    expect(s.freshLines).toBe(1);
  });
});

describe("defaultHalfLife", () => {
  it("always returns one of the presets", () => {
    const values = new Set(HALF_LIFE_PRESETS.map((p) => p.value));
    for (const spanDays of [0.5, 1, 7, 20, 49, 200, 1000, 5000]) {
      expect(values.has(defaultHalfLife(NOW - spanDays * DAY, NOW))).toBe(true);
    }
  });

  it("picks a short window for a young repository", () => {
    expect(Number(defaultHalfLife(NOW - 20 * DAY, NOW))).toBeLessThanOrEqual(7);
  });

  it("picks a longer window for an old one", () => {
    expect(Number(defaultHalfLife(NOW - 1000 * DAY, NOW))).toBeGreaterThanOrEqual(90);
  });

  it("grows monotonically with the repository's span", () => {
    const spans = [10, 50, 200, 800, 3000];
    const chosen = spans.map((d) => Number(defaultHalfLife(NOW - d * DAY, NOW)));
    for (let i = 1; i < chosen.length; i++) {
      expect(chosen[i]).toBeGreaterThanOrEqual(chosen[i - 1]);
    }
  });

  it("does not divide by zero for a repository with a single commit", () => {
    const v = Number(defaultHalfLife(NOW, NOW));
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });
});
