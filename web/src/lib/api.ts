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

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const fetchRepo = () => getJSON<RepoPayload>("/api/repo");

export const fetchFile = (path: string) =>
  getJSON<FilePayload>(`/api/file?path=${encodeURIComponent(path)}`);

/** Strip a GitHub remote down to "owner/repo" for display. */
export function remoteLabel(remote: string): string {
  const m = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : remote;
}

export function remoteWebUrl(remote: string): string | null {
  const m = remote.match(/github\.com[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}` : null;
}
