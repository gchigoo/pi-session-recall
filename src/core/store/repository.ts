import type { DatabaseSync } from "node:sqlite";
import { cjkBigrams } from "../retrieval/cjk-terms.js";
import type { CanonicalChunk } from "../sessions/pipeline.js";
import type { SessionRoot, SessionRootSource } from "../sessions/root-registry.js";
import { bumpFtsGeneration } from "./db.js";

/**
 * Repository：runtime config / roots / sessions / chunks / exclusions / FTS。
 */

export type ProjectionStatus = "ready" | "partial" | "degraded";

export interface RuntimeConfig {
  setupCompleted: boolean;
  indexingEnabled: boolean;
  autoRecall: boolean;
  manualLimit: number;
  toolLimit: number;
  autoMaxRecords: number;
  autoMaxTokens: number;
  configVersion: number;
  projectionStatus: ProjectionStatus;
}

export interface SessionRow {
  sessionId: string;
  rootId: string;
  parentSessionRef: string | null;
  headerProjectKey: string | null;
  filePath: string;
  fileSize: number;
  prefixHash: string | null;
  trailingLineHash: string | null;
  scanByteOffset: number;
  status: string;
  errorCode: string | null;
  updatedAt: string;
}

export interface StoredChunk {
  sourceKey: string;
  contentHash: string;
  policyVersion: string;
  sessionId: string;
  entryId: string;
  blockIndex: number;
  chunkIndex: number;
  originProjectKey: string;
  provenance: string;
  role: string;
  occurredAt: string;
  text: string;
  autoEligible: boolean;
  chunkerVersion: string;
}

/**
 * 读取 runtime_config。
 */
export function getRuntimeConfig(db: DatabaseSync): RuntimeConfig {
  const row = db
    .prepare(
      `SELECT setup_completed, indexing_enabled, auto_recall, manual_limit, tool_limit,
              auto_max_records, auto_max_tokens, config_version,
              projection_status AS projectionStatus
       FROM runtime_config WHERE id = 1`,
    )
    .get() as
    | {
        setup_completed: number;
        indexing_enabled: number;
        auto_recall: number;
        manual_limit: number;
        tool_limit: number;
        auto_max_records: number;
        auto_max_tokens: number;
        config_version: number;
        projectionStatus: string;
      }
    | undefined;
  if (!row) {
    throw new Error("setup-required");
  }
  const projectionStatus: ProjectionStatus =
    row.projectionStatus === "partial" || row.projectionStatus === "degraded"
      ? row.projectionStatus
      : "ready";
  return {
    setupCompleted: row.setup_completed === 1,
    indexingEnabled: row.indexing_enabled === 1,
    autoRecall: row.auto_recall === 1,
    manualLimit: row.manual_limit,
    toolLimit: row.tool_limit,
    autoMaxRecords: row.auto_max_records,
    autoMaxTokens: row.auto_max_tokens,
    configVersion: row.config_version,
    projectionStatus,
  };
}

/**
 * 部分更新 runtime_config。
 */
export function updateRuntimeConfig(
  db: DatabaseSync,
  patch: Partial<{
    setupCompleted: boolean;
    indexingEnabled: boolean;
    autoRecall: boolean;
    manualLimit: number;
    toolLimit: number;
  }>,
): RuntimeConfig {
  const current = getRuntimeConfig(db);
  const next = {
    setupCompleted: patch.setupCompleted ?? current.setupCompleted,
    indexingEnabled: patch.indexingEnabled ?? current.indexingEnabled,
    autoRecall: patch.autoRecall ?? current.autoRecall,
    manualLimit: patch.manualLimit ?? current.manualLimit,
    toolLimit: patch.toolLimit ?? current.toolLimit,
  };
  db.prepare(
    `UPDATE runtime_config
     SET setup_completed = ?, indexing_enabled = ?, auto_recall = ?,
         manual_limit = ?, tool_limit = ?, config_version = config_version + 1
     WHERE id = 1`,
  ).run(
    next.setupCompleted ? 1 : 0,
    next.indexingEnabled ? 1 : 0,
    next.autoRecall ? 1 : 0,
    next.manualLimit,
    next.toolLimit,
  );
  return getRuntimeConfig(db);
}

/**
 * upsert session root。
 */
export function upsertSessionRoot(db: DatabaseSync, root: SessionRoot): void {
  db.prepare(
    `INSERT INTO session_roots(id, path, source, enabled)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET path = excluded.path, source = excluded.source, enabled = excluded.enabled`,
  ).run(root.id, root.path, root.source, root.enabled ? 1 : 0);
}

