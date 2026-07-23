import type { DatabaseSync } from "node:sqlite";
import {
  CHUNKER_VERSION,
  FTS_PROJECTION_VERSION,
  POLICY_VERSION,
  SCHEMA_VERSION,
} from "../config/versions.js";
import { ERROR_CODES } from "../diagnostics/error-codes.js";
import { appendDiagnostic } from "../diagnostics/log-rotate.js";
import { isProjectionAvailable, readSchemaMeta } from "./db.js";

/**
 * Projection integrity 与 partial rebuild gate。
 */

export type ProjectionStatus = "ready" | "partial" | "degraded";

export interface ProjectionCheck {
  ok: boolean;
  status: ProjectionStatus;
  reason?: string;
  chunkCount: number;
  ftsCount: number;
}

/**
 * 读取 projection_status。
 */
export function getProjectionStatus(db: DatabaseSync): ProjectionStatus {
  const row = db
    .prepare(`SELECT projection_status AS status FROM runtime_config WHERE id = 1`)
    .get() as { status?: string } | undefined;
  const status = row?.status;
  if (status === "partial" || status === "degraded" || status === "ready") {
    return status;
  }
  return "ready";
}

/**
 * 设置 projection_status；partial/degraded 时强制关闭 auto_recall。
 */
export function setProjectionStatus(db: DatabaseSync, status: ProjectionStatus): void {
  if (status === "ready") {
    db.prepare(`UPDATE runtime_config SET projection_status = ? WHERE id = 1`).run(status);
    return;
  }
  db.prepare(
    `UPDATE runtime_config
     SET projection_status = ?, auto_recall = 0, config_version = config_version + 1
     WHERE id = 1`,
  ).run(status);
  appendDiagnostic(`projection-status=${status}`);
}

/**
 * partial rebuild 开始：标记 partial 并关闭 auto。
 */
export function markPartialRebuild(db: DatabaseSync): void {
  setProjectionStatus(db, "partial");
}

/**
 * rebuild 成功：恢复 ready。
 */
export function clearPartialRebuild(db: DatabaseSync): void {
  setProjectionStatus(db, "ready");
}

/**
 * 版本一致 + FTS/canonical 计数对齐 + 可查询。
 */
export function checkProjectionIntegrity(db: DatabaseSync): ProjectionCheck {
  const status = getProjectionStatus(db);
  let chunkCount = 0;
  let ftsCount = 0;
  try {
    chunkCount = (db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
    ftsCount = (db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts`).get() as { n: number }).n;
  } catch {
    return {
      ok: false,
      status: status === "ready" ? "degraded" : status,
      reason: ERROR_CODES.FTS_CORRUPT,
      chunkCount: 0,
      ftsCount: 0,
    };
  }

  if (status !== "ready") {
    return {
      ok: false,
      status,
      reason:
        status === "partial" ? ERROR_CODES.REBUILD_PARTIAL : ERROR_CODES.PROJECTION_UNAVAILABLE,
      chunkCount,
      ftsCount,
    };
  }

  const meta = readSchemaMeta(db);
  if (
    meta.schemaVersion !== SCHEMA_VERSION ||
    meta.chunkerVersion !== CHUNKER_VERSION ||
    meta.policyVersion !== POLICY_VERSION ||
    meta.ftsProjectionVersion !== FTS_PROJECTION_VERSION
  ) {
    return {
      ok: false,
      status: "degraded",
      reason: ERROR_CODES.PROJECTION_UNAVAILABLE,
      chunkCount,
      ftsCount,
    };
  }

  if (!isProjectionAvailable(db)) {
    return {
      ok: false,
      status: "degraded",
      reason:
        chunkCount !== ftsCount ? ERROR_CODES.FTS_CORRUPT : ERROR_CODES.PROJECTION_UNAVAILABLE,
      chunkCount,
      ftsCount,
    };
  }

  return { ok: true, status: "ready", chunkCount, ftsCount };
}

/**
 * 若 integrity 失败则标记 degraded 并返回 false。
 */
export function ensureProjectionReady(db: DatabaseSync): boolean {
  const check = checkProjectionIntegrity(db);
  if (check.ok) {
    return true;
  }
  if (getProjectionStatus(db) === "ready") {
    setProjectionStatus(db, "degraded");
  }
  return false;
}
