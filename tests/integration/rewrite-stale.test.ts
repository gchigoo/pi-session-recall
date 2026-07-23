import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIndex, setupIndex } from "../../src/core/indexing/indexer.js";
import { searchChunks } from "../../src/core/retrieval/search.js";
import { closeDatabase, openDatabase } from "../../src/core/store/db.js";
import { serializeSessionFixture } from "../../src/core/sessions/fixture-builder.js";

describe("rewrite removes stale results", () => {
  let dataHome: string;
  let rootDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-rewrite-"));
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
    fs.rmSync(dataHome, { recursive: true, force: true });
  });

  it("does not return rewritten-away text", () => {
    const filePath = path.join(rootDir, "s.jsonl");
    fs.writeFileSync(
      filePath,
      serializeSessionFixture({
        name: "s",
        header: {
          id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          cwd: "/tmp/pi-session-recall-fixtures/project-a",
        },
        entries: [{ id: "e1e1e1e1", parentId: null, role: "user", text: "unique-alpha-term" }],
      }),
      "utf8",
    );

    const db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "r1", path: rootDir, source: "user-added" }]);
    runIndex(db);
    expect(searchChunks(db, "unique-alpha-term", { scope: "all" }).hits.length).toBeGreaterThan(0);

    fs.writeFileSync(
      filePath,
      serializeSessionFixture({
        name: "s",
        header: {
          id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          cwd: "/tmp/pi-session-recall-fixtures/project-a",
        },
        entries: [{ id: "e1e1e1e1", parentId: null, role: "user", text: "unique-beta-term" }],
      }),
      "utf8",
    );
    runIndex(db);

    expect(searchChunks(db, "unique-alpha-term", { scope: "all" }).hits).toHaveLength(0);
    expect(searchChunks(db, "unique-beta-term", { scope: "all" }).hits.length).toBeGreaterThan(0);
    closeDatabase(db);
  });
});
