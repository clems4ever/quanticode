import { describe, expect, it } from "vitest";
import { buildTree, findNode, pathChain, type TreeNode } from "./tree";
import type { FileHeat } from "./api";
import { heatOf } from "./heat";

const DAY = 86400;
const NOW = 1_700_000_000;

/** A file whose lines all share one last-edit time. */
function file(path: string, lines: number, ageDays: number, extra: Partial<FileHeat> = {}): FileHeat {
  const t = NOW - ageDays * DAY;
  return {
    p: path,
    l: lines,
    x: path.split(".").pop() ?? "",
    k: [[t, lines]],
    le: t,
    fe: t,
    nc: 1,
    ta: "Ada",
    na: 1,
    ...extra,
  };
}

const build = (files: FileHeat[], halfLife = 7) =>
  buildTree(files, NOW, halfLife, "average", "repo");

describe("buildTree", () => {
  it("nests files under their directories", () => {
    const root = build([file("src/a.go", 10, 0), file("src/deep/b.go", 10, 0), file("top.md", 5, 0)]);

    expect(root.name).toBe("repo");
    expect(root.path).toBe("");
    expect(root.isDir).toBe(true);
    expect(names(root)).toEqual(["src", "top.md"]);

    const src = root.children.find((c) => c.name === "src")!;
    expect(names(src)).toEqual(["a.go", "deep"]);
    expect(src.children.find((c) => c.name === "deep")!.children[0].path).toBe("src/deep/b.go");
  });

  it("sums lines and counts files up the tree", () => {
    const root = build([file("a/x.go", 30, 0), file("a/b/y.go", 70, 0), file("z.go", 100, 0)]);
    expect(root.lines).toBe(200);
    expect(root.fileCount).toBe(3);

    const a = root.children.find((c) => c.name === "a")!;
    expect(a.lines).toBe(100);
    expect(a.fileCount).toBe(2);
  });

  it("collapses single-child directory chains into one node", () => {
    // internal/brokers/github holding nothing else is one hop, not three.
    const root = build([file("internal/brokers/github/api.go", 10, 0)]);
    expect(root.children).toHaveLength(1);

    const collapsed = root.children[0];
    expect(collapsed.name).toBe("internal/brokers/github");
    expect(collapsed.path).toBe("internal/brokers/github");
    expect(collapsed.children.map((c) => c.name)).toEqual(["api.go"]);
  });

  it("does not collapse a directory that holds more than one entry", () => {
    const root = build([file("internal/a.go", 1, 0), file("internal/sub/b.go", 1, 0)]);
    expect(root.children[0].name).toBe("internal");
  });

  it("sorts children by size, largest first", () => {
    const root = build([file("small.go", 1, 0), file("big.go", 100, 0), file("mid.go", 50, 0)]);
    expect(names(root)).toEqual(["big.go", "mid.go", "small.go"]);
  });

  it("carries the newest descendant edit as the directory's lastEdit", () => {
    const root = build([file("d/old.go", 10, 100), file("d/new.go", 10, 1)]);
    const d = root.children.find((c) => c.name === "d")!;
    expect(d.lastEdit).toBe(NOW - 1 * DAY);
  });

  it("counts distinct surviving edit times as a directory's commits", () => {
    const shared = NOW - 5 * DAY;
    const a: FileHeat = { ...file("d/a.go", 2, 5), k: [[shared, 2]] };
    const b: FileHeat = { ...file("d/b.go", 3, 5), k: [[shared, 3]] };
    const c = file("d/c.go", 1, 9);
    const d = build([a, b, c]).children.find((n) => n.name === "d")!;
    // a and b share one commit; c is a second.
    expect(d.commits).toBe(2);
  });
});

describe("directory heat", () => {
  it("is line-weighted, not an average of child heats", () => {
    // One huge cold file and one tiny hot one: the directory must read cold.
    const root = build([file("d/huge.go", 1000, 365), file("d/tiny.go", 1, 0)]);
    const d = root.children.find((c) => c.name === "d")!;

    const meanOfChildren = (d.children[0].heat + d.children[1].heat) / 2;
    expect(d.heat).toBeLessThan(meanOfChildren);
    expect(d.heat).toBeLessThan(0.01);
  });

  it("equals heatOf over the merged buckets of every descendant", () => {
    const files = [file("d/a.go", 10, 1), file("d/sub/b.go", 90, 30)];
    const d = build(files).children.find((c) => c.name === "d")!;
    const merged = files.flatMap((f) => f.k);
    expect(d.heat).toBeCloseTo(heatOf(merged, NOW, 7, "average"), 12);
  });

  it("rises when the half-life widens", () => {
    const files = [file("d/a.go", 10, 30)];
    const tight = build(files, 1).children[0].heat;
    const loose = build(files, 90).children[0].heat;
    expect(loose).toBeGreaterThan(tight);
  });
});

describe("findNode", () => {
  const root = build([
    file("internal/brokers/github/api.go", 10, 0),
    file("internal/box/box.go", 10, 0),
    file("README.md", 5, 0),
  ]);

  it("returns the root for an empty path", () => {
    expect(findNode(root, "")).toBe(root);
  });

  it("finds a file", () => {
    expect(findNode(root, "internal/box/box.go")?.name).toBe("box.go");
  });

  it("finds a plain directory", () => {
    expect(findNode(root, "internal")?.isDir).toBe(true);
  });

  it("finds a collapsed directory by its full path", () => {
    const node = findNode(root, "internal/brokers/github");
    expect(node?.name).toBe("brokers/github");
    expect(node?.path).toBe("internal/brokers/github");
  });

  it("returns null for a path that is not in the tree", () => {
    expect(findNode(root, "nope")).toBeNull();
    expect(findNode(root, "internal/nope/deep")).toBeNull();
  });

  it("does not match a path that is merely a string prefix of a real one", () => {
    const tree = build([file("internal-tools/a.go", 1, 0)]);
    expect(findNode(tree, "internal")).toBeNull();
  });
});

describe("pathChain", () => {
  const root = build([file("a/b/c/f.go", 10, 0), file("a/other.go", 1, 0), file("a/b/sibling.go", 1, 0)]);

  it("walks from the root down to the target", () => {
    const chain = pathChain(root, "a/b/c");
    expect(chain.map((n) => n.path)).toEqual(["", "a", "a/b", "a/b/c"]);
  });

  it("is just the root for an empty path", () => {
    expect(pathChain(root, "").map((n) => n.path)).toEqual([""]);
  });

  it("stops at the root when the path does not exist", () => {
    expect(pathChain(root, "missing").map((n) => n.path)).toEqual([""]);
  });
});

function names(n: TreeNode): string[] {
  return n.children.map((c) => c.name);
}
