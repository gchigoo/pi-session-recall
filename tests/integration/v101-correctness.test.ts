import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIndex, setupIndex } from "../../src/core/indexing/indexer.js";
import { resolveProjectIdentity } from "../../src/core/provenance/project-identity.js";
import { searchChunks } from "../../src/core/retrieval/search.js";
import { cjkBigrams } from "../../src/core/retrieval/cjk-terms.js";
import { serializeSessionFixture } from "../../src/core/sessions/fixture-builder.js";
import { isLegacyUserRootId, rootIdForPath } from "../../src/core/sessions/root-registry.js";
import { closeDatabase, openDatabase } from "../../src/core/store/db.js";
import { resolveDbPath } from "../../src/core/store/paths.js";
import {
  beginSessionReconcile,
  getRuntimeConfig,
  getSession,
  listSessionRoots,
  upsertSessionRoot,
} from "../../src/core/store/repository.js";

describe("v1.0.1 correctness fixes", () => {
  let dataHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-v101-"));
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

  it("migrates legacy user root IDs and keeps session association", () => {
    const rootDir = path.join(dataHome, "sessions");
    fs.mkdirSync(rootDir, { recursive: true });
    const sid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    fs.writeFileSync(
      path.join(rootDir, "one.jsonl"),
      serializeSessionFixture({
        name: "one",
        header: { id: sid, cwd: "/tmp/pi-session-recall-fixtures/project-a" },
        entries: [{ id: "a1a1a1a1", parentId: null, role: "user", text: "migrate-root-term" }],
      }),
      "utf8",
    );

    let db = openDatabase({ dataHome });
    const legacyId = `user-${Buffer.from(path.resolve(rootDir)).toString("hex").slice(0, 12)}`;
    expect(isLegacyUserRootId(legacyId)).toBe(true);
    setupIndex(db, [{ id: legacyId, path: rootDir, source: "user-added" }]);
    runIndex(db);
    expect(getSession(db, sid)?.rootId).toBe(legacyId);
    closeDatabase(db);

    db = openDatabase({ dataHome });
    const roots = listSessionRoots(db);
    expect(roots).toHaveLength(1);
    expect(isLegacyUserRootId(roots[0]!.id)).toBe(false);
    expect(roots[0]!.id).toBe(rootIdForPath(rootDir));
    expect(getSession(db, sid)?.rootId).toBe(roots[0]!.id);
    expect(searchChunks(db, "migrate-root-term", { scope: "all" }).hits.length).toBeGreaterThan(0);
    closeDatabase(db);
  });

  it("index --root A does not delete sessions under root B", () => {
    const rootA = path.join(dataHome, "root-a");
    const rootB = path.join(dataHome, "root-b");
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    const sidA = "11111111-1111-4111-8111-111111111111";
    const sidB = "22222222-2222-4222-8222-222222222222";
    fs.writeFileSync(
      path.join(rootA, "a.jsonl"),
      serializeSessionFixture({
        name: "a",
        header: { id: sidA, cwd: "/tmp/pi-session-recall-fixtures/project-a" },
        entries: [{ id: "b1b1b1b1", parentId: null, role: "user", text: "root-a-unique-term" }],
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(rootB, "b.jsonl"),
      serializeSessionFixture({
        name: "b",
        header: { id: sidB, cwd: "/tmp/pi-session-recall-fixtures/project-a" },
        entries: [{ id: "c1c1c1c1", parentId: null, role: "user", text: "root-b-unique-term" }],
      }),
      "utf8",
    );

    const db = openDatabase({ dataHome });
    setupIndex(db, [
      { id: "root-a", path: rootA, source: "user-added" },
      { id: "root-b", path: rootB, source: "user-added" },
    ]);
    runIndex(db);
    expect(getSession(db, sidA)?.status).toBe("active");
    expect(getSession(db, sidB)?.status).toBe("active");

    fs.rmSync(path.join(rootA, "a.jsonl"));
    runIndex(db, { rootPath: rootA });

    expect(getSession(db, sidA)?.status).toBe("deleted");
    expect(getSession(db, sidB)?.status).toBe("active");
    expect(searchChunks(db, "root-b-unique-term", { scope: "all" }).hits.length).toBeGreaterThan(0);
    closeDatabase(db);
  });

  it("index --root missing path does not wipe other roots", () => {
    const rootA = path.join(dataHome, "keep");
    fs.mkdirSync(rootA, { recursive: true });
    const sid = "33333333-3333-4333-8333-333333333333";
    fs.writeFileSync(
      path.join(rootA, "keep.jsonl"),
      serializeSessionFixture({
        name: "keep",
        header: { id: sid, cwd: "/tmp/pi-session-recall-fixtures/project-a" },
        entries: [{ id: "d1d1d1d1", parentId: null, role: "user", text: "keep-alive-term" }],
      }),
      "utf8",
    );
    const db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "root-a", path: rootA, source: "user-added" }]);
    runIndex(db);

    const missing = path.join(dataHome, "does-not-exist-yet");
    runIndex(db, { rootPath: missing });

    expect(getSession(db, sid)?.status).toBe("active");
    expect(searchChunks(db, "keep-alive-term", { scope: "all" }).hits.length).toBeGreaterThan(0);
    const roots = listSessionRoots(db);
    expect(roots.some((root) => root.id === rootIdForPath(missing))).toBe(true);
    closeDatabase(db);
  });

  it("project filter before FTS limit keeps local hit under foreign flood", () => {
    const rootDir = path.join(dataHome, "sessions");
    fs.mkdirSync(rootDir, { recursive: true });
    const localCwd = "/tmp/pi-session-recall-fixtures/project-a";
    const foreignCwd = "/tmp/pi-session-recall-fixtures/project-b";
    const localKey = resolveProjectIdentity(localCwd).projectKey;
    const foreignKey = resolveProjectIdentity(foreignCwd).projectKey;
    expect(localKey).not.toBe(foreignKey);

    const sid = "44444444-4444-4444-8444-444444444444";
    fs.writeFileSync(
      path.join(rootDir, "local.jsonl"),
      serializeSessionFixture({
        name: "local",
        header: { id: sid, cwd: localCwd },
        entries: [
          {
            id: "e1e1e1e1",
            parentId: null,
            role: "user",
            text: "sharedmarker local-project-only-hit",
          },
        ],
      }),
      "utf8",
    );

    const db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "r1", path: rootDir, source: "user-added" }]);
    runIndex(db);

    const foreignSid = "66666666-6666-4666-8666-666666666666";
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions(
        session_id, root_id, parent_session_ref, header_project_key, file_path,
        file_size, prefix_hash, trailing_line_hash, scan_byte_offset, status, error_code, updated_at
      ) VALUES (?, 'r1', NULL, ?, ?, 1, NULL, NULL, 1, 'active', NULL, ?)`,
    ).run(foreignSid, foreignKey, path.join(rootDir, "foreign.jsonl"), now);

    const insertChunk = db.prepare(
      `INSERT INTO chunks(
        source_key, content_hash, policy_version, session_id, entry_id, block_index, chunk_index,
        origin_project_key, provenance, role, occurred_at, text, auto_eligible, chunker_version
      ) VALUES (?, ?, 'policy-v1', ?, ?, 0, 0, ?, 'verified', 'user', '2026-01-01T00:00:00.000Z', ?, 1, 'chunker-v1')`,
    );
    const insertFts = db.prepare(
      `INSERT INTO chunks_fts(source_key, content, cjk) VALUES (?, ?, ?)`,
    );
    for (let i = 0; i < 300; i += 1) {
      const sourceKey = `foreign-flood-${String(i).padStart(3, "0")}`;
      const text = `sharedmarker foreign-flood-hit-${i}`;
      insertChunk.run(sourceKey, `hash-${i}`, foreignSid, `entry-${i}`, foreignKey, text);
      insertFts.run(sourceKey, text, cjkBigrams(text).join(" "));
    }

    const hits = searchChunks(db, "sharedmarker", {
      scope: "project",
      projectKey: localKey,
      limit: 5,
    });
    expect(hits.hits.length).toBeGreaterThan(0);
    expect(hits.hits.every((hit) => hit.originProjectKey === localKey)).toBe(true);
    expect(hits.hits.some((hit) => hit.snippet.includes("local-project-only-hit"))).toBe(true);
    closeDatabase(db);
  });

  it("does not recall chunks from reconciling sessions", () => {
    const rootDir = path.join(dataHome, "sessions");
    fs.mkdirSync(rootDir, { recursive: true });
    const sid = "55555555-5555-4555-8555-555555555555";
    fs.writeFileSync(
      path.join(rootDir, "rec.jsonl"),
      serializeSessionFixture({
        name: "rec",
        header: { id: sid, cwd: "/tmp/pi-session-recall-fixtures/project-a" },
        entries: [{ id: "f1f1f1f1", parentId: null, role: "user", text: "reconciling-term" }],
      }),
      "utf8",
    );
    const db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "r1", path: rootDir, source: "user-added" }]);
    runIndex(db);
    expect(searchChunks(db, "reconciling-term", { scope: "all" }).hits.length).toBeGreaterThan(0);

    beginSessionReconcile(db, sid);
    // 模拟崩溃中间态：新 chunks 已写入且 auto_eligible=1，但 session 仍 reconciling
    db.prepare(`UPDATE chunks SET auto_eligible = 1 WHERE session_id = ?`).run(sid);
    expect(getSession(db, sid)?.status).toBe("reconciling");
    expect(searchChunks(db, "reconciling-term", { scope: "all" }).hits).toHaveLength(0);
    closeDatabase(db);
  });

  it("marks projection degraded when session path falls outside overwritten root", () => {
    const rootDir = path.join(dataHome, "sessions");
    fs.mkdirSync(rootDir, { recursive: true });
    const db = openDatabase({ dataHome });
    setupIndex(db, [{ id: "r1", path: rootDir, source: "user-added" }]);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions(
        session_id, root_id, parent_session_ref, header_project_key, file_path,
        file_size, prefix_hash, trailing_line_hash, scan_byte_offset, status, error_code, updated_at
      ) VALUES (?, 'r1', NULL, NULL, ?, 0, NULL, NULL, 0, 'active', NULL, ?)`,
    ).run("orphan-session", path.join(dataHome, "other-root", "x.jsonl"), now);
    closeDatabase(db);

    const reopened = openDatabase({ dataHome });
    expect(getRuntimeConfig(reopened).projectionStatus).toBe("degraded");
    closeDatabase(reopened);
  });

  it("POSIX data-home and db files use 0700/0600", () => {
    if (process.platform === "win32") {
      return;
    }
    const db = openDatabase({ dataHome });
    upsertSessionRoot(db, {
      id: "perm",
      path: path.join(dataHome, "sessions"),
      source: "user-added",
      enabled: true,
    });
    closeDatabase(db);

    const dirMode = fs.statSync(dataHome).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const dbPath = resolveDbPath(dataHome);
    const dbMode = fs.statSync(dbPath).mode & 0o777;
    expect(dbMode).toBe(0o600);
  });
});
