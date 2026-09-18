import { describe, expect, it } from "vitest";
import {
  formatCompact,
  formatNumber,
  heatAt,
  heatColor,
  heatOf,
  heatRGBA,
  heatToRampPosition,
  inkOn,
  rampGradient,
  relativeTime,
  RAMP_DARK,
  RAMP_LIGHT,
  type Bucket,
} from "./heat";
import { checkRamp, oklch } from "./colorcheck";

const DAY = 86400;
const NOW = 1_700_000_000;

describe("heatAt", () => {
  it("is 1 for a line edited now", () => {
    expect(heatAt(NOW, NOW, 7)).toBe(1);
  });

  it("halves every half-life", () => {
    expect(heatAt(NOW - 7 * DAY, NOW, 7)).toBeCloseTo(0.5, 10);
    expect(heatAt(NOW - 14 * DAY, NOW, 7)).toBeCloseTo(0.25, 10);
    expect(heatAt(NOW - 21 * DAY, NOW, 7)).toBeCloseTo(0.125, 10);
  });

  it("clamps future timestamps to full heat rather than exceeding 1", () => {
    // Rebases and clock skew can put an author date slightly ahead of now.
    expect(heatAt(NOW + 5 * DAY, NOW, 7)).toBe(1);
  });

  it("decays toward zero, underflowing for extreme age-to-half-life ratios", () => {
    // 0.5 ** 3650 is below the smallest double, so it becomes exactly 0 and
    // every such line ties at the coldest step. Rankings break that tie on last
    // edit; see FileTable and AreaRanking.
    expect(heatAt(NOW - 100 * DAY, NOW, 1)).toBeGreaterThan(0);
    expect(heatAt(NOW - 3650 * DAY, NOW, 1)).toBe(0);
  });
});

describe("heatOf", () => {
  const buckets: Bucket[] = [
    [NOW, 1], // 1 fresh line
    [NOW - 7 * DAY, 9], // 9 lines one half-life old
  ];

  it("weights every line equally in average mode", () => {
    // (1*1 + 9*0.5) / 10
    expect(heatOf(buckets, NOW, 7, "average")).toBeCloseTo(0.55, 10);
  });

  it("uses only the newest line in latest mode", () => {
    expect(heatOf(buckets, NOW, 7, "latest")).toBe(1);
  });

  it("does not depend on bucket order", () => {
    const reversed: Bucket[] = [...buckets].reverse();
    expect(heatOf(reversed, NOW, 7, "average")).toBeCloseTo(
      heatOf(buckets, NOW, 7, "average"),
      12,
    );
    expect(heatOf(reversed, NOW, 7, "latest")).toBe(heatOf(buckets, NOW, 7, "latest"));
  });

  it("returns 0 for a file with no lines", () => {
    expect(heatOf([], NOW, 7, "average")).toBe(0);
    expect(heatOf([], NOW, 7, "latest")).toBe(0);
  });

  it("keeps a mostly-old file cold even when one line is fresh", () => {
    // This is the whole point of the average metric.
    const mostlyOld: Bucket[] = [
      [NOW, 1],
      [NOW - 365 * DAY, 499],
    ];
    expect(heatOf(mostlyOld, NOW, 7, "average")).toBeLessThan(0.01);
    expect(heatOf(mostlyOld, NOW, 7, "latest")).toBe(1);
  });

  it("is monotonic in half-life", () => {
    const short = heatOf(buckets, NOW, 1, "average");
    const long = heatOf(buckets, NOW, 30, "average");
    expect(long).toBeGreaterThan(short);
  });
});

describe("heatToRampPosition", () => {
  it("maps the unit interval onto itself", () => {
    expect(heatToRampPosition(0)).toBe(0);
    expect(heatToRampPosition(1)).toBe(1);
  });

  it("clamps out-of-range input", () => {
    expect(heatToRampPosition(-1)).toBe(0);
    expect(heatToRampPosition(2)).toBe(1);
  });

  it("is strictly increasing, so colour order still encodes recency", () => {
    let prev = -1;
    for (let h = 0; h <= 1.0001; h += 0.05) {
      const pos = heatToRampPosition(h);
      expect(pos).toBeGreaterThan(prev);
      prev = pos;
    }
  });

  it("lifts the cold half off the floor", () => {
    // Without this, exponential decay crowds nearly every tile onto the coldest
    // step and the map reads as uniformly cold.
    expect(heatToRampPosition(0.05)).toBeGreaterThan(0.2);
  });
});

