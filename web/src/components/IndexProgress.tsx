import { Alert, Anchor, Box, Button, Center, Group, Loader, Progress, Stack, Text, Title } from "@mantine/core";
import { IconAlertTriangle, IconBrandGithub } from "@tabler/icons-react";
import type { IndexStatus } from "../lib/api";
import { formatNumber } from "../lib/heat";

/**
 * What a visitor sees while a repository nobody has asked for before is being
 * cloned and blamed.
 *
 * The states are named rather than hidden behind a spinner, because the wait is
 * long enough that "what is it doing" is a fair question: a first-time clone of
 * a large repository is minutes, and a queue behind two workers can add more.
 *
 * The blame sweep is the long part — authelia/authelia is 3,359 files and about
 * three minutes — and it was reported as "does not work" precisely because a
 * stage name with no number behind it looks identical to a hang. So the sweep
 * shows a real count and a real bar. The clone still shows an indeterminate one,
 * because git reports no usable progress for it and a made-up percentage is
 * worse than an honest spinner.
 */
export default function IndexProgress({
  status,
  elapsed,
  onRetry,
}: {
  status: IndexStatus;
  elapsed: number;
  onRetry: () => void;
}) {
  if (status.state === "failed") {
    return (
      <Center h="100vh" p="xl">
        <Stack align="center" gap="md" maw={560}>
          <Alert
            icon={<IconAlertTriangle size={18} />}
            color="orange"
            variant="light"
            radius="md"
            title={`Could not index ${status.label}`}
            w="100%"
          >
            <Text size="sm">{status.error || "The index failed for an unknown reason."}</Text>
          </Alert>
          <Text c="dimmed" size="xs" ta="center">
            Most often this means the repository is private, does not exist, or is larger than this
            instance will take on.
          </Text>
          <Group gap="xs">
            <Button size="xs" variant="default" onClick={onRetry}>
              Try again
            </Button>
            <Anchor
              href={`https://${status.source}`}
              target="_blank"
              rel="noreferrer"
              size="sm"
              c="dimmed"
            >
              <Group gap={5} wrap="nowrap">
                <IconBrandGithub size={14} />
                <span>Open on GitHub</span>
              </Group>
            </Anchor>
          </Group>
        </Stack>
      </Center>
    );
  }

  const stage = describe(status);
  // Only the sweep can be measured; everything else is honestly indeterminate.
  const sweeping = status.state === "analysing" && status.stage !== "summarising";
  const swept = sweeping && status.files ? (status.blamed ?? 0) : 0;
  const pct = swept > 0 && status.files ? Math.min(100, (swept / status.files) * 100) : null;

  return (
    <Center h="100vh" p="xl">
      <Stack align="center" gap="sm" maw={460} w="100%">
        <Loader color="gray" size="sm" />
        <Title order={4} fw={620} ta="center">
          {status.label}
        </Title>
        <Text c="dimmed" size="sm" ta="center">
          {stage}
        </Text>
        <Box w="100%" mt={4}>
          <Progress
            value={pct ?? 100}
            animated={pct === null}
            radius="xl"
            size="xs"
            color="gray"
          />
        </Box>
        <Text c="dimmed" size="xs" style={{ fontVariantNumeric: "tabular-nums" }}>
          {formatElapsed(elapsed)}
          {pct !== null && status.files
            ? ` · ${formatNumber(swept)} of ${formatNumber(status.files)} files · ${Math.floor(pct)}%`
            : status.files
              ? ` · ${formatNumber(status.files)} files`
              : ""}
        </Text>
        <Text c="dimmed" size="xs" ta="center" mt={4}>
          First look at a repository only — a large one takes a few minutes. The result is
          cached, so coming back is instant.
        </Text>
      </Stack>
    </Center>
  );
}

function describe(status: IndexStatus): string {
  switch (status.state) {
    case "queued":
      return status.position && status.position > 1
        ? `Queued, ${ordinal(status.position)} in line…`
        : "Queued…";
    case "cloning":
      return "Cloning the repository…";
    case "fetching":
      return "Fetching what has changed…";
    case "analysing":
      if (status.stage === "summarising") return "Rolling up authors and history…";
      return status.files
        ? `Blaming ${formatNumber(status.files)} files, line by line…`
        : "Blaming every line…";
    case "ready":
      return "Loading the analysis…";
    default:
      return "Working…";
  }
}

function ordinal(n: number): string {
  const suffix = n % 10 === 1 && n % 100 !== 11 ? "st"
    : n % 10 === 2 && n % 100 !== 12 ? "nd"
    : n % 10 === 3 && n % 100 !== 13 ? "rd"
    : "th";
  return `${n}${suffix}`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
