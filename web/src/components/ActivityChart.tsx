import { useMemo, useState } from "react";
import { Box, Group, Text } from "@mantine/core";
import type { DayStat } from "../lib/api";
import { formatCompact, heatAt, heatColor } from "../lib/heat";

interface Props {
  timeline: DayStat[];
  now: number;
  halfLifeDays: number;
  scheme: "dark" | "light";
  height?: number;
}

interface Bin {
  start: number;
  end: number;
  label: string;
  commits: number;
  added: number;
  removed: number;
}

/**
 * Commit activity over the repository's life.
 *
 * Bars are counts and wear the heat ramp at their own position in time, so the
 * timeline and the map are read with one key. Empty days are kept as zero-height
 * bars rather than dropped — a gap in activity is information, and a compressed
 * axis would hide it.
 */
export default function ActivityChart({ timeline, now, halfLifeDays, scheme, height = 104 }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const bins = useMemo(() => buildBins(timeline), [timeline]);
  const max = Math.max(1, ...bins.map((b) => b.commits));

  if (bins.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No commit history.
      </Text>
    );
  }

  const active = hover !== null ? bins[hover] : null;
  // A pixel gap, not a percentage: percentage gaps resolve against the
  // container width, and N of them quickly leave the bars no room at all.
  const gapPx = bins.length > 120 ? 1 : bins.length > 60 ? 2 : 3;

  return (
    <Box pos="relative">
      <Group justify="space-between" align="flex-end" mb={6} wrap="nowrap">
        <Text size="xs" c="dimmed" fw={600}>
          Commits over time
        </Text>
        <Text size="10px" c="dimmed" style={{ fontVariantNumeric: "tabular-nums", minHeight: 14 }}>
          {active
            ? `${active.label} · ${active.commits} commit${active.commits === 1 ? "" : "s"} · +${formatCompact(active.added)} / −${formatCompact(active.removed)}`
            : `${bins.length} ${bins[0].end - bins[0].start > 86400 * 2 ? "weeks" : "days"}`}
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

/** Fill missing days, then roll up to weeks once a daily axis would be unreadable. */
function buildBins(timeline: DayStat[]): Bin[] {
  if (timeline.length === 0) return [];
  const byDate = new Map(timeline.map((d) => [d.d, d]));
  const start = parseDay(timeline[0].d);
  const end = parseDay(timeline[timeline.length - 1].d);
  const days: Bin[] = [];
  for (let t = start; t <= end; t += 86400) {
    const key = dayKey(t);
    const d = byDate.get(key);
    days.push({
      start: t,
      end: t + 86400,
      label: shortDate(t),
      commits: d?.c ?? 0,
      added: d?.a ?? 0,
      removed: d?.r ?? 0,
    });
  }
  if (days.length <= 92) return days;

  const weeks: Bin[] = [];
  for (let i = 0; i < days.length; i += 7) {
    const chunk = days.slice(i, i + 7);
    weeks.push({
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
      label: `week of ${shortDate(chunk[0].start)}`,
      commits: chunk.reduce((s, c) => s + c.commits, 0),
      added: chunk.reduce((s, c) => s + c.added, 0),
      removed: chunk.reduce((s, c) => s + c.removed, 0),
    });
  }
  return weeks;
}

function parseDay(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
}

function dayKey(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

function shortDate(t: number): string {
  return new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
