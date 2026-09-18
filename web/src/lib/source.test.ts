import { describe, expect, it } from "vitest";
import { parseInput, pathForSource, sourceFromPath } from "./source";

describe("sourceFromPath", () => {
  it("reads the repository out of the path", () => {
    expect(sourceFromPath("/github.com/torvalds/linux")).toBe("github.com/torvalds/linux");
    expect(sourceFromPath("/github.com/torvalds/linux/")).toBe("github.com/torvalds/linux");
  });

  it("drops the extra segments a GitHub URL carries", () => {
    expect(sourceFromPath("/github.com/torvalds/linux/tree/master")).toBe(
      "github.com/torvalds/linux",
    );
    expect(sourceFromPath("/github.com/torvalds/linux/blob/master/Makefile")).toBe(
      "github.com/torvalds/linux",
    );
  });

  it("is null for anything that is not a repository path", () => {
    expect(sourceFromPath("/")).toBeNull();
    expect(sourceFromPath("")).toBeNull();
    expect(sourceFromPath("/github.com")).toBeNull();
    expect(sourceFromPath("/github.com/torvalds")).toBeNull();
    expect(sourceFromPath("/gitlab.com/gitlab-org/gitlab")).toBeNull();
    expect(sourceFromPath("/assets/index-abc.js")).toBeNull();
  });
});

describe("parseInput", () => {
  it("takes whatever a person pastes", () => {
    const want = "github.com/torvalds/linux";
    for (const input of [
      "github.com/torvalds/linux",
      "https://github.com/torvalds/linux",
      "http://github.com/torvalds/linux",
      "https://www.github.com/torvalds/linux",
      "https://github.com/torvalds/linux.git",
      "https://github.com/torvalds/linux/tree/master",
      "git@github.com:torvalds/linux.git",
      "  github.com/torvalds/linux/  ",
      "torvalds/linux",
    ]) {
      expect(parseInput(input), input).toBe(want);
    }
  });

  it("rejects what is not a repository", () => {
    expect(parseInput("")).toBeNull();
    expect(parseInput("   ")).toBeNull();
    expect(parseInput("linux")).toBeNull();
    expect(parseInput("https://gitlab.com/gitlab-org/gitlab")).toBeNull();
    expect(parseInput("https://example.com")).toBeNull();
  });
});

describe("pathForSource", () => {
  it("round-trips with sourceFromPath", () => {
    const src = "github.com/clems4ever/quanticode";
    expect(sourceFromPath(pathForSource(src))).toBe(src);
  });
});
