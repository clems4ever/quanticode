import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon, Badge, Box, Group, Loader, Paper, ScrollArea, Stack, Text, Tooltip,
} from "@mantine/core";
import { IconX, IconGitCommit } from "@tabler/icons-react";
import { fetchFile, type FilePayload } from "../lib/api";
import {
  formatNumber, heatAt, heatColor, heatRGBA, relativeTime, type HeatMetric,
} from "../lib/heat";
import HeatLegend from "./HeatLegend";

const ROW_H = 19;
const OVERSCAN = 30;

interface Props {
  path: string;
  scheme: "dark" | "light";
  now: number;
  halfLifeDays: number;
  metric: HeatMetric;
  onClose: () => void;
  isMobile: boolean;
}

/**
 * One file, line by line.
 *
 * The treemap answers "where is the repo hot"; this answers "which lines
 * exactly". Each row carries a solid heat bar at full saturation and a very low
 * alpha wash behind the code, so the heat reads down the gutter without ever
 * competing with the text for legibility.
 */
export default function FileViewer({
  path, scheme, now, halfLifeDays, onClose, isMobile,
}: Props) {
  const [data, setData] = useState<FilePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const viewportRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);

  // The caller remounts this component per path (key={path}), so state starts
  // fresh and this effect only has to fetch.
  useEffect(() => {
    let cancelled = false;
    fetchFile(path)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, [data]);

  const lineHeat = useMemo(() => {
    if (!data) return [];
    return data.lines.map((l) => {
      const c = data.commits[l.c];
      return c ? heatAt(c.time, now, halfLifeDays) : 0;
    });
  }, [data, now, halfLifeDays]);

  // Minimap: every line of the file compressed into one column, so the shape of
  // the file's history is visible even when only 40 lines are on screen.
  useEffect(() => {
    const cv = minimapRef.current;
    if (!cv || lineHeat.length === 0) return;
    const h = Math.max(1, cv.clientHeight);
    const w = Math.max(1, cv.clientWidth);
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const n = lineHeat.length;
    const step = h / n;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = heatColor(lineHeat[i], scheme);
      ctx.fillRect(0, i * step, w, Math.max(step, 1));
    }
  }, [lineHeat, scheme, viewH]);

  const total = data?.lines.length ?? 0;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const gutter = `${Math.max(34, String(total).length * 8 + 18)}px`;

  const activeCommit = active !== null && data ? data.commits[data.lines[active].c] : null;

  const header = (
    <Box p={{ base: "sm", sm: "md" }} pb="xs" style={{ flexShrink: 0 }}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="sm">
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Text size="xs" c="dimmed" mb={2}>
            {path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."}
          </Text>
          <Text fw={660} fz={{ base: 15, sm: 17 }} style={{ wordBreak: "break-all", letterSpacing: "-0.01em" }}>
            {path.split("/").pop()}
          </Text>
        </Box>
        <ActionIcon variant="subtle" color="gray" onClick={onClose} aria-label="Close file" size="lg">
          <IconX size={18} />
        </ActionIcon>
      </Group>
      {data && (
        <Group gap={6} mt={10} wrap="wrap">
          <Badge variant="default" size="sm" radius="sm" fw={550}>
            {formatNumber(total)} lines
          </Badge>
          <Badge variant="default" size="sm" radius="sm" fw={550}>
            {Object.keys(data.commits).length} commits
          </Badge>
          <Badge variant="default" size="sm" radius="sm" fw={550}>
            {data.ext}
          </Badge>
        </Group>
      )}
      <Box mt="sm" maw={280}>
        <HeatLegend scheme={scheme} halfLifeDays={halfLifeDays} compact />
      </Box>
    </Box>
  );

  if (error) {
    return (
      <Stack h="100%">
        {header}
        <Text c="dimmed" size="sm" p="md">
          Could not load this file: {error}
        </Text>
      </Stack>
    );
  }

  if (!data) {
    return (
      <Stack h="100%">
        {header}
        <Group justify="center" py="xl">
          <Loader size="sm" color="gray" />
          <Text size="sm" c="dimmed">
            Blaming {path.split("/").pop()}…
          </Text>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack h="100%" gap={0}>
      {header}

      <Group gap={0} style={{ flex: 1, minHeight: 0 }} align="stretch" wrap="nowrap">
        <ScrollArea
          viewportRef={viewportRef}
          onScrollPositionChange={(p) => setScrollTop(p.y)}
          type="auto"
          scrollbarSize={10}
          style={{ flex: 1, minWidth: 0 }}
          className="gh-scroll"
        >
          <Box
            className="gh-code"
            style={{
              height: total * ROW_H,
              position: "relative",
              fontFamily: "var(--mantine-font-family-monospace)",
              fontSize: 12.5,
              lineHeight: `${ROW_H}px`,
              ["--gutter" as string]: gutter,
            }}
          >
            <Box style={{ position: "absolute", top: first * ROW_H, left: 0, right: 0 }}>
              {data.lines.slice(first, last).map((line, k) => {
                const i = first + k;
                const h = lineHeat[i];
                const c = data.commits[line.c];
                return (
                  <Box
                    key={i}
                    className="gh-code-row"
                    style={{ height: ROW_H, background: heatRGBA(h, scheme, scheme === "dark" ? 0.1 : 0.13) }}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => setActive(i)}
                    title={c ? `${c.summary} — ${c.author}, ${relativeTime(c.time, now)}` : undefined}
                  >
                    <Box component="span" className="gh-code-num">
                      {i + 1}
                    </Box>
                    <Box style={{ background: heatColor(h, scheme) }} />
                    <Box component="span" className="gh-code-text">
                      {line.t === "" ? " " : line.t}
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Box>
        </ScrollArea>

        {!isMobile && (
          <Tooltip label="Whole-file heat — click to jump" position="left">
            <Box
              w={14}
              style={{ flexShrink: 0, cursor: "pointer", position: "relative" }}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const frac = (e.clientY - r.top) / r.height;
                viewportRef.current?.scrollTo({ top: frac * total * ROW_H - viewH / 2 });
              }}
            >
              <canvas ref={minimapRef} style={{ width: "100%", height: "100%", display: "block" }} />
              {/* Where the reader currently is in the file. */}
              <Box
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: `${(scrollTop / Math.max(1, total * ROW_H)) * 100}%`,
                  height: `${Math.min(100, (viewH / Math.max(1, total * ROW_H)) * 100)}%`,
                  border: `1px solid ${scheme === "dark" ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.55)"}`,
                  background: scheme === "dark" ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.06)",
                  pointerEvents: "none",
                }}
              />
            </Box>
          </Tooltip>
        )}
      </Group>

      {/* Commit detail for the line under the cursor, pinned so it never covers
          the code and never chases the pointer. */}
      <Paper
        radius={0}
        style={{ flexShrink: 0, borderLeft: 0, borderRight: 0, borderBottom: 0 }}
        p="xs"
        pl={{ base: "sm", sm: "md" }}
        pr={56}
      >
        {activeCommit ? (
          <Group gap={9} wrap="nowrap">
            <Box
              w={4}
              style={{ alignSelf: "stretch", borderRadius: 2, background: heatColor(lineHeat[active!], scheme), flexShrink: 0 }}
            />
            <Box style={{ minWidth: 0, flex: 1 }}>
              <Text size="xs" fw={570} truncate>
                {activeCommit.summary}
              </Text>
              <Text size="10px" c="dimmed" truncate>
                line {active! + 1} · {activeCommit.author} · {relativeTime(activeCommit.time, now)} ·{" "}
                <Text span ff="monospace" size="10px">
                  {activeCommit.short}
                </Text>
              </Text>
            </Box>
          </Group>
        ) : (
          <Group gap={7} c="dimmed">
            <IconGitCommit size={14} />
            <Text size="xs">
              {isMobile ? "Tap" : "Hover"} a line to see the commit that last changed it
            </Text>
          </Group>
        )}
      </Paper>
    </Stack>
  );
}
