import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildIndex, runIndex, setupIndex } from "../../src/core/indexing/indexer.js";
import {
  isLeaseHeld,
  releaseRebuildLease,
  tryAcquireRebuildLease,
} from "../../src/core/indexing/lease.js";
import { serializeSessionFixture } from "../../src/core/sessions/fixture-builder.js";
import { closeDatabase, openDatabase } from "../../src/core/store/db.js";
import { ERROR_CODES } from "../../src/core/diagnostics/error-codes.js";

describe("rebuild lease", () => {
  let dataHome: string;
  let rootDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-lease-"));
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

  it("second acquire fails while lease held", () => {
    const db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "r1", path: rootDir, source: "user-added" }]);
    const lease = tryAcquireRebuildLease(db, "holder-a");
    expect(isLeaseHeld(db)).toBe(true);
    expect(() => tryAcquireRebuildLease(db, "holder-b")).toThrow(ERROR_CODES.LEASE_HELD);
    releaseRebuildLease(db, lease.holder);
    const next = tryAcquireRebuildLease(db, "holder-b");
    expect(next.holder).toBe("holder-b");
    releaseRebuildLease(db, next.holder);
    closeDatabase(db);
  });

  it("rebuild completes and clears lease", () => {
    fs.writeFileSync(
      path.join(rootDir, "s.jsonl"),
      serializeSessionFixture({
        name: "s",
        header: {
          id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
          cwd: "/tmp/pi-session-recall-fixtures/project-a",
        },
        entries: [{ id: "x1x1x1x1", parentId: null, role: "user", text: "lease-rebuild-term" }],
      }),
      "utf8",
    );
    const db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "r1", path: rootDir, source: "user-added" }]);
    runIndex(db);
    const result = rebuildIndex(db);
    expect(result.indexedSessions).toBeGreaterThan(0);
    expect(isLeaseHeld(db)).toBe(false);
    closeDatabase(db);
  });
});
