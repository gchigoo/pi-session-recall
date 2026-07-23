import { describe, expect, it } from "vitest";
import {
  hashProjectKey,
  normalizeRootPath,
  resolveProjectIdentity,
} from "../../src/core/provenance/project-identity.js";

describe("ProjectIdentity", () => {
  it("normalizes separators and trailing slash", () => {
    expect(normalizeRootPath("C:\\Foo\\Bar\\")).toBe("c:/Foo/Bar");
    expect(normalizeRootPath("/tmp/project/")).toBe("/tmp/project");
  });

  it("hashes stable project keys", () => {
    const a = hashProjectKey("cwd", "/tmp/a");
    const b = hashProjectKey("cwd", "/tmp/a");
    const c = hashProjectKey("cwd", "/tmp/b");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("prefers git root when present", () => {
    const existsSync = (candidate: string) => {
      const normalized = candidate.replaceAll("\\", "/");
      return normalized === "/repo/.git" || normalized.endsWith("/repo/.git");
    };
    const identity = resolveProjectIdentity("/repo/packages/app", existsSync);
    expect(identity.kind).toBe("git");
    expect(identity.normalizedRoot.replaceAll("\\", "/")).toBe("/repo");
  });
});
