import type { FileHeat } from "./api";
import { heatOf, type Bucket, type HeatMetric } from "./heat";

/**
 * A node in the repository tree. Directories aggregate their descendants, so a
 * directory's heat is the line-weighted heat of everything inside it — which is
 * what makes a whole area of the repo read as hot or cold at a glance.
 */
export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  lines: number;
  heat: number;
  lastEdit: number;
  commits: number;
  fileCount: number;
  children: TreeNode[];
  file?: FileHeat;
}

interface Building {
  name: string;
  path: string;
  isDir: boolean;
  children: Map<string, Building>;
  file?: FileHeat;
}

/**
 * Build the directory tree and compute heat for every node.
 *
 * Directory heat is recomputed from the merged buckets of its descendants
 * rather than averaged from child heats, so a directory of one huge cold file
 * and one tiny hot file lands where its line count says it should.
 */
export function buildTree(
  files: FileHeat[],
  now: number,
  halfLifeDays: number,
  metric: HeatMetric,
  rootName: string,
): TreeNode {
  const root: Building = { name: rootName, path: "", isDir: true, children: new Map() };

  for (const f of files) {
    const parts = f.p.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const name = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      let next = node.children.get(name);
      if (!next) {
        next = { name, path, isDir: !isLeaf, children: new Map(), file: isLeaf ? f : undefined };
        node.children.set(name, next);
      }
      node = next;
    }
  }

  return finalise(collapse(root), now, halfLifeDays, metric);
}

/**
 * Collapse single-child directory chains ("internal/brokers/falbroker" when each
 * level holds nothing else) into one node. Without this the treemap spends its
 * padding budget on nesting that carries no information.
 */
function collapse(node: Building): Building {
  const children = [...node.children.values()].map(collapse);
  node.children = new Map(children.map((c) => [c.name, c]));
  if (node.path !== "" && node.isDir && children.length === 1 && children[0].isDir) {
    const only = children[0];
    return { ...only, name: `${node.name}/${only.name}` };
  }
  return node;
}

function finalise(node: Building, now: number, halfLife: number, metric: HeatMetric): TreeNode {
  if (!node.isDir && node.file) {
    const f = node.file;
    return {
      name: node.name,
      path: node.path,
      isDir: false,
      lines: f.l,
      heat: heatOf(f.k, now, halfLife, metric),
      lastEdit: f.le,
      commits: f.nc,
      fileCount: 1,
      children: [],
      file: f,
    };
  }

  const children = [...node.children.values()]
    .map((c) => finalise(c, now, halfLife, metric))
    .sort((a, b) => b.lines - a.lines);

  const buckets: Bucket[] = [];
  let lines = 0;
  let lastEdit = 0;
  let fileCount = 0;
  const editTimes = new Set<number>();

  const walk = (n: TreeNode) => {
    if (!n.isDir && n.file) {
      buckets.push(...n.file.k);
      for (const [t] of n.file.k) editTimes.add(t);
      fileCount++;
    }
    if (n.lastEdit > lastEdit) lastEdit = n.lastEdit;
    n.children.forEach(walk);
  };
  children.forEach(walk);
  for (const c of children) lines += c.lines;

  return {
    name: node.name,
    path: node.path,
    isDir: true,
    lines,
    heat: heatOf(buckets, now, halfLife, metric),
    lastEdit,
    // Distinct commit timestamps still surviving in this subtree — the number
    // of separate changes whose lines are still present, not total commits.
    commits: editTimes.size,
    fileCount,
    children,
  };
}

/** Find a node by path, for treemap zoom. Paths of collapsed chains are exact,
 * so a depth-first scan is both simpler and more robust than walking segments. */
export function findNode(root: TreeNode, path: string): TreeNode | null {
  if (path === "" || path === root.path) return root;
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.path === path) return n;
    // Only descend where the target could live.
    for (const c of n.children) {
      if (path === c.path || path.startsWith(c.path + "/") || c.path.startsWith(path + "/")) {
        stack.push(c);
      }
    }
  }
  return null;
}

/**
 * The chain of ancestors from the root down to `path`, for breadcrumbs.
 * An unknown path yields just the root rather than an empty chain, so the
 * breadcrumb never disappears.
 */
export function pathChain(root: TreeNode, path: string): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode): boolean => {
    out.push(n);
    if (n.path === path) return true;
    for (const c of n.children) {
      if (path === c.path || path.startsWith(c.path + "/")) {
        if (walk(c)) return true;
      }
    }
    out.pop();
    return false;
  };
  if (!walk(root)) return [root];
  return out;
}
