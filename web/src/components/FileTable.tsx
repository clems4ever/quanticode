import { useMemo, useState } from "react";
import { Box, Group, ScrollArea, SegmentedControl, Stack, Text, UnstyledButton } from "@mantine/core";
import type { FileHeat } from "../lib/api";
import { formatCompact, formatNumber, heatColor, heatOf, relativeTime, type HeatMetric } from "../lib/heat";

interface Props {
  files: FileHeat[];
  now: number;
  halfLifeDays: number;
  metric: HeatMetric;
  scheme: "dark" | "light";
  query: string;
  onOpenFile: (path: string) => void;
  maxHeight: number;
}

type Sort = "hot" | "cold" | "lines";

/** Every file as a ranked list — the treemap's data, sorted and searchable. */
export default function FileTable({
  files, now, halfLifeDays, metric, scheme, query, onOpenFile, maxHeight,
}: Props) {
  const [sort, setSort] = useState<Sort>("hot");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const withHeat = files
      .filter((f) => !q || f.p.toLowerCase().includes(q))
      .map((f) => ({ f, heat: heatOf(f.k, now, halfLifeDays, metric) }));
    // Heat underflows to 0 for very old lines, so ties are broken on last edit
    // to keep both ends of the ranking in a meaningful order.
    withHeat.sort((a, b) => {
      if (sort === "lines") return b.f.l - a.f.l || b.f.le - a.f.le;
      if (sort === "cold") return a.heat - b.heat || a.f.le - b.f.le;
      return b.heat - a.heat || b.f.le - a.f.le;
    });
    return withHeat;
  }, [files, now, halfLifeDays, metric, query, sort]);

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <SegmentedControl
          size="xs"
          radius="md"
          value={sort}
          onChange={(v) => setSort(v as Sort)}
          data={[
            { value: "hot", label: "Hottest" },
            { value: "cold", label: "Coldest" },
            { value: "lines", label: "Largest" },
          ]}
        />
        <Text size="xs" c="dimmed">
          {formatNumber(rows.length)} files
        </Text>
      </Group>

      <ScrollArea.Autosize mah={maxHeight} type="hover" scrollbarSize={8} offsetScrollbars className="gh-scroll">
        <Stack gap={1} pr={6}>
          {rows.map(({ f, heat }) => (
            <UnstyledButton
              key={f.p}
              onClick={() => onOpenFile(f.p)}
              className="gh-area-row"
              p={7}
              style={{ borderRadius: 8 }}
            >
              <Group gap={10} wrap="nowrap" align="center">
                <Box
                  w={4}
                  h={26}
                  style={{ borderRadius: 2, background: heatColor(heat, scheme), flexShrink: 0 }}
                />
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text size="xs" fw={550} truncate title={f.p}>
                    {f.p}
                  </Text>
                  <Text size="10px" c="dimmed" truncate>
                    {formatCompact(f.l)} lines · {f.nc} commit{f.nc === 1 ? "" : "s"} · {f.ta}
                    {f.g ? " · generated" : ""}
                  </Text>
                </Box>
                <Box style={{ flexShrink: 0, textAlign: "right" }}>
                  <Text size="xs" fw={640} style={{ fontVariantNumeric: "tabular-nums" }}>
                    {(heat * 100).toFixed(0)}
                  </Text>
                  <Text size="10px" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                    {relativeTime(f.le, now)}
                  </Text>
                </Box>
              </Group>
            </UnstyledButton>
          ))}
          {rows.length === 0 && (
            <Text size="sm" c="dimmed" ta="center" py="xl">
              No files match “{query}”.
            </Text>
          )}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  );
}
