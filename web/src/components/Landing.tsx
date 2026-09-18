import { useState } from "react";
import {
  Anchor, Box, Button, Card, Center, Code, Group, Stack, Text, TextInput, Title,
} from "@mantine/core";
import { IconArrowRight, IconSearch } from "@tabler/icons-react";
import { parseInput, pathForSource } from "../lib/source";
import type { Limits } from "../lib/api";

/**
 * A way in for somebody with nothing to paste.
 *
 * Every one of these is checked to fit inside the default size limit, because
 * an example that cannot work is worse than no example at all: it reads as the
 * whole service being broken rather than as one repository being too big. The
 * sizes are from the GitHub API and are what these were when this list was
 * written.
 */
const EXAMPLES = [
  { src: "github.com/gin-gonic/gin", note: "10 MB" },
  { src: "github.com/jqlang/jq", note: "8 MB" },
  { src: "github.com/charmbracelet/bubbletea", note: "6 MB" },
  { src: "github.com/cli/cli", note: "79 MB" },
  { src: "github.com/clems4ever/quanticode", note: "" },
];

/**
 * The page at the root.
 *
 * Its main job is to teach the URL, because the URL is the product: once
 * somebody knows they can put quanticode in front of a GitHub address, they
 * never need this page again.
 */
export default function Landing({
  onOpen,
  localRepos,
  limits,
}: {
  onOpen: (src: string) => void;
  localRepos: { slug: string; name: string }[];
  limits?: Limits;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const src = parseInput(value);
    if (!src) {
      setError("That does not look like a repository. Try github.com/owner/name.");
      return;
    }
    setError(null);
    onOpen(src);
  };

  return (
    <Center mih="100vh" p="xl">
      <Stack gap="xl" maw={640} w="100%">
        <Stack gap={6}>
          <Group gap={10} align="center">
            <Box style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
              {[0, 1, 2, 3].map((i) => (
                <Box key={i} w={9} h={9} style={{ borderRadius: 2, background: `var(--gh-mark-${i})` }} />
              ))}
            </Box>
            <Title order={2} fw={700} style={{ letterSpacing: "-0.02em" }}>
              quanticode
            </Title>
          </Group>
          <Text c="dimmed" size="sm">
            Measurable perspectives on a codebase. Every file and every line coloured by how
            recently it last changed.
          </Text>
        </Stack>

        <Card withBorder radius="md" p="lg">
          <Stack gap="sm">
            <Text size="sm" fw={560}>
              Put <Code>quanticode.dev/</Code> in front of any GitHub URL
            </Text>
            <Code block>quanticode.dev/github.com/gin-gonic/gin</Code>
            <Text size="xs" c="dimmed">
              Or paste one here.
            </Text>
            <Group gap="xs" wrap="nowrap">
              <TextInput
                flex={1}
                placeholder="github.com/owner/repo"
                value={value}
                error={error}
                leftSection={<IconSearch size={15} />}
                onChange={(e) => {
                  setValue(e.currentTarget.value);
                  setError(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              <Button onClick={submit} rightSection={<IconArrowRight size={15} />} variant="default">
                Open
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              Public repositories only. The first look clones and blames the whole history, which
              takes a moment; after that it is cached
              {limits?.refreshHours ? ` and refreshed every ${limits.refreshHours}h` : ""}.
              {limits?.maxRepoMB
                ? ` This instance indexes repositories up to ${formatSize(limits.maxRepoMB)} and ${formatCount(limits.maxFiles)} files — very large repositories such as the Linux kernel are refused.`
                : ""}
            </Text>
          </Stack>
        </Card>

        <Stack gap={8}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: "0.06em" }}>
            Try one
          </Text>
          <Group gap="md">
            {EXAMPLES.map(({ src, note }) => (
              <Anchor key={src} href={pathForSource(src)} size="sm" underline="hover">
                {src.replace("github.com/", "")}
                {note && (
                  <Text span size="xs" c="dimmed">
                    {" "}
                    {note}
                  </Text>
                )}
              </Anchor>
            ))}
          </Group>
        </Stack>

        {localRepos.length > 0 && (
          <Stack gap={8}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: "0.06em" }}>
              On this instance
            </Text>
            <Group gap="xs">
              {localRepos.map((r) => (
                <Anchor key={r.slug} href={`/?repo=${encodeURIComponent(r.slug)}`} size="sm" underline="hover">
                  {r.name}
                </Anchor>
              ))}
            </Group>
          </Stack>
        )}
      </Stack>
    </Center>
  );
}

function formatSize(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}
