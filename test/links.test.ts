import { describe, expect, it } from "vitest";
import { artifactUrl } from "../src/files/links.js";

describe("artifactUrl", () => {
  it("joins base, mission id, and relPath", () => {
    expect(
      artifactUrl("https://m.tail.ts.net", "m-20260719-4fa1", "report.md")
    ).toBe("https://m.tail.ts.net/m-20260719-4fa1/report.md");
  });

  it("keeps nested paths as path segments", () => {
    expect(artifactUrl("https://m.tail.ts.net", "m-x", "out/data/plot.png")).toBe(
      "https://m.tail.ts.net/m-x/out/data/plot.png"
    );
  });

  it("returns null when the base URL is unset", () => {
    expect(artifactUrl(undefined, "m-x", "report.md")).toBeNull();
    expect(artifactUrl("", "m-x", "report.md")).toBeNull();
  });

  it("returns null for any .. segment", () => {
    expect(artifactUrl("https://m.tail.ts.net", "m-x", "..")).toBeNull();
    expect(artifactUrl("https://m.tail.ts.net", "m-x", "../secret")).toBeNull();
    expect(artifactUrl("https://m.tail.ts.net", "m-x", "a/../b.md")).toBeNull();
  });

  it("URI-encodes spaces and # in segments", () => {
    expect(
      artifactUrl("https://m.tail.ts.net", "m-x", "out/my report #1.md")
    ).toBe("https://m.tail.ts.net/m-x/out/my%20report%20%231.md");
  });
});
