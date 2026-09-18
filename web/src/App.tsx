import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon, Anchor, Badge, Box, Breadcrumbs, Center, Container, Divider, Drawer, Grid,
  Group, Loader, Paper, SegmentedControl, Select, Stack, Switch, Text, TextInput, Title,
  Tooltip, useMantineColorScheme,
} from "@mantine/core";
import { useElementSize, useMediaQuery } from "@mantine/hooks";
import {
  IconArrowBackUp, IconBrandGithub, IconMoon, IconSearch, IconSun, IconX,
} from "@tabler/icons-react";
import {
  fetchInstance, fetchRepo, fetchStatus, remoteLabel, remoteWebUrl,
  type IndexStatus, type Instance, type RepoPayload,
} from "./lib/api";
import { pathForSource, sourceFromPath } from "./lib/source";
import { buildTree, findNode, pathChain, type TreeNode } from "./lib/tree";
import { formatCompact, formatNumber, relativeTime, type HeatMetric } from "./lib/heat";
import { calibrateHalfLife, computeStats, HALF_LIFE_PRESETS, hotShare } from "./lib/stats";
import { DEFAULT_RANGE_DAYS, defaultRangeFor } from "./lib/timeline";
import Treemap from "./components/Treemap";
import AreaRanking from "./components/AreaRanking";
import FileTable from "./components/FileTable";
import ActivityChart from "./components/ActivityChart";
import FileViewer from "./components/FileViewer";
import HeatLegend from "./components/HeatLegend";
import StatTiles, { type Stat } from "./components/StatTiles";
import IndexProgress from "./components/IndexProgress";
import Landing from "./components/Landing";

type MobilePanel = "map" | "areas" | "files" | "activity";

