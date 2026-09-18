import { Box, Group, Paper, SimpleGrid, Text, Tooltip } from "@mantine/core";
import { heatColor } from "../lib/heat";

export interface Stat {
  label: string;
  value: string;
  hint?: string;
  heat?: number;
  help?: string;
}

/**
 * The headline numbers. These are figures, not charts — no plot, so no hover
 * layer beyond the explanatory tooltip on the label.
 */
export default function StatTiles({
  stats,
  scheme,
  compact,
}: {
  stats: Stat[];
  scheme: "dark" | "light";
  /** Denser tiles for the phone layout, where they sit below the map. */
  compact?: boolean;
}) {
  return (
    <SimpleGrid cols={{ base: compact ? 3 : 2, xs: 3, lg: 6 }} spacing="xs">
      {stats.map((s) => (
        <Paper key={s.label} p={compact ? "xs" : "sm"} radius="lg">
          <Group gap={6} wrap="nowrap" mb={4}>
            {s.heat !== undefined && (
              <Box
                w={7}
                h={7}
                style={{ borderRadius: 999, background: heatColor(s.heat, scheme), flexShrink: 0 }}
              />
            )}
            <Tooltip label={s.help} disabled={!s.help} multiline w={220}>
              <Text
                size={compact ? "9px" : "10px"}
                c="dimmed"
                fw={650}
                tt="uppercase"
                lts="0.06em"
                style={{ cursor: s.help ? "help" : undefined, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {s.label}
              </Text>
            </Tooltip>
          </Group>
          <Text
            fz={compact ? 15 : 22}
            fw={680}
            lh={1.15}
            style={{ letterSpacing: "-0.02em", wordBreak: "break-word" }}
          >
            {s.value}
          </Text>
          {s.hint && (
            <Text size={compact ? "9px" : "11px"} c="dimmed" mt={3} truncate>
              {s.hint}
            </Text>
          )}
        </Paper>
      ))}
    </SimpleGrid>
  );
}

