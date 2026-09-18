import { describe, expect, it } from "vitest";
import { remoteLabel, remoteWebUrl } from "./api";

describe("remoteLabel", () => {
  it("reduces a remote to owner/repo", () => {
    expect(remoteLabel("https://github.com/runyard-ai/runyard.git")).toBe("runyard-ai/runyard");
    expect(remoteLabel("https://github.com/runyard-ai/runyard")).toBe("runyard-ai/runyard");
    expect(remoteLabel("git@github.com:clems4ever/quanticode.git")).toBe("clems4ever/quanticode");
    expect(remoteLabel("https://gitlab.com/group/project.git")).toBe("group/project");
  });

  it("passes through anything it cannot parse", () => {
    expect(remoteLabel("")).toBe("");
    expect(remoteLabel("local-only")).toBe("local-only");
  });
});

describe("remoteWebUrl", () => {
  it("builds a browsable URL for GitHub remotes", () => {
    expect(remoteWebUrl("https://github.com/runyard-ai/runyard.git")).toBe(
      "https://github.com/runyard-ai/runyard",
    );
    expect(remoteWebUrl("git@github.com:clems4ever/quanticode.git")).toBe(
      "https://github.com/clems4ever/quanticode",
    );
  });

  it("returns null for non-GitHub or absent remotes", () => {
    expect(remoteWebUrl("https://gitlab.com/group/project.git")).toBeNull();
    expect(remoteWebUrl("")).toBeNull();
  });
});
