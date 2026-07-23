import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/adapters/cli/main.js";
import { resolveProjectIdentity } from "../../src/core/provenance/project-identity.js";
import { closeDatabase, openDatabase } from "../../src/core/store/db.js";
import { countChunks, getRuntimeConfig } from "../../src/core/store/repository.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesDir = path.join(repoRoot, "tests", "fixtures", "sessions");

describe("P2 CLI index/search loop", () => {
  let dataHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-p2-"));
    previousHome = process.env.PI_SESSION_RECALL_HOME;
    process.env.PI_SESSION_RECALL_HOME = dataHome;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.PI_SESSION_RECALL_HOME;
    } else {
      process.env.PI_SESSION_RECALL_HOME = previousHome;
    }
    fs.rmSync(dataHome, { recursive: true, force: true });
  });

  it("setup → index → search → exclude/rebuild → purge-index", async () => {
    const log = captureConsole();

    expect(await runCli(["node", "cli", "setup", "--root", fixturesDir])).toBe(0);
    expect(await runCli(["node", "cli", "index"])).toBe(0);

    const db1 = openDatabase({ dataHome });
    const firstCount = countChunks(db1);
    closeDatabase(db1);
    expect(firstCount).toBeGreaterThan(0);

    // 重复 index 幂等
    expect(await runCli(["node", "cli", "index"])).toBe(0);
    const db2 = openDatabase({ dataHome });
    expect(countChunks(db2)).toBe(firstCount);
    closeDatabase(db2);

    // 跨项目内容：用 --scope all 能搜到 project A secret
    log.clear();
    expect(
      await runCli(["node", "cli", "search", "project A secret", "--scope", "all", "--json"]),
    ).toBe(0);
    expect(log.stdout.join("\n")).toContain("project A secret");

    // current project scope：fixture cwd 不在本仓库，默认 project 应无泄漏要求用 all
    const projectA = resolveProjectIdentity("/tmp/pi-session-recall-fixtures/project-a");
    log.clear();
    // 通过直接 repository search 验证 SQL scope（CLI 用 cwd）
    const { searchChunks } = await import("../../src/core/retrieval/search.js");
    const db3 = openDatabase({ dataHome });
    const scoped = searchChunks(db3, "secret topic alpha", {
      scope: "project",
      projectKey: projectA.projectKey,
    });
    expect(scoped.hits.length).toBeGreaterThan(0);
    expect(scoped.hits.every((hit) => hit.originProjectKey === projectA.projectKey)).toBe(true);
    const other = searchChunks(db3, "secret topic alpha", {
      scope: "project",
      projectKey: "not-a-real-project-key",
    });
    expect(other.hits).toHaveLength(0);
    closeDatabase(db3);

    // exclude + rebuild 不复活
    expect(
      await runCli(["node", "cli", "exclude-session", "11111111-1111-1111-1111-111111111111"]),
    ).toBe(0);
    expect(await runCli(["node", "cli", "rebuild"])).toBe(0);
    log.clear();
    expect(
      await runCli(["node", "cli", "search", "authentication", "--scope", "all", "--json"]),
    ).toBe(0);
    expect(log.stdout.join("\n")).not.toContain("11111111-1111-1111-1111-111111111111");

    // purge-index 后 indexing/auto 关闭
    expect(await runCli(["node", "cli", "purge-index"])).toBe(0);
    const db4 = openDatabase({ dataHome });
    const config = getRuntimeConfig(db4);
    expect(config.indexingEnabled).toBe(false);
    expect(config.autoRecall).toBe(false);
    expect(countChunks(db4)).toBe(0);
    closeDatabase(db4);

    expect(await runCli(["node", "cli", "index"])).toBe(1);

    log.restore();
  });
});

/**
 * 捕获 console 输出。
 */
function captureConsole(): {
  stdout: string[];
  clear: () => void;
  restore: () => void;
} {
  const stdout: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };
  return {
    stdout,
    clear: () => {
      stdout.length = 0;
    },
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}
