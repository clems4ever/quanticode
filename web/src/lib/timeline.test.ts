import { describe, expect, it } from "vitest";
import type { DayStat } from "./api";
import {
  bucketOf, buildBins, chooseBucket, defaultRangeFor, RANGES, totalCommits,
} from "./timeline";

const DAY = 86400;

/** Unix seconds for a UTC date, so the tests do not depend on the host zone. */
function at(iso: string): number {
  return Date.parse(iso + "T00:00:00Z") / 1000;
}

/** A commit on every day in [from, to], one commit each. */
function daily(from: string, to: string, commits = 1): DayStat[] {
  const out: DayStat[] = [];
  for (let t = at(from); t <= at(to); t += DAY) {
    out.push({ d: new Date(t * 1000).toISOString().slice(0, 10), c: commits, a: 10, r: 5 });
  }
  return out;
}

describe("chooseBucket", () => {
  it("keeps bars wide enough to read at any span", () => {
    expect(chooseBucket(30)).toBe("day");
    expect(chooseBucket(90)).toBe("day");
    expect(chooseBucket(120)).toBe("day");
    expect(chooseBucket(121)).toBe("week");
    expect(chooseBucket(365)).toBe("week");
    expect(chooseBucket(800)).toBe("week");
    expect(chooseBucket(801)).toBe("month");
    expect(chooseBucket(4500)).toBe("month");
  });

  it("never produces the hairline forest that whole-history weekly did", () => {
    // Twelve years is 640 weeks. Whatever bucket is chosen for it, the bar
    // count has to stay somewhere a panel can actually draw.
    const twelveYears = 365 * 12;
    const bins = buildBins(daily("2013-01-01", "2024-12-31"), at("2025-01-01"), 0);
    expect(chooseBucket(twelveYears)).toBe("month");
    expect(bins.length).toBeLessThan(200);
    expect(bucketOf(bins)).toBe("month");
  });
});

describe("buildBins windowing", () => {
  const now = at("2026-09-18");

  it("30 days gives 30 daily bars", () => {
    const bins = buildBins(daily("2026-01-01", "2026-09-18"), now, 30);
    expect(bins).toHaveLength(30);
    expect(bucketOf(bins)).toBe("day");
    expect(bins[bins.length - 1].start).toBe(at("2026-09-18"));
    expect(bins[0].start).toBe(at("2026-09-18") - 29 * DAY);
  });

  it("90 days gives 90 daily bars", () => {
    const bins = buildBins(daily("2026-01-01", "2026-09-18"), now, 90);
    expect(bins).toHaveLength(90);
    expect(bucketOf(bins)).toBe("day");
  });

  it("a year rolls up to weeks", () => {
    const bins = buildBins(daily("2024-01-01", "2026-09-18"), now, 365);
    expect(bucketOf(bins)).toBe("week");
    expect(bins.length).toBeLessThanOrEqual(53);
  });

  it("does not invent history a repository does not have", () => {
    // Asking for a year of a repository three weeks old gives three weeks.
    const bins = buildBins(daily("2026-08-29", "2026-09-18"), now, 365);
    expect(bins[0].start).toBe(at("2026-08-29"));
    expect(bins).toHaveLength(21);
  });

  it("shows an abandoned repository as empty rather than as busy", () => {
    // Last commit two years ago. The window ends at now, not at the last
    // commit, because "nothing in 90 days" is the answer to the question.
    const bins = buildBins(daily("2024-01-01", "2024-03-01"), now, 90);
    expect(bins).toHaveLength(90);
    expect(totalCommits(bins)).toBe(0);
  });

  it("keeps quiet days inside the window as zero bars", () => {
    // An old repository with barely any recent activity — the case that made
    // 30 days a bad default, because two bars in thirty reads as dead.
    const sparse: DayStat[] = [
      { d: "2019-04-02", c: 1, a: 100, r: 0 }, // long before the window
      { d: "2026-09-01", c: 3, a: 30, r: 1 },
      { d: "2026-09-17", c: 2, a: 5, r: 0 },
    ];
    const bins = buildBins(sparse, now, 30);
    expect(bins).toHaveLength(30);
    expect(totalCommits(bins)).toBe(5); // the 2019 commit is outside the window
    expect(bins.filter((b) => b.commits === 0)).toHaveLength(28);
  });
});

