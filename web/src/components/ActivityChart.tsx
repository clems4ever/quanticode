import { useMemo, useState } from "react";
import { Box, Group, SegmentedControl, Text } from "@mantine/core";
import type { DayStat } from "../lib/api";
import { formatCompact, heatAt, heatColor } from "../lib/heat";
import { bucketOf, buildBins, describeBins, RANGES, totalCommits } from "../lib/timeline";

interface Props {
  timeline: DayStat[];
  now: number;
  halfLifeDays: number;
  scheme: "dark" | "light";
  height?: number;
  rangeDays: number;
  onRangeChange: (days: number) => void;
}

/**
 * Commit activity over a window.
 *
 * The window is 90 days by default rather than the repository's whole life.
 * Whole-life was the wrong default twice over: twelve years of weekly bars is a
 * two-pixel hairline each, and scaling against the tallest bar in all of history
 * flattens every recent month to nothing. It is also the wrong *question* —
 * "what is moving now" is what this panel is next to, and a decade of context
 * answers it worse than a quarter does.
 *
 * Ninety days rather than thirty because thirty is too short to compare against:
 * a project with two commits a month renders nearly empty and reads as dead
 * rather than quiet. Thirty is one click away for anyone who wants it, as is the
 * full history.
 *
 * Bars wear the heat ramp at their own position in time, so the timeline and the
 * map are read with one key. Empty periods are kept as floor-height bars rather
 * than dropped: a gap in activity is information.
 */
export default function ActivityChart({
  timeline, now, halfLifeDays, scheme, height = 104, rangeDays, onRangeChange,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const bins = useMemo(() => buildBins(timeline, now, rangeDays), [timeline, now, rangeDays]);
  // Scaled within the window, so the bars answer "how does this week compare
  // with the rest of the quarter" rather than "with the busiest week of 2014".
  const max = Math.max(1, ...bins.map((b) => b.commits));
  const total = totalCommits(bins);

  const header = (
    <Group justify="space-between" align="center" mb={6} wrap="nowrap" gap="xs">
      <Text size="xs" c="dimmed" fw={600} style={{ whiteSpace: "nowrap" }}>
        Commits over time
      </Text>
      <SegmentedControl
        size="xs"
        value={String(rangeDays)}
        onChange={(v) => onRangeChange(Number(v))}
        data={RANGES.map((r) => ({ value: String(r.days), label: r.label }))}
        styles={{ root: { background: "transparent" }, label: { padding: "1px 7px", fontSize: 10 } }}
      />
    </Group>
  );

  if (bins.length === 0) {
    return (
      <Box pos="relative">
        {header}
        <Text size="sm" c="dimmed">
          No commit history.
        </Text>
      </Box>
    );
  }

  const active = hover !== null ? bins[hover] : null;
  // A pixel gap, not a percentage: percentage gaps resolve against the
  // container width, and N of them quickly leave the bars no room at all.
  const gapPx = bins.length > 120 ? 1 : bins.length > 60 ? 2 : 3;

  return (
    <Box pos="relative">
      {header}

      <Group justify="space-between" align="flex-end" mb={4} wrap="nowrap">
        <Text size="10px" c="dimmed" style={{ fontVariantNumeric: "tabular-nums", minHeight: 14 }}>
          {active
            ? `${active.label} · ${active.commits} commit${active.commits === 1 ? "" : "s"} · +${formatCompact(active.added)} / −${formatCompact(active.removed)}`
            : `${formatCompact(total)} commit${total === 1 ? "" : "s"} · ${describeBins(bins, bucketOf(bins))}`}
        </Text>
      </Group>

      <Box
        style={{ display: "flex", alignItems: "flex-end", gap: gapPx, height }}
        onMouseLeave={() => setHover(null)}
      >
        {bins.map((b, i) => {
          const h = (b.commits / max) * 100;
          const heat = heatAt(b.end, now, halfLifeDays);
          return (
            <Box
              key={b.start}
              style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end", cursor: "default", minWidth: 0 }}
              onMouseEnter={() => setHover(i)}
              title={`${b.label}: ${b.commits} commits`}
            >
              <Box
                style={{
                  width: "100%",
                  // A floor so an empty period is still visibly a period.
                  height: `${Math.max(h, b.commits > 0 ? 3 : 1.5)}%`,
                  background: b.commits > 0
                    ? heatColor(heat, scheme)
                    : scheme === "dark" ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.07)",
                  borderRadius: "3px 3px 1px 1px",
                  opacity: hover === null || hover === i ? 1 : 0.42,
                  transition: "opacity 100ms ease",
                }}
              />
            </Box>
          );
        })}
      </Box>

      <Group justify="space-between" mt={5}>
        <Text size="10px" c="dimmed">
          {bins[0].label}
        </Text>
        <Text size="10px" c="dimmed">
          {bins[bins.length - 1].label}
        </Text>
      </Group>
    </Box>
  );
}