describe("heatColor", () => {
  for (const scheme of ["dark", "light"] as const) {
    const ramp = scheme === "dark" ? RAMP_DARK : RAMP_LIGHT;

    it(`${scheme}: hits the ramp endpoints exactly`, () => {
      expect(heatColor(0, scheme)).toBe(toRgb(ramp[0]));
      expect(heatColor(1, scheme)).toBe(toRgb(ramp[ramp.length - 1]));
    });

    it(`${scheme}: returns a parseable rgb() for every heat`, () => {
      for (let h = 0; h <= 1.0001; h += 0.02) {
        expect(heatColor(h, scheme)).toMatch(/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/);
      }
    });

    it(`${scheme}: moves monotonically in lightness with heat`, () => {
      const direction = scheme === "dark" ? 1 : -1;
      let prev = oklch(rgbToHex(heatColor(0, scheme))).L;
      for (let h = 0.05; h <= 1.0001; h += 0.05) {
        const L = oklch(rgbToHex(heatColor(h, scheme))).L;
        expect((L - prev) * direction).toBeGreaterThan(-1e-6);
        prev = L;
      }
    });
  }
});

describe("the ember ramps", () => {
  // The gate for a sequential ramp: monotonic lightness, a salient hot end, and
  // enough lightness span to be readable end to end.
  const cases = [
    { name: "dark", ramp: RAMP_DARK, surface: "#14161a", direction: "up" as const },
    { name: "light", ramp: RAMP_LIGHT, surface: "#ffffff", direction: "down" as const },
  ];

  for (const { name, ramp, surface, direction } of cases) {
    describe(name, () => {
      const report = checkRamp(ramp, surface, direction);

      it("is strictly monotonic in lightness", () => {
        expect(report.firstBreak, `lightness reverses at step ${report.firstBreak}`).toBeNull();
        expect(report.monotonic).toBe(true);
      });

      it("has a hot end that stands out against its surface", () => {
        expect(report.hotContrast).toBeGreaterThanOrEqual(3);
      });

      it("spans enough lightness to be read end to end", () => {
        expect(report.lightnessSpan).toBeGreaterThanOrEqual(0.35);
      });

      it("keeps enough chroma to read as a heat ramp, not a grey scale", () => {
        // The coldest step is allowed to recede toward the surface.
        for (const step of report.steps.slice(2)) {
          expect(step.C).toBeGreaterThan(0.02);
        }
      });
    });
  }
});

describe("heatRGBA", () => {
  it("carries the requested alpha", () => {
    expect(heatRGBA(0.5, "dark", 0.1)).toMatch(/^rgba\(\d+, \d+, \d+, 0\.1\)$/);
  });

  it("matches heatColor's channels at the same heat", () => {
    const solid = heatColor(0.42, "dark").match(/\d+/g)!.slice(0, 3);
    const alpha = heatRGBA(0.42, "dark", 0.5).match(/\d+/g)!.slice(0, 3);
    expect(alpha).toEqual(solid);
  });
});

describe("inkOn", () => {
  it("switches to dark ink once the tile is bright", () => {
    expect(inkOn(1, "dark")).toBe("#181410");
    expect(inkOn(0, "dark")).toContain("255");
  });

  it("switches to light ink once the tile is dark, on a light surface", () => {
    expect(inkOn(1, "light")).toContain("255");
    expect(inkOn(0, "light")).toBe("#1b1c20");
  });
});

describe("rampGradient", () => {
  it("produces a CSS gradient with the requested number of stops", () => {
    const g = rampGradient("dark", 5);
    expect(g.startsWith("linear-gradient(90deg, ")).toBe(true);
    expect(g.match(/rgb\(/g)).toHaveLength(5);
    expect(g).toContain("0.0%");
    expect(g).toContain("100.0%");
  });
});

describe("relativeTime", () => {
  const cases: [number, string][] = [
    [0, "just now"],
    [30, "just now"],
    [60 * 5, "5m ago"],
    [3600 * 3, "3h ago"],
    [DAY * 3, "3d ago"],
    [DAY * 14, "2w ago"],
    [DAY * 100, "3mo ago"],
    [DAY * 800, "2.2y ago"],
  ];
  for (const [age, want] of cases) {
    it(`${age}s ago reads as "${want}"`, () => {
      expect(relativeTime(NOW - age, NOW)).toBe(want);
    });
  }

  it("does not produce negative ages for future timestamps", () => {
    expect(relativeTime(NOW + DAY, NOW)).toBe("just now");
  });
});

describe("number formatting", () => {
  it("formats compactly", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1500)).toBe("1.5k");
    expect(formatCompact(45_000)).toBe("45k");
    expect(formatCompact(2_300_000)).toBe("2.3M");
  });

  it("groups full numbers", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });
});

function toRgb(hex: string): string {
  const h = hex.replace("#", "");
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
}

function rgbToHex(rgb: string): string {
  const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