export default function App() {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const scheme: "dark" | "light" = colorScheme === "light" ? "light" : "dark";
  const isMobile = useMediaQuery("(max-width: 62em)") ?? false;

  // The repository being looked at comes from the path: /github.com/owner/repo.
  // Null is the landing page.
  const [src, setSrc] = useState<string | null>(() => sourceFromPath(window.location.pathname));
  const [instance, setInstance] = useState<Instance | null>(null);
  const [data, setData] = useState<RepoPayload | null>(null);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [halfLife, setHalfLife] = useState<string>("3");
  // Whether the half-life on screen was calibrated for this repository or
  // chosen by hand. It is preselected, so it has to say so.
  const [halfLifeAuto, setHalfLifeAuto] = useState(true);
  const [metric, setMetric] = useState<HeatMetric>("average");
  const [showGenerated, setShowGenerated] = useState(false);
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState("");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [panel, setPanel] = useState<MobilePanel>("map");
  const [side, setSide] = useState<"areas" | "files">("areas");

  // The activity window: chosen from the repository's own activity until the
  // reader picks one, and then it is theirs and survives moving between repos.
  const savedRange = localStorage.getItem("qc.activityRange");
  const [activityRange, setActivityRange] = useState<number>(() =>
    savedRange !== null && Number.isFinite(Number(savedRange)) ? Number(savedRange) : DEFAULT_RANGE_DAYS,
  );
  // A ref rather than state: adopt() runs inside a promise and would otherwise
  // close over a stale value.
  const rangePinned = useRef(savedRange !== null);
  const chooseRange = (days: number) => {
    rangePinned.current = true;
    setActivityRange(days);
    localStorage.setItem("qc.activityRange", String(days));
  };

  const { ref: mapRef, width: mapWidth } = useElementSize();

  useEffect(() => {
    fetchInstance()
      .then(setInstance)
      .catch(() => setInstance({ indexing: false, repos: [] }));
  }, []);

  // Back and forward move between repositories without a reload.
  useEffect(() => {
    const onPop = () => setSrc(sourceFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openSource = (next: string) => {
    window.history.pushState({}, "", pathForSource(next));
    setSrc(next);
  };

  // No source in the path and nothing served locally: there is nothing to load,
  // so show the landing page rather than asking the server for a repository it
  // was never given.
  const landing = src === null && instance !== null && instance.repos.length === 0;

  const adopt = (d: RepoPayload) => {
    setData(d);
    setStatus(null);
    // Calibrated per repository: the half-life is measured against a project's
    // own pace, so one value cannot serve authelia and a repo started today.
    // Generated files are excluded because they are hidden by default and would
    // otherwise drag the measurement around.
    setHalfLife(calibrateHalfLife(d.files.filter((f) => !f.g), Date.now() / 1000));
    setHalfLifeAuto(true);
    if (!rangePinned.current) {
      setActivityRange(defaultRangeFor(d.timeline, Date.now() / 1000));
    }
  };

  useEffect(() => {
    if (instance === null || landing) return;
    let cancelled = false;
    setData(null);
    setStatus(null);
    setError(null);
    fetchRepo(src)
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "ready") adopt(res.data);
        else setStatus(res.status);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, instance, landing, attempt]);

  // An index in flight. Failed is terminal, so it stops the polling.
  const indexing = status !== null && status.state !== "failed" && data === null;

  useEffect(() => {
    if (!src || !indexing) return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const st = await fetchStatus(src);
        if (cancelled) return;
        setStatus(st);
        if (st.state === "ready") {
          const res = await fetchRepo(src);
          if (!cancelled && res.kind === "ready") adopt(res.data);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, indexing]);

  // A second clock, because the progress screen counts in seconds where the
  // rest of the app is happy being a minute out.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!indexing) {
      setElapsed(0);
      return;
    }
    const t0 = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - t0) / 1000), 1000);
    return () => clearInterval(id);
  }, [indexing]);

  // The clock only needs to be fresh enough that "2h ago" is not wrong; it
  // re-renders every minute rather than every frame.
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => clearInterval(id);
  }, []);

  const halfLifeDays = Number(halfLife);

  const files = useMemo(
    () => (data ? data.files.filter((f) => showGenerated || !f.g) : []),
    [data, showGenerated],
  );

  const tree = useMemo(
    () =>
      data
        ? buildTree(files, now, halfLifeDays, metric, remoteLabel(data.meta.remote) || data.meta.name)
        : null,
    [data, files, now, halfLifeDays, metric],
  );

  const zoomed = useMemo(() => (tree ? findNode(tree, zoom) ?? tree : null), [tree, zoom]);
  const crumbs = useMemo(() => (tree ? pathChain(tree, zoomed?.path ?? "") : []), [tree, zoomed]);
  // What the calibration is actually looking at, shown in the tooltip so the
  // preselected value can be checked rather than taken on faith. Must sit with
  // the other hooks: everything below here can return early.
  const hotHere = useMemo(() => hotShare(files, now, halfLifeDays), [files, now, halfLifeDays]);

  const resetHalfLife = () => {
    if (!data) return;
    setHalfLife(calibrateHalfLife(data.files.filter((f) => !f.g), Date.now() / 1000));
    setHalfLifeAuto(true);
  };

  const stats = useMemo(
    () => computeStats(files, now, halfLifeDays, metric),
    [files, now, halfLifeDays, metric],
  );

  if (landing) {
    return (
      <Landing onOpen={openSource} localRepos={instance?.repos ?? []} limits={instance?.limits} />
    );
  }

  if (error) {
    return (
      <Center h="100vh" p="xl">
        <Stack align="center" gap="xs">
          <Title order={3}>Could not load the repository</Title>
          <Text c="dimmed" size="sm" ta="center" maw={460}>
            {error}
          </Text>
        </Stack>
      </Center>
    );
  }

  if (status && !data) {
    return (
      <IndexProgress status={status} elapsed={elapsed} onRetry={() => setAttempt((n) => n + 1)} />
    );
  }

  if (!data || !tree || !zoomed) {
    return (
      <Center h="100vh">
        <Stack align="center" gap="md">
          <Loader color="gray" />
          <Text c="dimmed" size="sm">
            Blaming every line in the repository…
          </Text>
        </Stack>
      </Center>
    );
  }

  const { meta } = data;
  const ghUrl = remoteWebUrl(meta.remote);
  const mapHeight = isMobile ? 460 : 620;

  const tiles: Stat[] = [
    {
      label: "Lines tracked",
      value: formatCompact(stats.lines),
      hint: `${formatNumber(stats.files)} files`,
    },
    {
      label: `Edited in ${HALF_LIFE_PRESETS.find((p) => p.value === halfLife)?.label ?? ""}`,
      value: `${(stats.freshShare * 100).toFixed(1)}%`,
      hint: `${formatCompact(stats.freshLines)} lines`,
      help: "Share of surviving lines whose last edit falls inside the current half-life window.",
    },
    {
      label: "Median line age",
      value: fmtAge(stats.medianAgeDays),
      hint: "half the code is older",
      help: "Half of all surviving lines were last edited longer ago than this.",
    },
    {
      label: "Hottest area",
      value: hottestArea(zoomed)?.name ?? "—",
      hint: hottestArea(zoomed) ? `${(hottestArea(zoomed)!.heat * 100).toFixed(0)} heat` : undefined,
      heat: hottestArea(zoomed)?.heat ?? 1,
      help: "The child of the folder currently in view with the highest line-weighted heat.",
    },
    {
      label: "Commits",
      value: formatNumber(meta.commitCount),
      hint: `since ${new Date(meta.firstCommit * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`,
    },
    {
      label: "Contributors",
      value: formatNumber(data.authors.length),
      hint: data.authors[0] ? `${data.authors[0].name} leads` : undefined,
    },
  ];

  const controls = (
    <Paper p={{ base: "sm", sm: "md" }} radius="lg">
      <Group gap="md" wrap="wrap" align="flex-end">
        <Box>
          <Group gap={6} mb={5} align="center" wrap="nowrap">
            <Text size="10px" c="dimmed" fw={650} tt="uppercase" lts="0.06em">
              Half-life
            </Text>
            {halfLifeAuto ? (
              <Tooltip
                multiline
                w={270}
                withArrow
                label={`Calibrated for this repository: the shortest half-life at which about a sixth of the code still reads hot (${Math.round(hotHere * 100)}% here). A longer one washes the map to the hot end; a shorter one goes dark.`}
              >
                <Badge
                  size="xs"
                  variant="light"
                  color="gray"
                  radius="sm"
                  style={{ cursor: "help", textTransform: "none" }}
                >
                  auto
                </Badge>
              </Tooltip>
            ) : (
              <Tooltip withArrow label="Back to the value calibrated for this repository">
                <Badge
                  size="xs"
                  variant="outline"
                  color="gray"
                  radius="sm"
                  onClick={resetHalfLife}
                  style={{ cursor: "pointer", textTransform: "none" }}
                >
                  reset
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Select
            size="xs"
            w={124}
            radius="md"
            data={HALF_LIFE_PRESETS}
            value={halfLife}
            onChange={(v) => {
              if (!v) return;
              setHalfLife(v);
              setHalfLifeAuto(false);
            }}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
            aria-label="Heat half-life"
          />
        </Box>

        <Box>
          <Text size="10px" c="dimmed" fw={650} tt="uppercase" lts="0.06em" mb={5}>
            Heat of a file
          </Text>
          <SegmentedControl
            size="xs"
            radius="md"
            value={metric}
            onChange={(v) => setMetric(v as HeatMetric)}
            data={[
              { value: "average", label: "Every line" },
              { value: "latest", label: "Last touch" },
            ]}
          />
        </Box>

        <Box style={{ flex: 1, minWidth: 180 }}>
          <Text size="10px" c="dimmed" fw={650} tt="uppercase" lts="0.06em" mb={5}>
            Find
          </Text>
          <TextInput
            size="xs"
            radius="md"
            placeholder="Filter by path…"
            leftSection={<IconSearch size={13} />}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            rightSection={
              query ? (
                <ActionIcon size="xs" variant="subtle" color="gray" onClick={() => setQuery("")} aria-label="Clear filter">
                  <IconX size={12} />
                </ActionIcon>
              ) : null
            }
          />
        </Box>

        <Tooltip label="Lock files, vendored and generated code, tool caches and bulk data files. Hidden by default: they distort both size and heat without reflecting anyone's work." multiline w={250}>
          <Box>
            <Switch
              size="xs"
              checked={showGenerated}
              onChange={(e) => setShowGenerated(e.currentTarget.checked)}
              label={<Text size="xs" c="dimmed">Generated &amp; data</Text>}
            />
          </Box>
        </Tooltip>
      </Group>
    </Paper>
  );

  const mapPanel = (
    <Paper p={{ base: "xs", sm: "md" }} radius="lg" h="100%">
      <Group justify="space-between" mb="sm" wrap="nowrap" gap="xs" px={{ base: 4, sm: 0 }}>
        <Box style={{ minWidth: 0 }}>
          <Breadcrumbs
            separator="/"
            separatorMargin={6}
            styles={{ separator: { color: "var(--mantine-color-dimmed)", fontSize: 12 } }}
          >
            {crumbs.map((c) => (
              <Anchor
                key={c.path || "root"}
                size="xs"
                fw={c.path === zoomed.path ? 680 : 500}
                c={c.path === zoomed.path ? undefined : "dimmed"}
                onClick={() => setZoom(c.path)}
                underline="never"
                style={{ whiteSpace: "nowrap" }}
              >
                {c.name.split("/").pop()}
              </Anchor>
            ))}
          </Breadcrumbs>
          <Text size="10px" c="dimmed" mt={3}>
            {formatNumber(zoomed.lines)} lines · {formatNumber(zoomed.fileCount)} files · area is size, colour is heat
          </Text>
        </Box>
        {zoomed.path !== "" && (
          <Tooltip label="Back to the whole repository">
            <ActionIcon variant="subtle" color="gray" onClick={() => setZoom("")} aria-label="Zoom out to repository root">
              <IconArrowBackUp size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      <Box ref={mapRef} style={{ width: "100%" }}>
        {mapWidth > 0 && (
          <Treemap
            root={zoomed}
            width={mapWidth}
            height={mapHeight}
            scheme={scheme}
            now={now}
            query={query}
            onZoom={setZoom}
            onOpenFile={setOpenFile}
          />
        )}
      </Box>

      <Box mt="sm" maw={340}>
        <HeatLegend scheme={scheme} halfLifeDays={halfLifeDays} compact />
      </Box>
    </Paper>
  );

  const areasPanel = (
    <Paper p={{ base: "sm", sm: "md" }} radius="lg" h="100%">
      <Stack gap="sm" h="100%">
        <Box>
          <Text fw={660} size="sm" lh={1.2}>
            {side === "areas" ? "Hottest to coldest" : "Every file"}
          </Text>
          <Text size="10px" c="dimmed" mt={2}>
            {side === "areas"
              ? `inside ${zoomed.path || "the repository"}`
              : "ranked across the whole repository"}
          </Text>
        </Box>
        <SegmentedControl
          size="xs"
          radius="md"
          fullWidth
          value={side}
          onChange={(v) => setSide(v as "areas" | "files")}
          data={[
            { value: "areas", label: "Areas" },
            { value: "files", label: "Files" },
          ]}
        />
        {side === "areas" ? (
          <AreaRanking
            node={zoomed}
            scheme={scheme}
            now={now}
            maxHeight={mapHeight - 44}
            onZoom={setZoom}
            onOpenFile={setOpenFile}
          />
        ) : (
          <FileTable
            files={files}
            now={now}
            halfLifeDays={halfLifeDays}
            metric={metric}
            scheme={scheme}
            query={query}
            onOpenFile={setOpenFile}
            maxHeight={mapHeight - 90}
          />
        )}
      </Stack>
    </Paper>
  );

  const activityPanel = (
    <Paper p={{ base: "sm", sm: "md" }} radius="lg">
      <ActivityChart
        timeline={data.timeline}
        now={now}
        halfLifeDays={halfLifeDays}
        scheme={scheme}
        height={isMobile ? 84 : 104}
        rangeDays={activityRange}
        onRangeChange={chooseRange}
      />
    </Paper>
  );

  return (
    <Box className="gh-page" mih="100vh">
      <Paper
        radius={0}
        p={0}
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          borderLeft: 0,
          borderRight: 0,
          borderTop: 0,
          backdropFilter: "blur(14px)",
          background: scheme === "dark" ? "rgba(11,12,14,0.78)" : "rgba(255,255,255,0.82)",
        }}
      >
        <Container size="xl" px={{ base: "sm", sm: "lg" }} py={{ base: 8, sm: 11 }}>
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
              <Box style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, flexShrink: 0 }}>
                {[0, 1, 2, 3].map((i) => (
                  <Box
                    key={i}
                    w={8}
                    h={8}
                    style={{ borderRadius: 2, background: `var(--gh-mark-${i})` }}
                  />
                ))}
              </Box>
              <Box style={{ minWidth: 0 }}>
                <Group gap={7} wrap="nowrap">
                  <Anchor
                    href="/"
                    underline="never"
                    c="inherit"
                    fw={720}
                    style={{ fontSize: "var(--mantine-font-size-sm)", lineHeight: 1.15, letterSpacing: "-0.01em" }}
                  >
                    quanticode
                  </Anchor>
                  <Text size="sm" c="dimmed" lh={1.15}>
                    /
                  </Text>
                  <Text fw={560} size="sm" lh={1.15} truncate>
                    {remoteLabel(meta.remote) || meta.name}
                  </Text>
                </Group>
                <Text size="10px" c="dimmed" lh={1.3} truncate>
                  {meta.branch} · {meta.headShort} · analysed {relativeTime(meta.generatedAt, now)}
                </Text>
              </Box>
            </Group>

            <Group gap={6} wrap="nowrap">
              {!isMobile && (
                <Badge variant="default" size="sm" radius="sm" fw={550}>
                  {formatCompact(stats.lines)} lines
                </Badge>
              )}
              {ghUrl && (
                <Tooltip label="Open on GitHub">
                  <ActionIcon
                    component="a"
                    href={ghUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    variant="subtle"
                    color="gray"
                    aria-label="Open repository on GitHub"
                  >
                    <IconBrandGithub size={17} />
                  </ActionIcon>
                </Tooltip>
              )}
              <Tooltip label={scheme === "dark" ? "Switch to light" : "Switch to dark"}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={toggleColorScheme}
                  aria-label="Toggle colour scheme"
                >
                  {scheme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />}
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
        </Container>
      </Paper>

      <Container size="xl" px={{ base: "sm", sm: "lg" }} py={{ base: "sm", sm: "lg" }}>
        <Stack gap="md">
          {!isMobile && <StatTiles stats={tiles} scheme={scheme} />}
          {!isMobile && controls}

          {isMobile ? (
            <>
              <SegmentedControl
                fullWidth
                size="xs"
                radius="md"
                value={panel}
                onChange={(v) => setPanel(v as MobilePanel)}
                data={[
                  { value: "map", label: "Map" },
                  { value: "areas", label: "Areas" },
                  { value: "files", label: "Files" },
                  { value: "activity", label: "Activity" },
                ]}
              />
              {controls}
              {panel === "map" && mapPanel}
              {(panel === "areas" || panel === "files") && (
                <Paper p="sm" radius="lg">
                  <Stack gap="sm">
                    <Box>
                      <Text fw={660} size="sm">
                        {panel === "areas" ? "Hottest to coldest" : "Every file"}
                      </Text>
                      <Text size="10px" c="dimmed" mt={2}>
                        {panel === "areas" ? `inside ${zoomed.path || "the repository"}` : "ranked across the repository"}
                      </Text>
                    </Box>
                    {panel === "areas" ? (
                      <AreaRanking
                        node={zoomed}
                        scheme={scheme}
                        now={now}
                        maxHeight={600}
                        onZoom={setZoom}
                        onOpenFile={setOpenFile}
                      />
                    ) : (
                      <FileTable
                        files={files}
                        now={now}
                        halfLifeDays={halfLifeDays}
                        metric={metric}
                        scheme={scheme}
                        query={query}
                        onOpenFile={setOpenFile}
                        maxHeight={600}
                      />
                    )}
                  </Stack>
                </Paper>
              )}
              {panel === "activity" && activityPanel}
              <StatTiles stats={tiles} scheme={scheme} compact />
            </>
          ) : (
            <>
              <Grid gap="md" align="stretch">
                <Grid.Col span={{ base: 12, md: 8, lg: 8.5 }}>{mapPanel}</Grid.Col>
                <Grid.Col span={{ base: 12, md: 4, lg: 3.5 }}>{areasPanel}</Grid.Col>
              </Grid>
              {activityPanel}
            </>
          )}

          <Divider opacity={0.5} />
          <Group justify="space-between" gap="xs" pb="lg" wrap="wrap">
            <Text size="10px" c="dimmed">
              {formatNumber(meta.totalLines)} lines blamed across {formatNumber(meta.totalFiles)} files in{" "}
              {(meta.analysisMs / 1000).toFixed(1)}s · HEAD {meta.headShort} on {meta.branch}
            </Text>
            <Text size="10px" c="dimmed">
              heat = 0.5 <sup>age / half-life</sup>, weighted by line
            </Text>
          </Group>
        </Stack>
      </Container>

      <Drawer
        opened={openFile !== null}
        onClose={() => setOpenFile(null)}
        position="right"
        size={isMobile ? "100%" : "62%"}
        padding={0}
        withCloseButton={false}
        styles={{ body: { height: "100%", padding: 0 }, content: { display: "flex", flexDirection: "column" } }}
        transitionProps={{ duration: 180 }}
      >
        {openFile && (
          <FileViewer
            key={openFile}
            path={openFile}
            src={src}
            scheme={scheme}
            now={now}
            halfLifeDays={halfLifeDays}
            metric={metric}
            onClose={() => setOpenFile(null)}
            isMobile={isMobile}
          />
        )}
      </Drawer>
    </Box>
  );
}

/** The hottest child of the folder in view. Directories win over loose files:
 *  the tile is labelled "area", and a single hot 30-line file at the root is not
 *  an area of the codebase. */
function hottestArea(node: TreeNode): TreeNode | null {
  let bestDir: TreeNode | null = null;
  let bestAny: TreeNode | null = null;
  for (const c of node.children) {
    if (!bestAny || c.heat > bestAny.heat) bestAny = c;
    if (c.isDir && (!bestDir || c.heat > bestDir.heat)) bestDir = c;
  }
  return bestDir ?? bestAny;
}

function fmtAge(days: number): string {
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 21) return `${Math.round(days)}d`;
  if (days < 90) return `${Math.round(days / 7)}w`;
  if (days < 550) return `${Math.round(days / 30.44)}mo`;
  return `${(days / 365.25).toFixed(1)}y`;
}
