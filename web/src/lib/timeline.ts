import type { DayStat } from "./api";

/**
 * Binning for the activity chart.
 *
 * Two things were wrong with showing a repository's whole life at a fixed bar
 * width. A twelve-year history is 640 weeks, which in a panel a thousand pixels
 * wide is a two-pixel hairline per bar — the shape carries nothing. And scaling
 * every bar against the tallest bar in *all* of history means one early burst
 * flattens the recent months to invisibility, so even the bars you can see are
 * misscaled for the question being asked.
 *
 * So the chart takes a window, and the bucket follows from it: the range is
 * chosen by the reader, and the bucket is chosen so the bars stay wide enough to
 * read. Nothing here decides what "recent" means — that is the caller's default.
 */

export type Bucket = "day" | "week" | "month";

export interface Bin {
  start: number; // unix seconds, inclusive
  end: number; // unix seconds, exclusive
  label: string;
  commits: number;
  added: number;
  removed: number;
}

export interface Range {
  /** Days back from now, or 0 for the whole history. */
  days: number;
  label: string;
}

export const RANGES: Range[] = [
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "1y" },
  { days: 0, label: "All" },
];

/** The window used before a repository's own activity is known. */
export const DEFAULT_RANGE_DAYS = 90;

/**
 * A window needs about this many days with commits in it before the bar chart
 * has a shape rather than one spike in a field of zeros.
 */
const MIN_ACTIVE_DAYS = 12;

/**
 * Picks the opening window for a repository.
 *
 * No fixed default works. Measured across mature projects, the last 30 days of
 * gin-gonic/gin contains commits on exactly one day, and bubbletea two — both
 * are healthy, widely used projects that a 30-day chart draws as abandoned. A
 * repository under daily development has the opposite problem with a year:
 * weekly buckets flatten the thing the reader came to look at.
 *
 * So take the shortest window that still shows something, and let the reader
 * override it permanently. The control shows which window is in use, so this is
 * visible rather than magic.
 */
export function defaultRangeFor(timeline: DayStat[], now: number): number {
  if (timeline.length === 0) return DEFAULT_RANGE_DAYS;
  const today = Math.floor(now / 86400) * 86400;
  for (const range of RANGES) {
    if (range.days === 0) break;
    const cutoff = today - (range.days - 1) * 86400;
    let active = 0;
    for (const d of timeline) {
      if (d.c > 0 && parseDay(d.d) >= cutoff) active++;
    }
    if (active >= MIN_ACTIVE_DAYS) return range.days;
  }
  // Nothing recent enough to fill a window: a dormant repository is best shown
  // whole, so the reader can see when it was alive.
  return 0;
}

/**
 * Picks the coarsest bucket that still leaves a readable number of bars.
 *
 * The ceiling is about width rather than taste: past roughly 120 bars in a
 * panel this size each one is under six pixels and the chart stops being a
 * shape and becomes texture.
 */
export function chooseBucket(spanDays: number): Bucket {
  if (spanDays <= 120) return "day";
  if (spanDays <= 800) return "week"; // ~114 weeks
  return "month";
}

/**
 * Builds the bars for one window.
 *
 * `now` is when the window ends, not the last commit: a repository whose last
 * commit was two years ago *should* show an empty last 90 days, because that is
 * the answer to the question being asked.
 */
export function buildBins(timeline: DayStat[], now: number, rangeDays: number): Bin[] {
  if (timeline.length === 0) return [];

  const firstCommitDay = parseDay(timeline[0].d);
  const today = startOfDay(now);

  const start = rangeDays > 0 ? Math.max(firstCommitDay, today - (rangeDays - 1) * 86400) : firstCommitDay;
  const end = Math.max(today, parseDay(timeline[timeline.length - 1].d));
  if (end < start) return [];

  const byDate = new Map(timeline.map((d) => [d.d, d]));
  const spanDays = Math.round((end - start) / 86400) + 1;
  const bucket = chooseBucket(spanDays);

  const days: Bin[] = [];
  for (let t = start; t <= end; t += 86400) {
    const d = byDate.get(dayKey(t));
    days.push({
      start: t,
      end: t + 86400,
      label: dayLabel(t),
      commits: d?.c ?? 0,
      added: d?.a ?? 0,
      removed: d?.r ?? 0,
    });
  }

  if (bucket === "day") return days;
  if (bucket === "week") return rollUp(days, 7, (chunk) => `week of ${dayLabel(chunk[0].start)}`);
  return rollUpMonths(days);
}

/** Total commits across bins, for the summary line. */
export function totalCommits(bins: Bin[]): number {
  return bins.reduce((s, b) => s + b.commits, 0);
}

/** "90 days · daily" — what the reader is actually looking at. */
export function describeBins(bins: Bin[], bucket: Bucket): string {
  const noun = bucket === "day" ? "days" : bucket === "week" ? "weeks" : "months";
  return `${bins.length} ${noun}`;
}

/** The bucket a set of bins was built at, derived from the first bar's width. */
export function bucketOf(bins: Bin[]): Bucket {
  if (bins.length === 0) return "day";
  const width = bins[0].end - bins[0].start;
  if (width <= 86400 * 2) return "day";
  if (width <= 86400 * 8) return "week";
  return "month";
}

function rollUp(days: Bin[], size: number, label: (chunk: Bin[]) => string): Bin[] {
  const out: Bin[] = [];
  for (let i = 0; i < days.length; i += size) {
    const chunk = days.slice(i, i + size);
    out.push(merge(chunk, label(chunk)));
  }
  return out;
}

/** Calendar months, not 30-day chunks, so the labels mean something. */
function rollUpMonths(days: Bin[]): Bin[] {
  const out: Bin[] = [];
  let chunk: Bin[] = [];
  let key = "";
  for (const d of days) {
    const k = dayKey(d.start).slice(0, 7);
    if (k !== key && chunk.length > 0) {
      out.push(merge(chunk, monthLabel(chunk[0].start)));
      chunk = [];
    }
    key = k;
    chunk.push(d);
  }
  if (chunk.length > 0) out.push(merge(chunk, monthLabel(chunk[0].start)));
  return out;
}

function merge(chunk: Bin[], label: string): Bin {
  return {
    start: chunk[0].start,
    end: chunk[chunk.length - 1].end,
    label,
    commits: chunk.reduce((s, c) => s + c.commits, 0),
    added: chunk.reduce((s, c) => s + c.added, 0),
    removed: chunk.reduce((s, c) => s + c.removed, 0),
  };
}

export function parseDay(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
}

function startOfDay(t: number): number {
  return Math.floor(t / 86400) * 86400;
}

function dayKey(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

function dayLabel(t: number): string {
  return new Date(t * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function monthLabel(t: number): string {
  return new Date(t * 1000).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
