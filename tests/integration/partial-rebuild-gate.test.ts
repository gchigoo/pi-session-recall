import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoRetrieve } from "../../src/core/injection/auto-retrieve.js";
import { runIndex, setupIndex } from "../../src/core/indexing/indexer.js";
import { serializeSessionFixture } from "../../src/core/sessions/fixture-builder.js";
import { closeDatabase, isProjectionAvailable, openDatabase } from "../../src/core/store/db.js";
import {
  checkProjectionIntegrity,
  markPartialRebuild,
  setProjectionStatus,
} from "../../src/core/store/projection.js";
import { getRuntimeConfig, updateRuntimeConfig } from "../../src/core/store/repository.js";

describe("partial rebuild / projection gate", () => {
  let dataHome: string;
  let rootDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-partial-"));
    rootDir = path.join(dataHome, "sessions");
    fs.mkdirSync(rootDir, { recursive: true });
    previousHome = process.env.PI_SESSION_RECALL_HOME;
    process.env.PI_SESSION_RECALL_HOME = dataHome;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.PI_SESSION_RECALL_HOME;
    } else {
      process.env.PI_SESSION_RECALL_HOME = previousHome;
    }
    try {
      fs.rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("partial rebuild disables auto recall", () => {
    fs.writeFileSync(
      path.join(rootDir, "s.jsonl"),
      serializeSessionFixture({
        name: "s",
        header: {
          id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
          cwd: "/tmp/pi-session-recall-fixtures/project-a",
        },
        entries: [{ id: "p1p1p1p1", parentId: null, role: "user", text: "partial-gate-term" }],
      }),
      "utf8",
    );
    const db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "r1", path: rootDir, source: "user-added" }]);
    runIndex(db);
    updateRuntimeConfig(db, { autoRecall: true });

    markPartialRebuild(db);
    expect(getRuntimeConfig(db).autoRecall).toBe(false);
    expect(getRuntimeConfig(db).projectionStatus).toBe("partial");
    expect(isProjectionAvailable(db)).toBe(false);

    const retrieved = autoRetrieve(db, {
      prompt: "partial-gate-term",
      cwd: "/tmp/pi-session-recall-fixtures/project-a",
      currentSessionId: "other",
      requestId: "r1",
    });
    expect(retrieved.bundle).toBeNull();
    expect(retrieved.reason).toBe("auto-off");
    closeDatabase(db);
  });

  it("FTS count mismatch marks degraded and blocks projection", () => {
    fs.writeFileSync(
      path.join(rootDir, "s.jsonl"),
      serializeSessionFixture({
        name: "s",
        header: {
          id: "11111111-2222-3333-4444-555555555555",
          cwd: "/tmp/pi-session-recall-fixtures/project-a",
        },
        entries: [{ id: "f1f1f1f1", parentId: null, role: "user", text: "fts-corrupt-term" }],
      }),
      "utf8",
    );
    const db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "r1", path: rootDir, source: "user-added" }]);
    runIndex(db);
    db.exec(`DELETE FROM chunks_fts`);
    expect(isProjectionAvailable(db)).toBe(false);
    const check = checkProjectionIntegrity(db);
    expect(check.ok).toBe(false);
    setProjectionStatus(db, "degraded");
    expect(getRuntimeConfig(db).autoRecall).toBe(false);
    closeDatabase(db);
  });
});