describe("buildBins aggregation", () => {
  const now = at("2026-09-18");

  it("preserves every commit when rolling up", () => {
    const timeline = daily("2024-01-01", "2026-09-18", 2);
    const expected = timeline.reduce((s, d) => s + d.c, 0);
    // Whole history, whatever bucket that lands on.
    expect(totalCommits(buildBins(timeline, now, 0))).toBe(expected);
  });

  it("sums additions and deletions into the bucket", () => {
    const bins = buildBins(daily("2026-09-01", "2026-09-18"), now, 0);
    const first = bins[0];
    expect(first.added).toBe(10);
    expect(first.removed).toBe(5);
  });

  it("rolls months up on calendar boundaries", () => {
    const bins = buildBins(daily("2014-01-01", "2026-09-18"), now, 0);
    expect(bucketOf(bins)).toBe("month");
    // Each bin starts on the first of a month.
    for (const b of bins.slice(1)) {
      expect(new Date(b.start * 1000).getUTCDate()).toBe(1);
    }
  });

  it("is empty for an empty timeline", () => {
    expect(buildBins([], now, 90)).toEqual([]);
    expect(buildBins([], now, 0)).toEqual([]);
  });
});

/** Days carrying at least one commit inside the last `days` days. */
function activeDaysWithin(tl: DayStat[], days: number): number {
  const cutoff = at("2026-09-18") - (days - 1) * DAY;
  return tl.filter((d) => d.c > 0 && Date.parse(d.d + "T00:00:00Z") / 1000 >= cutoff).length;
}

describe("defaultRangeFor", () => {
  const now = at("2026-09-18");

  it("uses a short window for a repository under active development", () => {
    expect(defaultRangeFor(daily("2026-01-01", "2026-09-18"), now)).toBe(30);
  });

  it("widens for a mature project whose recent activity is bursty", () => {
    // The measured shape of gin-gonic/gin: commits on one day in the last 30,
    // five in the last 90, but fifty-three across the year. Both the short
    // windows draw it as abandoned, which it is not.
    const day = (offset: number): DayStat => ({
      d: new Date((at("2026-09-18") - offset * DAY) * 1000).toISOString().slice(0, 10),
      c: 2,
      a: 8,
      r: 3,
    });
    const tl: DayStat[] = [];
    for (const off of [3, 40, 55, 70, 88]) tl.push(day(off)); // 5 in the last 90
    for (let off = 100; off < 360; off += 6) tl.push(day(off)); // ~44 more in the year
    tl.sort((a, b) => a.d.localeCompare(b.d));

    expect(activeDaysWithin(tl, 30)).toBeLessThan(12);
    expect(activeDaysWithin(tl, 90)).toBeLessThan(12);
    expect(activeDaysWithin(tl, 365)).toBeGreaterThanOrEqual(12);
    expect(defaultRangeFor(tl, now)).toBe(365);
  });

  it("shows a dormant repository whole, so it is clear when it was alive", () => {
    expect(defaultRangeFor(daily("2019-01-01", "2019-06-01"), now)).toBe(0);
  });

  it("falls back for an empty timeline rather than throwing", () => {
    expect(defaultRangeFor([], now)).toBe(90);
  });

  it("only ever returns a range the control offers", () => {
    const offered = RANGES.map((r) => r.days);
    for (const tl of [
      daily("2026-09-01", "2026-09-18"),
      daily("2020-01-01", "2026-09-18"),
      daily("2019-01-01", "2019-02-01"),
      [],
    ]) {
      expect(offered).toContain(defaultRangeFor(tl, now));
    }
  });
});
