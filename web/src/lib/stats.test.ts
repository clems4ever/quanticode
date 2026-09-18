import { describe, expect, it } from "vitest";
import {
  calibrateHalfLife, computeStats, defaultHalfLife, HALF_LIFE_PRESETS, hotShare,
} from "./stats";
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

describe("calibrateHalfLife", () => {
  const now = Date.parse("2026-09-18T00:00:00Z") / 1000;
  const DAY = 86400;

  /** A file whose lines are all `ageDays` old. */
  const aged = (path: string, lines: number, ageDays: number): FileHeat => ({
    p: path,
    l: lines,
    x: "go",
    k: [[now - ageDays * DAY, lines]],
    le: now - ageDays * DAY,
    fe: now - ageDays * DAY,
    nc: 1,
    ta: "Ada",
    na: 1,
  });

  it("picks a short half-life for a repository written today", () => {
    // Everything is hot at every scale, so the shortest is the only one that
    // separates this morning from last night.
    expect(calibrateHalfLife([aged("a.go", 100, 0.1)], now)).toBe("0.5");
  });

  it("picks the longest for a dormant repository", () => {
    // Nothing reaches the target at any scale. The widest is the only one that
    // shows anything at all, and a short one would render it uniformly black.
    const files = [aged("a.go", 100, 900), aged("b.go", 100, 1200)];
    const longest = HALF_LIFE_PRESETS[HALF_LIFE_PRESETS.length - 1].value;
    expect(calibrateHalfLife(files, now)).toBe(longest);
  });

  it("takes the shortest half-life that still reads hot enough", () => {
    // 15 lines of 100 are 80 days old; the rest are years old. One month leaves
    // the recent cohort cold, three months brings it over the line.
    const files = [aged("recent.go", 15, 80), aged("old.go", 85, 1500)];
    expect(hotShare(files, now, 30)).toBeLessThan(0.15);
    expect(hotShare(files, now, 90)).toBeGreaterThanOrEqual(0.15);
    expect(calibrateHalfLife(files, now)).toBe("90");
  });

  it("does not wash the map to the hot end", () => {
    // The failure that started this: a half-life so long that most of the
    // repository reads hot and there is no cold background to contrast with.
    const files = [aged("a.go", 30, 100), aged("b.go", 70, 400)];
    const chosen = Number(calibrateHalfLife(files, now));
    expect(hotShare(files, now, chosen)).toBeLessThan(0.6);
  });

  it("always returns a value the picker offers", () => {
    const offered = HALF_LIFE_PRESETS.map((p) => p.value);
    for (const files of [
      [aged("a.go", 10, 0.2)],
      [aged("a.go", 10, 45)],
      [aged("a.go", 10, 5000)],
      [],
    ]) {
      expect(offered).toContain(calibrateHalfLife(files, now));
    }
  });
});
