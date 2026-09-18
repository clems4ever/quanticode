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
 * The share of the codebase that should read as recently touched.
 *
 * This is the one number the calibration turns on, and it is a statement about
 * reading rather than about statistics: the map works when most of it is cold
 * background and a visible minority stands out as current. Around a sixth does
 * that. Well above it and the map washes to the hot end with nothing to contrast
 * against; well below it and the map goes uniformly dark.
 */
const HOT_TARGET = 0.15;

/**
 * Picks the half-life that renders a particular repository best.
 *
 * A fixed default cannot work, because the half-life is measured against a
 * repository's own pace. A year of half-life on authelia/authelia paints 29% of
 * the map hot and the whole thing reads yellow; a month paints 12% and it goes
 * dark. Three months lands on 15% and the structure appears.
 *
 * Deriving it from the repository's *span* — what this used to do — is the wrong
 * input: authelia and gin are both about a decade old and want wildly different
 * half-lives, because what differs is how recently the code was last touched,
 * not how long the project has existed.
 *
 * So measure the thing that actually matters. Walk the presets from shortest to
 * longest and take the first at which at least HOT_TARGET of the code still
 * reads hot.
 *
 * The two ends both matter. A repository committed to today is hot at every
 * scale and gets the shortest half-life, which is the only one that separates
 * this morning from last night. A dormant repository never reaches the target at
 * any scale and gets the longest, because the widest scale is the only one that
 * shows anything at all — the fallback is not an edge case to tolerate but the
 * correct answer for an abandoned project.
 */
export function calibrateHalfLife(files: FileHeat[], now: number): string {
  if (files.length === 0) return "30";
  for (const preset of HALF_LIFE_PRESETS) {
    if (hotShare(files, now, Number(preset.value)) >= HOT_TARGET) return preset.value;
  }
  return HALF_LIFE_PRESETS[HALF_LIFE_PRESETS.length - 1].value;
}

/** Share of tracked lines living in files that read hot (heat above one half). */
export function hotShare(files: FileHeat[], now: number, halfLifeDays: number): number {
  let lines = 0;
  let hot = 0;
  for (const f of files) {
    const h = heatOf(f.k, now, halfLifeDays, "average");
    lines += f.l;
    if (h > 0.5) hot += f.l;
  }
  return lines === 0 ? 0 : hot / lines;
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
