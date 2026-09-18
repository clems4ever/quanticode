/**
 * Heat model.
 *
 * A line's heat is an exponential decay of its age: a line edited right now is
 * 1.0, a line edited one half-life ago is 0.5, two half-lives ago 0.25. The
 * half-life is the single knob the reader turns to ask "recent compared to
 * what?" — a week for a sprint view, a quarter for an architectural one.
 */

export type Bucket = [time: number, lines: number];

export type HeatMetric = "average" | "latest";

/** Heat of a single timestamp, in (0, 1]. */
export function heatAt(time: number, now: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now - time) / 86400);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Heat of a set of lines grouped by last-edit time.
 * "average" weights every line equally — a file where one line changed yesterday
 * and 500 did not is correctly cold. "latest" answers "when was this last
 * touched at all", which makes any file with a recent one-line fix glow.
 */
export function heatOf(
  buckets: Bucket[],
  now: number,
  halfLifeDays: number,
  metric: HeatMetric,
): number {
  if (buckets.length === 0) return 0;
  if (metric === "latest") {
    let latest = 0;
    for (const [t] of buckets) if (t > latest) latest = t;
    return heatAt(latest, now, halfLifeDays);
  }
  let sum = 0;
  let total = 0;
  for (const [t, n] of buckets) {
    sum += heatAt(t, now, halfLifeDays) * n;
    total += n;
  }
  return total === 0 ? 0 : sum / total;
}

/* ------------------------------------------------------------------ *
 * The ember ramp.
 *
 * Sequential encoding of one magnitude (recency), so it is a single
 * continuous arc with strictly monotonic lightness — validated by
 * tools/check-ramp.mjs, which gates monotonicity, hot-end contrast and
 * lightness span. Each mode has its own steps against its own surface:
 * on dark the hot end is the bright one, on light it is the dark one,
 * so "hot" is always the salient end.
 * ------------------------------------------------------------------ */

export const RAMP_DARK = [
  "#222834", "#2d3048", "#41335a", "#5c3663", "#7d3a60", "#a04455",
  "#c25742", "#dc7430", "#ee9a28", "#f7c243", "#ffe08a",
] as const;

export const RAMP_LIGHT = [
  "#eceef2", "#dcdfe9", "#c8cadd", "#b3b0cd", "#a795bb", "#a87ba4",
  "#ad6588", "#b1506a", "#ab4049", "#97302c", "#7a2418",
] as const;

type RGB = [number, number, number];

const parseHex = (hex: string): RGB => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const RAMPS: Record<"dark" | "light", RGB[]> = {
  dark: RAMP_DARK.map(parseHex),
  light: RAMP_LIGHT.map(parseHex),
};

/**
 * Perceptual position on the ramp.
 *
 * Heat is exponential, so raw values crowd near zero and almost every tile
 * would land on the cold step. Raising it to a power below 1 spreads the cold
 * half across the ramp without reordering anything — the encoding stays
 * monotonic in recency, which is what the reader is decoding.
 */
export function heatToRampPosition(heat: number): number {
  return Math.pow(Math.min(1, Math.max(0, heat)), 0.42);
}

/** Interpolated ramp colour for a heat value in [0, 1]. */
export function heatColor(heat: number, scheme: "dark" | "light"): string {
  const ramp = RAMPS[scheme];
  const pos = heatToRampPosition(heat) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = ramp[i];
  const b = ramp[i + 1];
  const mix = (x: number, y: number) => Math.round(x + (y - x) * f);
  return `rgb(${mix(a[0], b[0])}, ${mix(a[1], b[1])}, ${mix(a[2], b[2])})`;
}

/** Ramp colour with an alpha channel, for row tints layered over a surface. */
export function heatRGBA(heat: number, scheme: "dark" | "light", alpha: number): string {
  const ramp = RAMPS[scheme];
  const pos = heatToRampPosition(heat) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = ramp[i];
  const b = ramp[i + 1];
  const mix = (x: number, y: number) => Math.round(x + (y - x) * f);
  return `rgba(${mix(a[0], b[0])}, ${mix(a[1], b[1])}, ${mix(a[2], b[2])}, ${alpha})`;
}

/** A CSS gradient of the full ramp, for legends and heat strips. */
export function rampGradient(scheme: "dark" | "light", steps = 24): string {
  const stops: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    // Invert the perceptual transform so the legend axis is linear in heat.
    stops.push(`${heatColor(Math.pow(t, 1 / 0.42), scheme)} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** Ink that stays readable on a given heat colour. */
export function inkOn(heat: number, scheme: "dark" | "light"): string {
  const pos = heatToRampPosition(heat);
  if (scheme === "dark") return pos > 0.62 ? "#181410" : "rgba(255,255,255,0.92)";
  return pos > 0.48 ? "rgba(255,255,255,0.95)" : "#1b1c20";
}

/* ----------------------------- formatting ----------------------------- */

export function relativeTime(unix: number, now: number): string {
  const s = Math.max(0, now - unix);
  const mins = s / 60;
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)}d ago`;
  const weeks = days / 7;
  if (days < 60) return `${Math.round(weeks)}w ago`;
  const months = days / 30.44;
  if (days < 365) return `${Math.round(months)}mo ago`;
  return `${(days / 365.25).toFixed(1)}y ago`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
