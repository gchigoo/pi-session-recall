import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoRetrieve } from "../../src/core/injection/auto-retrieve.js";
import { runIndex, setupIndex } from "../../src/core/indexing/indexer.js";
import { serializeSessionFixture } from "../../src/core/sessions/fixture-builder.js";
import { searchChunks } from "../../src/core/retrieval/search.js";
import { closeDatabase, openDatabase } from "../../src/core/store/db.js";
import {
  beginSessionReconcile,
  getSession,
  updateRuntimeConfig,
} from "../../src/core/store/repository.js";

describe("P5 session lifecycle reconcile", () => {
  let dataHome: string;
  let rootDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-life-"));
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

  it("delete clears hits and marks session deleted", () => {
    const filePath = path.join(rootDir, "del.jsonl");
    fs.writeFileSync(
      filePath,
      serializeSessionFixture({
        name: "del",
        header: {
          id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          cwd: "/tmp/pi-session-recall-fixtures/project-a",
        },
        entries: [{ id: "d1d1d1d1", parentId: null, role: "user", text: "delete-me-term" }],
      }),
      "utf8",
    );
    const db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "r1", path: rootDir, source: "user-added" }]);
    runIndex(db);
    expect(searchChunks(db, "delete-me-term", { scope: "all" }).hits.length).toBeGreaterThan(0);

    fs.rmSync(filePath);
    runIndex(db);
    expect(searchChunks(db, "delete-me-term", { scope: "all" }).hits).toHaveLength(0);
    expect(getSession(db, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")?.status).toBe("deleted");
    closeDatabase(db);
  });

  it("truncate/rewrite remove stale; staging disables autoEligible", () => {
    const filePath = path.join(rootDir, "rw.jsonl");
    const sid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    fs.writeFileSync(
      filePath,
      serializeSessionFixture({
        name: "rw",
        header: { id: sid, cwd: "/tmp/pi-session-recall-fixtures/project-a" },
        entries: [{ id: "r1r1r1r1", parentId: null, role: "user", text: "stale-term-zzz" }],
      }),
      "utf8",
    );
    const db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "r1", path: rootDir, source: "user-added" }]);
    runIndex(db);
    updateRuntimeConfig(db, { autoRecall: true });

    beginSessionReconcile(db, sid);
    const mid = autoRetrieve(db, {
      prompt: "stale-term-zzz",
      cwd: "/tmp/pi-session-recall-fixtures/project-a",
      currentSessionId: "other",
      requestId: "req-mid",
    });
    expect(mid.bundle).toBeNull();

    fs.writeFileSync(
      filePath,
      serializeSessionFixture({
        name: "rw",
        header: { id: sid, cwd: "/tmp/pi-session-recall-fixtures/project-a" },
        entries: [{ id: "r1r1r1r1", parentId: null, role: "user", text: "fresh-term-yyy" }],
      }),
      "utf8",
    );
    runIndex(db);
    expect(searchChunks(db, "stale-term-zzz", { scope: "all" }).hits).toHaveLength(0);
    expect(searchChunks(db, "fresh-term-yyy", { scope: "all" }).hits.length).toBeGreaterThan(0);
    closeDatabase(db);
  });

  it("move path keeps same session_id and search hits", () => {
    const sid = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const a = path.join(rootDir, "a.jsonl");
    fs.writeFileSync(
      a,
      serializeSessionFixture({
        name: "a",
        header: { id: sid, cwd: "/tmp/pi-session-recall-fixtures/project-a" },
        entries: [{ id: "m1m1m1m1", parentId: null, role: "user", text: "moved-session-term" }],
      }),
      "utf8",
    );
    const db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "r1", path: rootDir, source: "user-added" }]);
    runIndex(db);

    const b = path.join(rootDir, "b.jsonl");
    fs.renameSync(a, b);
    runIndex(db);

    const session = getSession(db, sid);
    expect(session?.filePath).toBe(path.resolve(b));
    expect(session?.status).toBe("active");
    expect(searchChunks(db, "moved-session-term", { scope: "all" }).hits.length).toBeGreaterThan(0);
    closeDatabase(db);
  });
});
