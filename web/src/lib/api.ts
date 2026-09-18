import type { Bucket } from "./heat";

export interface Commit {
  sha: string;
  short: string;
  author: string;
  email: string;
  time: number;
  summary: string;
}

/** Per-file aggregate. Keys are short because one ships per file in the repo payload. */
export interface FileHeat {
  p: string;   // path
  l: number;   // lines
  x: string;   // extension
  k: Bucket[]; // [lastEditTime, lineCount][]
  le: number;  // last edit
  fe: number;  // first edit
  nc: number;  // distinct commits
  ta: string;  // top author
  na: number;  // distinct authors
  g?: boolean; // generated
}

export interface AuthorStat {
  name: string;
  email: string;
  lines: number;
  commits: number;
  lastEdit: number;
}

export interface DayStat {
  d: string;
  c: number;
  a: number;
  r: number;
}

export interface RepoMeta {
  name: string;
  slug: string;
  remote: string;
  branch: string;
  head: string;
  headShort: string;
  commitCount: number;
  firstCommit: number;
  lastCommit: number;
  totalFiles: number;
  totalLines: number;
  generatedAt: number;
  analysisMs: number;
}

export interface RepoPayload {
  meta: RepoMeta;
  files: FileHeat[];
  authors: AuthorStat[];
  timeline: DayStat[];
  commits: Record<string, Commit>;
}

export interface FileLine {
  t: string;
  c: string;
}

export interface FilePayload {
  path: string;
  lines: FileLine[];
  commits: Record<string, Commit>;
  ext: string;
}

/** How far an on-demand index has got. Mirrors index.Status on the server. */
export interface IndexStatus {
  source: string;
  label: string;
  state: "queued" | "cloning" | "fetching" | "analysing" | "ready" | "failed";
  error?: string;
  position?: number;
  files?: number;
  since?: number;
  indexedAt?: number;
  refreshing?: boolean;
}

/** The bounds this deployment enforces, so the page can state them up front. */
export interface Limits {
  maxRepoMB: number;
  maxFiles: number;
  refreshHours: number;
}

/** What this deployment can do, read once at startup. */
export interface Instance {
  indexing: boolean;
  hosts?: string[];
  limits?: Limits;
  repos: { slug: string; name: string; primary: boolean }[];
}

/**
 * A repository request either comes back analysed, or comes back as progress.
 * The two are told apart by status code, never by the shape of the body:
 * 200 is the analysis, 202 is work in flight, 422 is an index that failed.
 */
export type RepoResult =
  | { kind: "ready"; data: RepoPayload }
  | { kind: "indexing"; status: IndexStatus };

/** Query string selecting the repository: a remote source, or nothing. */
function scope(src: string | null): string {
  return src ? `src=${encodeURIComponent(src)}` : "";
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const fetchInstance = () => getJSON<Instance>("/api/instance");

export async function fetchRepo(src: string | null): Promise<RepoResult> {
  const res = await fetch(`/api/repo?${scope(src)}`);
  if (res.status === 202 || res.status === 422) {
    return { kind: "indexing", status: (await res.json()) as IndexStatus };
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return { kind: "ready", data: (await res.json()) as RepoPayload };
}

/** Polls progress without causing any work, so it is safe on a short interval. */
export const fetchStatus = (src: string) =>
  getJSON<IndexStatus>(`/api/status?src=${encodeURIComponent(src)}`);

export const fetchFile = (path: string, src: string | null = null) =>
  getJSON<FilePayload>(`/api/file?path=${encodeURIComponent(path)}&${scope(src)}`);

/** Strip a GitHub remote down to "owner/repo" for display. */
export function remoteLabel(remote: string): string {
  const m = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : remote;
}

export function remoteWebUrl(remote: string): string | null {
  const m = remote.match(/github\.com[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}` : null;
}
