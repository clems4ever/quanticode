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
  { value: "90", label: "3 months" },
  { value: "365", label: "1 year" },
];

/** A half-life that makes the repo's own history fill the ramp. */
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
