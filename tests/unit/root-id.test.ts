import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeRootPath,
  isLegacyUserRootId,
  isPathUnderRoot,
  rootIdForPath,
} from "../../src/core/sessions/root-registry.js";

describe("rootIdForPath", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("gives different IDs for /home/alice/a and /home/bob/b", () => {
    const alice = rootIdForPath("/home/alice/a");
    const bob = rootIdForPath("/home/bob/b");
    expect(alice).not.toBe(bob);
    expect(alice).toMatch(/^user-[0-9a-f]{32}$/);
    expect(bob).toMatch(/^user-[0-9a-f]{32}$/);
  });

  it("is stable for the same path and uses full-path digest", () => {
    const input = path.resolve("/home/alice/project-a");
    const canonical = canonicalizeRootPath(input);
    const expected = `user-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
    expect(rootIdForPath(input)).toBe(expected);
    expect(rootIdForPath(input)).toBe(rootIdForPath(input));
  });

  it("falls back when path does not exist", () => {
    const missing = path.join(os.tmpdir(), `psr-missing-${Date.now()}`, "nested");
    expect(rootIdForPath(missing)).toMatch(/^user-[0-9a-f]{32}$/);
  });

  it("detects legacy 12-hex user IDs", () => {
    expect(isLegacyUserRootId("user-2f686f6d652f")).toBe(true);
    expect(isLegacyUserRootId(rootIdForPath("/home/alice/a"))).toBe(false);
    expect(isLegacyUserRootId("agent-sessions")).toBe(false);
  });

  it("treats win32 paths case-insensitively when on win32", () => {
    if (process.platform !== "win32") {
      return;
    }
    const upper = rootIdForPath("D:\\Foo\\Bar");
    const lower = rootIdForPath("d:\\foo\\bar");
    expect(upper).toBe(lower);
    expect(isPathUnderRoot("D:\\Foo\\Bar\\session.jsonl", "d:\\foo\\bar")).toBe(true);
  });

  it("uses realpath when the directory exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psr-rootid-"));
    tempDirs.push(dir);
    const id = rootIdForPath(dir);
    const viaReal = rootIdForPath(fs.realpathSync.native(dir));
    expect(id).toBe(viaReal);
  });
});
