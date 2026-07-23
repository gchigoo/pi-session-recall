import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIndex, setupIndex } from "../../src/core/indexing/indexer.js";
import { serializeSessionFixture } from "../../src/core/sessions/fixture-builder.js";
import { closeDatabase, openDatabase } from "../../src/core/store/db.js";
import {
  excludeSession,
  getRuntimeConfig,
  listSessionRoots,
  updateRuntimeConfig,
} from "../../src/core/store/repository.js";

describe("config / roots / exclusions upgrade compatibility", () => {
  let dataHome: string;
  let rootDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-upg-"));
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

  it("reopen migrates projection_status and keeps roots/exclusions/config", () => {
    const sid = "99999999-9999-9999-9999-999999999999";
    fs.writeFileSync(
      path.join(rootDir, "s.jsonl"),
      serializeSessionFixture({
        name: "s",
        header: { id: sid, cwd: "/tmp/pi-session-recall-fixtures/project-a" },
        entries: [{ id: "u1u1u1u1", parentId: null, role: "user", text: "upgrade-keep-term" }],
      }),
      "utf8",
    );

    let db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "r1", path: rootDir, source: "user-added" }]);
    runIndex(db);
    updateRuntimeConfig(db, { autoRecall: true });
    excludeSession(db, sid);
    const versionBefore = getRuntimeConfig(db).configVersion;
    closeDatabase(db);

    db = openDatabase({ dataHome });
    const config = getRuntimeConfig(db);
    expect(config.projectionStatus).toBe("ready");
    expect(config.autoRecall).toBe(true);
    expect(config.configVersion).toBeGreaterThanOrEqual(versionBefore);
    expect(listSessionRoots(db).some((root) => root.id === "r1")).toBe(true);
    // excluded 不复活
    const indexed = runIndex(db);
    expect(indexed.skippedExcluded).toBeGreaterThan(0);
    closeDatabase(db);
  });
});
