import { useMemo, useRef, useState, type CSSProperties } from "react";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { Box, Group, Paper, Text } from "@mantine/core";
import { IconGitCommit } from "@tabler/icons-react";
import type { Commit } from "../lib/api";
import { commitOf } from "../lib/commits";
import type { TreeNode } from "../lib/tree";
import { formatCompact, formatNumber, heatColor, inkOn, relativeTime } from "../lib/heat";

const DIR_LABEL_H = 17;
const MIN_TILE = 0.7;

interface Props {
  root: TreeNode;
  width: number;
  height: number;
  scheme: "dark" | "light";
  now: number;
  query: string;
  onZoom: (path: string) => void;
  onOpenFile: (path: string) => void;
  /** Every commit in the repository, so a tile can name the one behind it. */
  commits: Record<string, Commit>;
}

interface Hover {
  node: TreeNode;
  x: number;
  y: number;
}

/**
 * A squarified treemap of the repository.
 *
 * Area is line count, colour is heat. Directories keep their children adjacent
 * and carry their own aggregate heat in the frame and label strip, so an entire
 * area of the repo reads hot or cold before any individual file is examined.
 */
export default function Treemap({
  root, width, height, scheme, now, query, onZoom, onOpenFile, commits,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const layout = useMemo(() => {
    if (width <= 0 || height <= 0) return null;
    const h = hierarchy<TreeNode>(root, (d) => (d.children.length ? d.children : null))
      .sum((d) => (d.children.length === 0 ? Math.max(d.lines, 1) : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    return treemap<TreeNode>()
      .tile(treemapSquarify.ratio(1.3))
      .size([width, height])
      .paddingInner(1)
      .paddingOuter(1)
      .paddingTop((d) =>
        d.depth > 0 && d.y1 - d.y0 > DIR_LABEL_H + 16 && d.x1 - d.x0 > 46 ? DIR_LABEL_H : 2,
      )
      .round(true)(h);
  }, [root, width, height]);

  if (!layout) return null;

  const nodes = layout.descendants();
  const q = query.trim().toLowerCase();
  const matches = (n: TreeNode) => !q || n.path.toLowerCase().includes(q);

  const internal = nodes.filter((n) => n.depth > 0 && n.children);
  const leaves = nodes.filter((n) => !n.children);

  return (
    <Box ref={containerRef} pos="relative" style={{ width, height }}>
      <svg
        className="gh-treemap"
        width={width}
        height={height}
        role="img"
        aria-label={`Treemap of ${root.path || root.name}: ${formatNumber(root.lines)} lines across ${root.fileCount} files, coloured by edit recency`}
        onMouseLeave={() => setHover(null)}
      >
        {/* Directory frames: the region's own heat, held well below the leaves
            so the tiles inside stay the dominant signal. */}
        {internal.map((n) => {
          const d = n.data;
          const w = n.x1 - n.x0;
          const hgt = n.y1 - n.y0;
          if (w < 3 || hgt < 3) return null;
          return (
            <rect
              key={`f-${d.path}`}
              x={n.x0}
              y={n.y0}
              width={w}
              height={hgt}
              rx={Math.min(7, w / 4, hgt / 4)}
              fill={heatColor(d.heat, scheme)}
              opacity={matches(d) ? 0.2 : 0.07}
              stroke={heatColor(d.heat, scheme)}
              strokeOpacity={matches(d) ? 0.38 : 0.12}
              strokeWidth={1}
            />
          );
        })}

        {/* Leaves: one tile per file. */}
        {leaves.map((n) => {
          const d = n.data;
          const w = n.x1 - n.x0;
          const hgt = n.y1 - n.y0;
          if (w < MIN_TILE || hgt < MIN_TILE) return null;
          const on = matches(d);
          const isHovered = hover?.node.path === d.path;
          return (
            <g key={`l-${d.path}`}>
              <rect
                className="gh-tile"
                x={n.x0}
                y={n.y0}
                width={w}
                height={hgt}
                rx={Math.min(3, w / 3, hgt / 3)}
                fill={heatColor(d.heat, scheme)}
                opacity={on ? (d.file?.g ? 0.55 : 1) : 0.13}
                stroke={isHovered ? (scheme === "dark" ? "#fff" : "#14161a") : "none"}
                strokeWidth={isHovered ? 1.5 : 0}
                onMouseMove={(e) => showHover(e, d, containerRef, setHover)}
                onMouseEnter={(e) => showHover(e, d, containerRef, setHover)}
                onClick={() => onOpenFile(d.path)}
              >
                <title>{`${d.path} — ${formatNumber(d.lines)} lines, last edited ${relativeTime(d.lastEdit, now)}`}</title>
              </rect>
              {w > 52 && hgt > 19 && on && (
                <text
                  className="gh-tile-label"
                  x={n.x0 + 5}
                  y={n.y0 + 13}
                  fontSize={10.5}
                  fontWeight={520}
                  fill={inkOn(d.heat, scheme)}
                  opacity={0.95}
                >
                  {clip(d.name, Math.floor((w - 10) / 5.9))}
                </text>
              )}
            </g>
          );
        })}

        {/* Directory labels, drawn last so they sit above every tile. */}
        {internal.map((n) => {
          const d = n.data;
          const w = n.x1 - n.x0;
          if (n.y1 - n.y0 <= DIR_LABEL_H + 16 || w <= 46) return null;
          const on = matches(d);
          return (
            <g
              key={`t-${d.path}`}
              style={{ cursor: "zoom-in" }}
              onClick={() => onZoom(d.path)}
              onMouseMove={(e) => showHover(e, d, containerRef, setHover)}
              onMouseEnter={(e) => showHover(e, d, containerRef, setHover)}
            >
              <rect x={n.x0} y={n.y0} width={w} height={DIR_LABEL_H} fill="transparent" />
              <circle
                cx={n.x0 + 8}
                cy={n.y0 + DIR_LABEL_H / 2}
                r={3}
                fill={heatColor(d.heat, scheme)}
                opacity={on ? 1 : 0.3}
              />
              <text
                className="gh-dir-label"
                x={n.x0 + 15}
                y={n.y0 + DIR_LABEL_H / 2 + 3.6}
                fontSize={10.5}
                fontWeight={650}
                fill={scheme === "dark" ? "rgba(255,255,255,0.82)" : "rgba(15,17,21,0.78)"}
                opacity={on ? 1 : 0.35}
              >
                {clip(d.name, Math.floor((w - 24) / 6.1))}
              </text>
            </g>
          );
        })}
      </svg>

      {hover && (
        <HoverCard
          hover={hover}
          scheme={scheme}
          now={now}
          bounds={{ width, height }}
          commits={commits}
        />
      )}
    </Box>
  );
}

function showHover(
  e: React.MouseEvent,
  node: TreeNode,
  ref: React.RefObject<HTMLDivElement | null>,
  set: (h: Hover) => void,
) {
  const rect = ref.current?.getBoundingClientRect();
  if (!rect) return;
  set({ node, x: e.clientX - rect.left, y: e.clientY - rect.top });
}

function clip(s: string, max: number): string {
  if (max < 3) return "";
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function HoverCard({
  hover, scheme, now, bounds, commits,
}: {
  hover: Hover;
  scheme: "dark" | "light";
  now: number;
  bounds: { width: number; height: number };
  commits: Record<string, Commit>;
}) {
  const { node } = hover;
  // The commit behind this tile's most recent change. The payload keys commits
  // by full sha and files carry the short one, so the index is built once.
  const commit = commitOf(node, commits);
  const W = 290;
  const H = commit ? 196 : 150;
  const left = Math.min(Math.max(8, hover.x + 16), Math.max(8, bounds.width - W - 8));
  const top = hover.y > bounds.height - H ? Math.max(8, hover.y - (H - 2)) : hover.y + 16;

  const style: CSSProperties = {
    position: "absolute",
    left,
    top,
    width: W,
    pointerEvents: "none",
    zIndex: 5,
    backdropFilter: "blur(10px)",
  };

  return (
    <Paper style={style} p="sm" shadow="xl" bg={scheme === "dark" ? "rgba(20,22,26,0.94)" : "rgba(255,255,255,0.96)"}>
      <Text size="xs" fw={600} lh={1.35} style={{ wordBreak: "break-all" }}>
        {node.path || node.name}
      </Text>
      <Box mt={8} mb={8} h={4} style={{ borderRadius: 3, background: heatColor(node.heat, scheme) }} />
      <Text size="xs" c="dimmed" lh={1.6}>
        {node.isDir
          ? `${formatNumber(node.fileCount)} files · ${formatNumber(node.lines)} lines`
          : `${formatNumber(node.lines)} lines · ${node.commits} commit${node.commits === 1 ? "" : "s"}`}
        <br />
        Heat {(node.heat * 100).toFixed(0)}% · last edit {relativeTime(node.lastEdit, now)}
        {!node.isDir && node.file?.ta && (
          <>
            <br />
            Mostly {node.file.ta}
          </>
        )}
        {node.isDir && (
          <>
            <br />
            <Text span size="xs" c="dimmed" fs="italic">
              Click the label to zoom in
            </Text>
          </>
        )}
      </Text>
      {!node.isDir && node.file?.g && (
        <Text size="10px" c="dimmed" mt={4} fs="italic">
          generated file — {formatCompact(node.lines)} lines
        </Text>
      )}

      {/* The commit that made this tile the temperature it is. Without it the
          card can only say "3 days ago", which answers when but never what. */}
      {commit && (
        <Box
          mt={9}
          pt={8}
          style={{ borderTop: `1px solid ${scheme === "dark" ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.08)"}` }}
        >
          <Group gap={5} wrap="nowrap" mb={3}>
            <IconGitCommit size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
            <Text size="10px" c="dimmed" ff="monospace">
              {commit.short}
            </Text>
          </Group>
          <Text size="xs" lh={1.35} lineClamp={2}>
            {commit.summary}
          </Text>
          <Text size="10px" c="dimmed" mt={2} truncate>
            {commit.author} · {relativeTime(commit.time, now)}
          </Text>
        </Box>
      )}
    </Paper>
  );
}
