import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toSafeToolHits } from "../../src/adapters/pi/format.js";
import { createRuntime, openDbRequired, tryOpenDb } from "../../src/adapters/pi/runtime.js";
import {
  currentProjectKey,
  ensureRuntimeSessionRoot,
  indexSingleFile,
  setupIndex,
} from "../../src/core/indexing/indexer.js";
import { resolveProjectIdentity } from "../../src/core/provenance/project-identity.js";
import { searchChunks } from "../../src/core/retrieval/search.js";
import { closeDatabase } from "../../src/core/store/db.js";
import { getRuntimeConfig } from "../../src/core/store/repository.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesDir = path.join(repoRoot, "tests", "fixtures", "sessions");

describe("P3 manual recall core via extension runtime", () => {
  let dataHome: string;
  let previousHome: string | undefined;
  let openDb: ReturnType<typeof openDbRequired> | null = null;

  beforeEach(() => {
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-p3-"));
    previousHome = process.env.PI_SESSION_RECALL_HOME;
    process.env.PI_SESSION_RECALL_HOME = dataHome;
    openDb = null;
  });

  afterEach(() => {
    if (openDb) {
      try {
        closeDatabase(openDb);
      } catch {
        // ignore
      }
      openDb = null;
    }
    if (previousHome === undefined) {
      delete process.env.PI_SESSION_RECALL_HOME;
    } else {
      process.env.PI_SESSION_RECALL_HOME = previousHome;
    }
    try {
      fs.rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // Windows 偶发文件锁；忽略清理失败
    }
  });

  it("tool-shaped results stay project-scoped and path-free", () => {
    const runtime = createRuntime();
    expect(tryOpenDb(runtime)).toBeNull();

    openDb = openDbRequired(runtime);
    setupIndex(openDb, [{ id: "fixtures", path: fixturesDir, source: "user-added" }]);
    ensureRuntimeSessionRoot(openDb, fixturesDir);

    const child = path.join(fixturesDir, "cross-project-fork-child.jsonl");
    indexSingleFile(openDb, child, { forceFull: true });

    const projectB = resolveProjectIdentity("/tmp/pi-session-recall-fixtures/project-b");
    const projectA = resolveProjectIdentity("/tmp/pi-session-recall-fixtures/project-a");

    const bHits = searchChunks(openDb, "secret topic alpha", {
      scope: "project",
      projectKey: projectB.projectKey,
    });
    // B 搜索不得命中 A 复制历史（scope leakage = 0）
    expect(bHits.hits).toHaveLength(0);

    const aHits = searchChunks(openDb, "secret topic alpha", {
      scope: "project",
      projectKey: projectA.projectKey,
    });
    expect(aHits.hits.length).toBeGreaterThan(0);
    expect(aHits.hits.every((hit) => hit.originProjectKey === projectA.projectKey)).toBe(true);

    const safe = toSafeToolHits(aHits.hits);
    const blob = JSON.stringify(safe);
    expect(blob).not.toMatch(/"path"\s*:/);
    expect(Object.keys(safe[0] ?? {}).sort()).toEqual([
      "entryId",
      "occurredAt",
      "role",
      "sessionId",
      "snippet",
      "truncated",
    ]);

    expect(getRuntimeConfig(openDb).autoRecall).toBe(false);
    expect(currentProjectKey).toBeTypeOf("function");
  });
});