/**
 * 列出启用的 roots。
 */
export function listSessionRoots(db: DatabaseSync): SessionRoot[] {
  const rows = db
    .prepare(`SELECT id, path, source, enabled FROM session_roots ORDER BY path`)
    .all() as Array<{ id: string; path: string; source: string; enabled: number }>;
  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    source: row.source as SessionRootSource,
    enabled: row.enabled === 1,
  }));
}

/**
 * upsert project。
 */
export function upsertProject(
  db: DatabaseSync,
  project: { projectKey: string; kind: string; normalizedRoot: string },
): void {
  db.prepare(
    `INSERT INTO projects(project_key, kind, normalized_root)
     VALUES (?, ?, ?)
     ON CONFLICT(project_key) DO UPDATE SET kind = excluded.kind, normalized_root = excluded.normalized_root`,
  ).run(project.projectKey, project.kind, project.normalizedRoot);
}

/**
 * 读取 session 行。
 */
export function getSession(db: DatabaseSync, sessionId: string): SessionRow | null {
  const row = db
    .prepare(
      `SELECT session_id AS sessionId, root_id AS rootId, parent_session_ref AS parentSessionRef,
              header_project_key AS headerProjectKey, file_path AS filePath, file_size AS fileSize,
              prefix_hash AS prefixHash, trailing_line_hash AS trailingLineHash,
              scan_byte_offset AS scanByteOffset, status, error_code AS errorCode, updated_at AS updatedAt
       FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;
  return row ?? null;
}

/**
 * upsert session 元数据。
 */
export function upsertSession(db: DatabaseSync, session: SessionRow): void {
  db.prepare(
    `INSERT INTO sessions(
      session_id, root_id, parent_session_ref, header_project_key, file_path, file_size,
      prefix_hash, trailing_line_hash, scan_byte_offset, status, error_code, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      root_id = excluded.root_id,
      parent_session_ref = excluded.parent_session_ref,
      header_project_key = excluded.header_project_key,
      file_path = excluded.file_path,
      file_size = excluded.file_size,
      prefix_hash = excluded.prefix_hash,
      trailing_line_hash = excluded.trailing_line_hash,
      scan_byte_offset = excluded.scan_byte_offset,
      status = excluded.status,
      error_code = excluded.error_code,
      updated_at = excluded.updated_at`,
  ).run(
    session.sessionId,
    session.rootId,
    session.parentSessionRef,
    session.headerProjectKey,
    session.filePath,
    session.fileSize,
    session.prefixHash,
    session.trailingLineHash,
    session.scanByteOffset,
    session.status,
    session.errorCode,
    session.updatedAt,
  );
}

/**
 * session 是否被排除。
 */
export function isSessionExcluded(db: DatabaseSync, sessionId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM session_exclusions WHERE session_id = ?`)
    .get(sessionId) as { ok: number } | undefined;
  return Boolean(row);
}

/**
 * 排除 session，并删除其 chunks/FTS。
 */
export function excludeSession(db: DatabaseSync, sessionId: string, reason = "user"): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO session_exclusions(session_id, excluded_at, reason)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET excluded_at = excluded.excluded_at, reason = excluded.reason`,
    ).run(sessionId, new Date().toISOString(), reason);
    deleteSessionChunks(db, sessionId);
    db.prepare(`UPDATE sessions SET status = 'excluded', updated_at = ? WHERE session_id = ?`).run(
      new Date().toISOString(),
      sessionId,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 恢复排除（不自动重索引）。
 */
export function includeSession(db: DatabaseSync, sessionId: string): void {
  db.prepare(`DELETE FROM session_exclusions WHERE session_id = ?`).run(sessionId);
  db.prepare(`UPDATE sessions SET status = 'active', updated_at = ? WHERE session_id = ?`).run(
    new Date().toISOString(),
    sessionId,
  );
}

/**
 * 删除某 session 的 canonical chunks 与 FTS 行。
 */
export function deleteSessionChunks(db: DatabaseSync, sessionId: string): void {
  const keys = db
    .prepare(`SELECT source_key AS sourceKey FROM chunks WHERE session_id = ?`)
    .all(sessionId) as Array<{ sourceKey: string }>;
  const delFts = db.prepare(`DELETE FROM chunks_fts WHERE source_key = ?`);
  for (const key of keys) {
    delFts.run(key.sourceKey);
  }
  db.prepare(`DELETE FROM chunks WHERE session_id = ?`).run(sessionId);
}

/**
 * rewrite/truncate 前 staging：禁用 auto_eligible，标记 reconciling。
 */
export function beginSessionReconcile(db: DatabaseSync, sessionId: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE chunks SET auto_eligible = 0 WHERE session_id = ?`).run(sessionId);
    db.prepare(
      `UPDATE sessions SET status = 'reconciling', updated_at = ? WHERE session_id = ?`,
    ).run(new Date().toISOString(), sessionId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 用新 chunks 替换某 session 的索引内容（同事务写 chunks + FTS）。
 */
export function replaceSessionChunks(
  db: DatabaseSync,
  sessionId: string,
  chunks: CanonicalChunk[],
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    deleteSessionChunks(db, sessionId);
    const insertChunk = db.prepare(
      `INSERT INTO chunks(
        source_key, content_hash, policy_version, session_id, entry_id, block_index, chunk_index,
        origin_project_key, provenance, role, occurred_at, text, auto_eligible, chunker_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = db.prepare(
      `INSERT INTO chunks_fts(source_key, content, cjk) VALUES (?, ?, ?)`,
    );
    for (const chunk of chunks) {
      insertChunk.run(
        chunk.sourceKey,
        chunk.contentHash,
        chunk.policyVersion,
        chunk.sessionId,
        chunk.entryId,
        chunk.blockIndex,
        chunk.chunkIndex,
        chunk.originProjectKey,
        chunk.provenance,
        chunk.role,
        chunk.occurredAt,
        chunk.text,
        chunk.autoEligible ? 1 : 0,
        chunk.chunkerVersion,
      );
      insertFts.run(chunk.sourceKey, chunk.text, cjkBigrams(chunk.text).join(" "));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 统计 chunks。
 */
export function countChunks(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number };
  return row.n;
}

/**
 * 清空索引正文与游标，并关闭 indexing/autoRecall。
 */
export function purgeIndex(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DELETE FROM chunks_fts`);
    db.exec(`DELETE FROM chunks`);
    db.exec(
      `UPDATE sessions SET
        file_size = 0,
        prefix_hash = NULL,
        trailing_line_hash = NULL,
        scan_byte_offset = 0,
        updated_at = '${new Date().toISOString()}'
       WHERE status != 'excluded'`,
    );
    db.prepare(
      `UPDATE runtime_config
       SET indexing_enabled = 0, auto_recall = 0, config_version = config_version + 1
       WHERE id = 1`,
    ).run();
    bumpFtsGeneration(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * rebuild：清空 chunks/FTS/cursors，保留 roots/exclusions/config（indexing 保持开启由调用方决定）。
 */
export function clearIndexBodies(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DELETE FROM chunks_fts`);
    db.exec(`DELETE FROM chunks`);
    db.exec(
      `UPDATE sessions SET
        file_size = 0,
        prefix_hash = NULL,
        trailing_line_hash = NULL,
        scan_byte_offset = 0,
        updated_at = '${new Date().toISOString()}'`,
    );
    bumpFtsGeneration(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 按 source_key 批量读取 chunks（检索候选回表）。
 */
export function getChunksBySourceKeys(db: DatabaseSync, sourceKeys: string[]): StoredChunk[] {
  if (sourceKeys.length === 0) {
    return [];
  }
  const placeholders = sourceKeys.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT source_key AS sourceKey, content_hash AS contentHash, policy_version AS policyVersion,
              session_id AS sessionId, entry_id AS entryId, block_index AS blockIndex,
              chunk_index AS chunkIndex, origin_project_key AS originProjectKey, provenance,
              role, occurred_at AS occurredAt, text, auto_eligible AS autoEligibleInt,
              chunker_version AS chunkerVersion
       FROM chunks WHERE source_key IN (${placeholders})`,
    )
    .all(...sourceKeys) as Array<{
    sourceKey: string;
    contentHash: string;
    policyVersion: string;
    sessionId: string;
    entryId: string;
    blockIndex: number;
    chunkIndex: number;
    originProjectKey: string;
    provenance: string;
    role: string;
    occurredAt: string;
    text: string;
    autoEligibleInt: number;
    chunkerVersion: string;
  }>;
  return rows.map((row) => ({
    sourceKey: row.sourceKey,
    contentHash: row.contentHash,
    policyVersion: row.policyVersion,
    sessionId: row.sessionId,
    entryId: row.entryId,
    blockIndex: row.blockIndex,
    chunkIndex: row.chunkIndex,
    originProjectKey: row.originProjectKey,
    provenance: row.provenance,
    role: row.role,
    occurredAt: row.occurredAt,
    text: row.text,
    autoEligible: row.autoEligibleInt === 1,
    chunkerVersion: row.chunkerVersion,
  }));
}
