import type { FileHeat } from "./api";
import { heatOf, type HeatMetric } from "./heat";

export interface RepoStats {
  files: number;
  lines: number;
  freshLines: number;
  freshShare: number;
  medianAgeDays: number;
  hottest: { path: string; heat: number } | null;
  coldest: { path: string; heat: number } | null;
}

/** Aggregate figures for the stat tiles, over whichever files are in view. */
export function computeStats(
  files: FileHeat[],
  now: number,
  halfLifeDays: number,
  metric: HeatMetric,
): RepoStats {
  let lines = 0;
  let freshLines = 0;
  const cutoff = now - halfLifeDays * 86400;
  const ages: { age: number; n: number }[] = [];

  for (const f of files) {
    lines += f.l;
    for (const [t, n] of f.k) {
      if (t >= cutoff) freshLines += n;
      ages.push({ age: now - t, n });
    }
  }

  ages.sort((a, b) => a.age - b.age);
  let seen = 0;
  let medianAge = 0;
  const half = lines / 2;
  for (const a of ages) {
    seen += a.n;
    if (seen >= half) {
      medianAge = a.age;
      break;
    }
  }

  let hottest: RepoStats["hottest"] = null;
  let coldest: RepoStats["coldest"] = null;
  for (const f of files) {
    const h = heatOf(f.k, now, halfLifeDays, metric);
    if (!hottest || h > hottest.heat) hottest = { path: f.p, heat: h };
    if (!coldest || h < coldest.heat) coldest = { path: f.p, heat: h };
  }

  return {
    files: files.length,
    lines,
    freshLines,
    freshShare: lines === 0 ? 0 : freshLines / lines,
    medianAgeDays: medianAge / 86400,
    hottest,
    coldest,
  };
}

export const HALF_LIFE_PRESETS = [
  { value: "0.5", label: "12 hours" },
  { value: "1", label: "1 day" },
  { value: "3", label: "3 days" },
  { value: "7", label: "1 week" },
  { value: "14", label: "2 weeks" },
  { value: "30", label: "1 month" },
  // 2 and 6 months fill what used to be a jump from one month straight to a
  // year — the range most repositories calibrate into.
  { value: "60", label: "2 months" },
  { value: "90", label: "3 months" },
  { value: "180", label: "6 months" },
  { value: "365", label: "1 year" },
];

/**
 * A half-life above which the map is washed to the hot end.
 *
 * Heat only means something against a cold background. Once much more than this
 * share of the code reads hot there is nothing for the recent work to stand out
 * from, which is the failure that started this: a year of half-life on
 * authelia/authelia paints 29% of the map hot and the whole thing reads yellow.
 */
const HOT_CAP = 0.18;

/**
 * Below this spread, no half-life separates the repository and the map is one
 * flat colour whatever is chosen.
 */
const FLAT_SPREAD = 0.35;

/** How many bands the heat ramp is judged in. */
const BINS = 12;

export interface Calibration {
  /** The chosen half-life, as a HALF_LIFE_PRESETS value. */
  halfLife: string;
  /** How much of the ramp that half-life actually uses, 0 to 1. */
  spread: number;
  /** Share of lines reading hot at that half-life. */
  hotShare: number;
  /**
   * True when no half-life separates this repository, because nearly every
   * line is the same age. Not a failure to report as one: it is a fact about
   * the repository, and usually means the code arrived in one import or one
   * generated burst.
   */
  flat: boolean;
}

/**
 * Picks the half-life that renders a particular repository best.
 *
 * A fixed default cannot work, because a half-life is measured against a
 * repository's own pace. Deriving it from the repository's *span* — which this
 * used to do — is the wrong input too: authelia/authelia and gin-gonic/gin are
 * both about a decade old and want very different values, because what differs
 * is how recently the code was last touched, not how long the project has
 * existed.
 *
 * Two things have to hold at once, and each alone picks a bad answer.
 *
 * Maximising spread alone picks a year on authelia — the very rendering this is
 * meant to fix — because an even histogram and a legible map are not the same
 * thing. Every variant does: entropy by line, by file, by root-line-count, and
 * Otsu separability and plain variance both land on a plateau flat enough to be
 * noise.
 *
 * Targeting a share of hot code alone is worse. It has no guard against
 * overshoot, and on a repository written in one burst the hot share jumps from
 * 1.9% at one week to 99.9% at one month with nothing in between — so "the
 * first half-life reaching the target" selects the uniformly orange one.
 *
 * So: the most spread, among the half-lives that do not wash the map to the hot
 * end. When every half-life washes out — a repository whose every line was
 * written today — take the least washed, which is the shortest and the only one
 * that separates this morning from last night.
 */
export function calibrateHeat(files: FileHeat[], now: number): Calibration {
  if (files.length === 0) {
    return { halfLife: "30", spread: 0, hotShare: 0, flat: true };
  }

  const scored = HALF_LIFE_PRESETS.map((preset) => {
    const halfLifeDays = Number(preset.value);
    const hs = fileHeats(files, now, halfLifeDays);
    return {
      halfLife: preset.value,
      spread: spreadOf(hs),
      hotShare: hotShareOf(hs),
    };
  });

  const usable = scored.filter((c) => c.hotShare <= HOT_CAP);
  const best = usable.length > 0
    ? usable.reduce((a, b) => (b.spread > a.spread ? b : a))
    : scored.reduce((a, b) => (b.hotShare < a.hotShare ? b : a));

  return { ...best, flat: best.spread < FLAT_SPREAD };
}

/** The rendered heat of every file, paired with the area it occupies. */
function fileHeats(files: FileHeat[], now: number, halfLifeDays: number): [number, number][] {
  return files.map((f) => [heatOf(f.k, now, halfLifeDays, "average"), f.l]);
}

/**
 * How much of the colour ramp a set of heats actually uses, as normalised
 * entropy over the ramp's bands, weighted by area — a map is read by how much
 * of it is each colour, not by how many files are.
 */
function spreadOf(heats: [number, number][]): number {
  const hist = new Array<number>(BINS).fill(0);
  let total = 0;
  for (const [h, w] of heats) {
    hist[Math.min(BINS - 1, Math.floor(h * BINS))] += w;
    total += w;
  }
  if (total === 0) return 0;
  let e = 0;
  for (const c of hist) {
    if (c > 0) {
      const p = c / total;
      e -= p * Math.log(p);
    }
  }
  return e / Math.log(BINS);
}

function hotShareOf(heats: [number, number][]): number {
  let lines = 0;
  let hot = 0;
  for (const [h, w] of heats) {
    lines += w;
    if (h > 0.5) hot += w;
  }
  return lines === 0 ? 0 : hot / lines;
}

/** Share of tracked lines living in files that read hot (heat above one half). */
export function hotShare(files: FileHeat[], now: number, halfLifeDays: number): number {
  return hotShareOf(fileHeats(files, now, halfLifeDays));
}

/**
 * A half-life derived from the repository's span.
 *
 * Superseded by calibrateHalfLife, which measures how recently the code was
 * actually touched rather than how long the project has existed. Kept as the
 * fallback for a payload with no files to measure.
 */
export function defaultHalfLife(firstCommit: number, lastCommit: number): string {
  const spanDays = Math.max(1, (lastCommit - firstCommit) / 86400);
  const target = spanDays / 6;
  let best = HALF_LIFE_PRESETS[2];
  let bestDiff = Infinity;
  for (const p of HALF_LIFE_PRESETS) {
    const d = Math.abs(Math.log(Number(p.value) / target));
    if (d < bestDiff) {
      bestDiff = d;
      best = p;
    }
  }
  return best.value;
}
