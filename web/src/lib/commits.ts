import type { Commit, FileHeat } from "./api";
import type { TreeNode } from "./tree";

/**
 * Finding the commit behind a file or a folder.
 *
 * The repo payload keys commits by full sha, while a file carries only the
 * short one — forty hex characters per file is 130 KB on a repository the size
 * of authelia, for something the payload already contains. So the lookup goes
 * through an index built from the commit map.
 *
 * The index is memoised on the map itself rather than rebuilt per call. It is
 * consulted on every pointer move across the treemap and once per row of the
 * rankings, and rebuilding it over three thousand commits in a hover handler is
 * exactly the kind of work that makes an interface feel heavy for no reason.
 */
let cache: { src: Record<string, Commit>; index: Record<string, Commit> } | null = null;

export function shortIndex(commits: Record<string, Commit>): Record<string, Commit> {
  if (cache?.src === commits) return cache.index;
  const index: Record<string, Commit> = {};
  for (const c of Object.values(commits)) index[c.short] = c;
  cache = { src: commits, index };
  return index;
}

/** The commit behind a node's most recent change, if the payload carries it. */
export function commitOf(
  node: Pick<TreeNode, "lastCommit">,
  commits: Record<string, Commit>,
): Commit | undefined {
  return node.lastCommit ? shortIndex(commits)[node.lastCommit] : undefined;
}

/** The commit behind a file's most recent change. */
export function commitOfFile(
  file: Pick<FileHeat, "lc">,
  commits: Record<string, Commit>,
): Commit | undefined {
  return file.lc ? shortIndex(commits)[file.lc] : undefined;
}
