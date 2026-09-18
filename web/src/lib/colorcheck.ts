/**
 * Colour-space maths used to gate the heat ramps.
 *
 * A sequential ramp is not checked the way a categorical palette is: the gate is
 * monotonic lightness across the ramp plus contrast at the salient end, not
 * pairwise separation. These helpers exist so that check runs in CI as a test,
 * rather than living in a script nobody runs.
 */

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

const linearise = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** OKLCH lightness, chroma and hue for an sRGB hex colour. */
export function oklch(hex: string): { L: number; C: number; h: number } {
  const [r, g, b] = hexToRgb(hex).map(linearise);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: (Math.atan2(B, A) * 180) / Math.PI };
}

const relativeLuminance = (hex: string): number => {
  const [r, g, b] = hexToRgb(hex).map(linearise);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio between two hex colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export interface RampReport {
  monotonic: boolean;
  firstBreak: number | null;
  hotContrast: number;
  lightnessSpan: number;
  steps: { hex: string; L: number; C: number; contrast: number }[];
}

/**
 * Check a sequential ramp given cold-to-hot, against the surface it is drawn on.
 * `direction` is the expected lightness trend from cold to hot: "up" on a dark
 * surface (hot is the bright end), "down" on a light one (hot is the dark end).
 */
export function checkRamp(
  ramp: readonly string[],
  surface: string,
  direction: "up" | "down",
): RampReport {
  const steps = ramp.map((hex) => {
    const { L, C } = oklch(hex);
    return { hex, L, C, contrast: contrast(hex, surface) };
  });

  let firstBreak: number | null = null;
  for (let i = 1; i < steps.length; i++) {
    const rising = steps[i].L > steps[i - 1].L;
    if (direction === "up" ? !rising : rising) {
      if (firstBreak === null) firstBreak = i;
    }
  }

  return {
    monotonic: firstBreak === null,
    firstBreak,
    hotContrast: steps[steps.length - 1].contrast,
    lightnessSpan: Math.abs(steps[steps.length - 1].L - steps[0].L),
    steps,
  };
}
