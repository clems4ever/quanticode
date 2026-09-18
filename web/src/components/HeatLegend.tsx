import { Box, Group, Text } from "@mantine/core";
import { rampGradient } from "../lib/heat";

interface Props {
  scheme: "dark" | "light";
  halfLifeDays: number;
  compact?: boolean;
}

/**
 * The key to the one scale in the app. Sequential, so it is a continuous bar
 * with labelled ends rather than a set of swatches; the half-life is named on
 * it because "hot" means nothing without the window it is measured against.
 */
export default function HeatLegend({ scheme, halfLifeDays, compact }: Props) {
  const ticks = [
    { at: 0, label: "cold" },
    { at: 0.5, label: `${fmtDays(halfLifeDays)} ago` },
    { at: 1, label: "just now" },
  ];

  return (
    <Box>
      {!compact && (
        <Text size="xs" c="dimmed" fw={600} mb={6}>
          Edit recency
        </Text>
      )}
      <Box
        h={compact ? 8 : 10}
        style={{
          borderRadius: 6,
          background: rampGradient(scheme),
          border: `1px solid ${scheme === "dark" ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)"}`,
        }}
      />
      <Group justify="space-between" mt={5} gap={4} wrap="nowrap">
        {ticks.map((t) => (
          <Text
            key={t.label}
            size="10px"
            c="dimmed"
            fw={500}
            style={{ whiteSpace: "nowrap", textAlign: t.at === 0 ? "left" : t.at === 1 ? "right" : "center", flex: 1 }}
          >
            {t.label}
          </Text>
        ))}
      </Group>
    </Box>
  );
}

function fmtDays(d: number): string {
  if (d < 1) return `${Math.round(d * 24)}h`;
  if (d < 14) return `${Math.round(d)}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  if (d < 365) return `${Math.round(d / 30.44)}mo`;
  return `${(d / 365.25).toFixed(1)}y`;
}
