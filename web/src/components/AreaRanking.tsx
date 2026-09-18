import type { ReactNode } from "react";
import { Box, Group, ScrollArea, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconFolder, IconFile } from "@tabler/icons-react";
import type { Commit } from "../lib/api";
import { commitOf } from "../lib/commits";
import type { TreeNode } from "../lib/tree";
import { formatCompact, heatColor, relativeTime } from "../lib/heat";

interface Props {
  node: TreeNode;
  scheme: "dark" | "light";
  now: number;
  maxHeight: number;
  onZoom: (path: string) => void;
  onOpenFile: (path: string) => void;
  /** Every commit in the repository, so a row can name the one behind it. */
  commits: Record<string, Commit>;
}

/**
 * The parts of the repo, ranked hottest to coldest.
 *
 * The treemap shows where the heat sits in the shape of the codebase; this puts
 * the same children in a strict order, so "which areas are hot and which are
 * cold" is answered by reading top to bottom rather than by hunting for colour.
 *
 * Folders rank ahead of loose files: "area" is a question about folders, and a
 * single hot 40-line file at the root would otherwise head the list.
 */
export default function AreaRanking({
  node, scheme, now, maxHeight, onZoom, onOpenFile, commits,
}: Props) {
  // Heat underflows to exactly 0 once a line is many half-lives old, so the
  // cold end of a long ranking would otherwise be in arbitrary order.
  const byHeat = (a: TreeNode, b: TreeNode) => b.heat - a.heat || b.lastEdit - a.lastEdit;
  const dirs = node.children.filter((c) => c.isDir).sort(byHeat);
  const loose = node.children.filter((c) => !c.isDir).sort(byHeat);
  const split = dirs.length > 0 && loose.length > 0;

  if (dirs.length === 0 && loose.length === 0) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="xl">
        Nothing inside this folder.
      </Text>
    );
  }

  return (
    <ScrollArea.Autosize mah={maxHeight} type="hover" scrollbarSize={8} offsetScrollbars className="gh-scroll">
      <Stack gap={2} pr={6}>
        {split && <SectionLabel>Folders</SectionLabel>}
        {dirs.map((c) => (
          <Row key={c.path} node={c} scheme={scheme} now={now} onZoom={onZoom} onOpenFile={onOpenFile} commits={commits} />
        ))}
        {split && <SectionLabel>Files here</SectionLabel>}
        {loose.map((c) => (
          <Row key={c.path} node={c} scheme={scheme} now={now} onZoom={onZoom} onOpenFile={onOpenFile} commits={commits} />
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Text size="9px" c="dimmed" fw={700} tt="uppercase" lts="0.07em" mt={9} mb={1} px={7}>
      {children}
    </Text>
  );
}

function Row({
  node, scheme, now, onZoom, onOpenFile, commits,
}: {
  node: TreeNode;
  scheme: "dark" | "light";
  now: number;
  onZoom: (path: string) => void;
  onOpenFile: (path: string) => void;
  commits: Record<string, Commit>;
}) {
  const commit = commitOf(node, commits);
  return (
    <UnstyledButton
      onClick={() => (node.isDir ? onZoom(node.path) : onOpenFile(node.path))}
      className="gh-area-row"
      p={7}
      style={{ borderRadius: 8 }}
      aria-label={`${node.name}: heat ${(node.heat * 100).toFixed(0)} of 100`}
    >
      <Group gap={8} wrap="nowrap" align="center">
        <Box style={{ flexShrink: 0, display: "flex", opacity: 0.45 }}>
          {node.isDir ? <IconFolder size={13} stroke={1.8} /> : <IconFile size={13} stroke={1.8} />}
        </Box>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} justify="space-between" wrap="nowrap" mb={4}>
            <Text size="xs" fw={560} truncate title={node.path}>
              {node.name}
            </Text>
            <Text
              size="10px"
              c="dimmed"
              fw={600}
              style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
            >
              {(node.heat * 100).toFixed(0)}
            </Text>
          </Group>
          {/* Bar length repeats heat, so the ranking survives without colour. */}
          <Box
            h={5}
            style={{
              borderRadius: 3,
              background: scheme === "dark" ? "rgba(255,255,255,0.055)" : "rgba(0,0,0,0.05)",
              overflow: "hidden",
            }}
          >
            <Box
              h="100%"
              w={`${Math.max(2.5, node.heat * 100)}%`}
              style={{ borderRadius: 3, background: heatColor(node.heat, scheme) }}
            />
          </Box>
          <Text size="10px" c="dimmed" mt={3} truncate>
            {formatCompact(node.lines)} lines
            {node.isDir ? ` · ${node.fileCount} files` : ""} · {relativeTime(node.lastEdit, now)}
          </Text>
          {/* The commit behind that last edit, on the row rather than behind a
              hover: a touch screen has no hover, so anything only reachable
              that way does not exist on half the devices this is read on. */}
          {commit && (
            <Text size="10px" c="dimmed" mt={2} truncate title={`${commit.summary} — ${commit.author}`}>
              <Text span ff="monospace" size="10px" opacity={0.75}>
                {commit.short}
              </Text>{" "}
              {commit.summary}
            </Text>
          )}
        </Box>
      </Group>
    </UnstyledButton>
  );
}
