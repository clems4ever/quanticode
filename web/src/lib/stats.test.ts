import { describe, expect, it } from "vitest";
import {
  calibrateHeat, computeStats, defaultHalfLife, HALF_LIFE_PRESETS, hotShare,
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

describe("calibrateHeat", () => {
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

  /**
   * A repository of `count` files whose ages fan out over `spanDays`.
   *
   * Spread has to come from files differing in age, not from one file
   * containing a range: the map colours a file by the mean of its lines, so a
   * single file of mixed ages renders as one colour however wide that range is.
   */
  const varied = (count: number, spanDays: number, linesEach = 100): FileHeat[] =>
    Array.from({ length: count }, (_, i) =>
      aged(`f${i}.go`, linesEach, (i / Math.max(1, count - 1)) * spanDays));

  it("never washes the map to the hot end when it has a choice", () => {
    // The failure this exists to prevent: a half-life long enough that most of
    // the repository reads hot, leaving nothing to contrast against.
    const files = [...varied(40, 400), aged("old.go", 2000, 1200)];
    const c = calibrateHeat(files, now);
    expect(c.hotShare).toBeLessThanOrEqual(0.18);
  });

  it("does not overshoot when the hot share jumps", () => {
    // A repository written in one burst 27 days ago: the hot share goes from
    // near zero at two weeks to near everything at one month. Taking the first
    // half-life over a target would pick the flooded one.
    const files = [aged("a.go", 1000, 27), aged("b.go", 500, 27.5)];
    const c = calibrateHeat(files, now);
    expect(c.hotShare).toBeLessThan(0.9);
  });

  it("reports a single-age repository as flat rather than pretending", () => {
    // Every line the same age: no half-life separates it, and saying so is
    // more useful than choosing one and rendering a flat map.
    const files = [aged("a.go", 900, 27), aged("b.go", 800, 27.2)];
    expect(calibrateHeat(files, now).flat).toBe(true);
  });

  it("does not call a repository with real age variation flat", () => {
    const files = varied(40, 900);
    expect(calibrateHeat(files, now).flat).toBe(false);
  });

  it("takes the shortest half-life for a repository written today", () => {
    // Hot at every scale, so nothing satisfies the cap; the shortest is the
    // only one separating this morning from last night.
    expect(calibrateHeat([aged("a.go", 100, 0.1)], now).halfLife).toBe("0.5");
  });

  it("uses a long half-life for a dormant repository", () => {
    // Nothing is hot at any scale, so the cap rules nothing out and the widest
    // scale is the one that shows any structure at all.
    const files = [aged("a.go", 100, 900), aged("b.go", 100, 1400)];
    expect(Number(calibrateHeat(files, now).halfLife)).toBeGreaterThanOrEqual(180);
  });

  it("always returns a value the picker offers", () => {
    const offered = HALF_LIFE_PRESETS.map((p) => p.value);
    for (const files of [
      [aged("a.go", 10, 0.2)],
      [aged("a.go", 10, 45)],
      [aged("a.go", 10, 5000)],
      varied(20, 300),
      [],
    ]) {
      expect(offered).toContain(calibrateHeat(files, now).halfLife);
    }
  });

  it("reports the spread it achieved", () => {
    const c = calibrateHeat(varied(40, 700), now);
    expect(c.spread).toBeGreaterThan(0);
    expect(c.spread).toBeLessThanOrEqual(1);
    expect(hotShare(varied(40, 700), now, Number(c.halfLife))).toBeGreaterThanOrEqual(0);
  });
});
