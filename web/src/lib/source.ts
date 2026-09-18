/**
 * The URL shape: prepend quanticode to a forge URL and it works.
 *
 *   quanticode.dev/github.com/torvalds/linux
 *
 * The path after the origin *is* the repository, so nothing needs a form, a
 * login or a query string. This module is the browser half of that — the
 * server-side parser in internal/source is the authority, and anything odd is
 * passed through for it to reject rather than being guessed at here.
 */

/** Forges that can appear as the first path segment. */
const HOSTS = ["github.com"];

/** Reads the repository out of a location path, or null for the landing page. */
export function sourceFromPath(pathname: string): string | null {
  const parts = pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (parts.length < 3) return null;
  if (!HOSTS.includes(parts[0].toLowerCase())) return null;
  // Keep only host/owner/name: GitHub's own URLs carry /tree/<branch> and
  // /blob/<branch>/<path> after that, and pasting one should still work.
  return parts.slice(0, 3).join("/");
}

/**
 * Normalises anything a person might paste into the landing page box — a full
 * GitHub URL, an SSH remote, or just "owner/repo" — into the canonical
 * "host/owner/name" path. Returns null when it cannot be read as a repository.
 */
export function parseInput(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;

  s = s.replace(/^git@([^:]+):/, "$1/"); // git@github.com:owner/repo.git
  s = s.replace(/^[a-z]+:\/\//i, ""); // scheme
  s = s.replace(/^www\./i, "");
  s = s.replace(/\.git$/, "");
  s = s.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s) return null;

  const parts = s.split("/").filter(Boolean);
  // "owner/repo" on its own means GitHub, which is what almost everyone types.
  if (parts.length === 2 && !parts[0].includes(".")) return `github.com/${parts[0]}/${parts[1]}`;
  if (parts.length >= 3 && HOSTS.includes(parts[0].toLowerCase())) {
    return `${parts[0].toLowerCase()}/${parts[1]}/${parts[2]}`;
  }
  return null;
}

/** The path a source is browsed at. */
export const pathForSource = (src: string): string => `/${src}`;
