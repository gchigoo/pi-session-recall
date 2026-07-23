import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  CHUNKER_VERSION,
  FTS_PROJECTION_VERSION,
  POLICY_VERSION,
  SCHEMA_VERSION,
} from "../config/versions.js";
import { ERROR_CODES } from "../diagnostics/error-codes.js";
import { toCodedError } from "../diagnostics/sqlite-errors.js";
import {
  canonicalizeRootPath,
  isLegacyUserRootId,
  isPathUnderRoot,
  rootIdForPath,
} from "../sessions/root-registry.js";
import {
  assertNotPurgedInProcess,
  ensureDataHome,
  hardenDbFilePermissions,
  resolveDataHome,
  resolveDbPath,
} from "./paths.js";
import { FTS_CREATE, SCHEMA_STATEMENTS, seedMetaSql } from "./schema.js";

/**
 * SQLite 打开、PRAGMA 与 migration。
 */

export interface OpenDbOptions {
  dataHome?: string;
  dbPath?: string;
  readonly?: boolean;
}

export interface SchemaMeta {
  schemaVersion: string;
  chunkerVersion: string;
  policyVersion: string;
  ftsProjectionVersion: string;
  ftsGeneration: number;
}

/**
 * 打开（或创建）索引数据库并完成 migration。
 */
export function openDatabase(options: OpenDbOptions = {}): DatabaseSync {
  assertNotPurgedInProcess();
  const dataHome = options.dataHome ?? resolveDataHome();
  const dbPath = options.dbPath ?? resolveDbPath(dataHome);
  if (!options.readonly) {
    ensureDataHome(dataHome);
  } else if (!fs.existsSync(dbPath)) {
    throw new Error(ERROR_CODES.SETUP_REQUIRED);
  }

  try {
    const db = new DatabaseSync(dbPath, {
      readOnly: options.readonly ?? false,
    });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 1000");
    // 检索热路径：提高页缓存，降低 100k 规模下的随机读放大
    db.exec("PRAGMA cache_size = -65536"); // ~64 MiB
    db.exec("PRAGMA temp_store = MEMORY");
    if (!options.readonly) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("PRAGMA mmap_size = 268435456");
      migrate(db);
      // FK pragma 在事务内无效，legacy root 迁移必须在 migrate 提交后执行
      migrateLegacyRootIds(db);
      hardenDbFilePermissions(dbPath);
    } else {
      try {
        db.exec("PRAGMA mmap_size = 268435456");
      } catch {
        // readonly 某些平台可能忽略
      }
    }
    return db;
  } catch (error) {
    throw toCodedError(error);
  }
}

/**
 * 执行 schema migration 与 FTS 创建。
 */
export function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of SCHEMA_STATEMENTS) {
      db.exec(statement);
    }
    db.exec(FTS_CREATE);
    for (const statement of seedMetaSql()) {
      db.exec(statement);
    }
    ensureSchemaPatches(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 旧库补丁：projection_status / rebuild_leases。
 */
function ensureSchemaPatches(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info(runtime_config)`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((col) => col.name === "projection_status")) {
    db.exec(
      `ALTER TABLE runtime_config ADD COLUMN projection_status TEXT NOT NULL DEFAULT 'ready'`,
    );
  }
  db.exec(`CREATE TABLE IF NOT EXISTS rebuild_leases (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    holder TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
}

/**
 * 将易碰撞的旧 user-* 12hex root ID 迁移为全路径哈希 ID。
 * 若发现 session 路径与 root 不一致（旧碰撞覆盖后遗症），标记 projection degraded。
 */
function migrateLegacyRootIds(db: DatabaseSync): void {
  const roots = db.prepare(`SELECT id, path, source, enabled FROM session_roots`).all() as Array<{
    id: string;
    path: string;
    source: string;
    enabled: number;
  }>;
  const legacy = roots.filter((root) => isLegacyUserRootId(root.id));
  let conflict = false;

  if (legacy.length > 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const root of legacy) {
        const newId = rootIdForPath(root.path);
        if (newId === root.id) {
          continue;
        }
        const existing = db
          .prepare(`SELECT id, path FROM session_roots WHERE id = ?`)
          .get(newId) as { id: string; path: string } | undefined;
        if (existing) {
          if (canonicalizeRootPath(existing.path) !== canonicalizeRootPath(root.path)) {
            conflict = true;
            continue;
          }
          db.prepare(`UPDATE sessions SET root_id = ? WHERE root_id = ?`).run(newId, root.id);
          db.prepare(`DELETE FROM session_roots WHERE id = ?`).run(root.id);
          continue;
        }
        // FK ON：先插入临时 path 的新 root，再改 sessions，最后删旧 root 并恢复 path
        const tempPath = `${root.path}.__migrating__${newId}`;
        db.prepare(`INSERT INTO session_roots(id, path, source, enabled) VALUES (?, ?, ?, ?)`).run(
          newId,
          tempPath,
          root.source,
          root.enabled,
        );
        db.prepare(`UPDATE sessions SET root_id = ? WHERE root_id = ?`).run(newId, root.id);
        db.prepare(`DELETE FROM session_roots WHERE id = ?`).run(root.id);
        db.prepare(`UPDATE session_roots SET path = ? WHERE id = ?`).run(root.path, newId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // 旧碰撞覆盖后：session 仍挂在被覆盖的 root 上，file_path 会落在 root 外
  const rows = db
    .prepare(
      `SELECT s.file_path AS filePath, r.path AS rootPath
       FROM sessions s
       JOIN session_roots r ON r.id = s.root_id
       WHERE s.status != 'excluded'`,
    )
    .all() as Array<{ filePath: string; rootPath: string }>;
  for (const row of rows) {
    if (!isPathUnderRoot(row.filePath, row.rootPath)) {
      conflict = true;
      break;
    }
  }

  if (conflict) {
    db.prepare(
      `UPDATE runtime_config
       SET projection_status = 'degraded', auto_recall = 0, config_version = config_version + 1
       WHERE id = 1`,
    ).run();
  }
}

/**
 * 读取 schema_meta。
 */
export function readSchemaMeta(db: DatabaseSync): SchemaMeta {
  const row = db
    .prepare(
      `SELECT schema_version AS schemaVersion,
              chunker_version AS chunkerVersion,
              policy_version AS policyVersion,
              fts_projection_version AS ftsProjectionVersion,
              fts_generation AS ftsGeneration
       FROM schema_meta WHERE id = 1`,
    )
    .get() as SchemaMeta | undefined;
  if (!row) {
    throw new Error(ERROR_CODES.SETUP_REQUIRED);
  }
  return row;
}

/**
 * FTS projection 是否可用（版本 + status + chunk/FTS 计数）。
 */
export function isProjectionAvailable(db: DatabaseSync): boolean {
  const meta = readSchemaMeta(db);
  if (
    meta.schemaVersion !== SCHEMA_VERSION ||
    meta.chunkerVersion !== CHUNKER_VERSION ||
    meta.policyVersion !== POLICY_VERSION ||
    meta.ftsProjectionVersion !== FTS_PROJECTION_VERSION
  ) {
    return false;
  }
  const statusRow = db
    .prepare(`SELECT projection_status AS status FROM runtime_config WHERE id = 1`)
    .get() as { status?: string } | undefined;
  if (statusRow?.status && statusRow.status !== "ready") {
    return false;
  }
  try {
    const chunkCount = (db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
    const ftsCount = (db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts`).get() as { n: number }).n;
    if (chunkCount !== ftsCount) {
      return false;
    }
    db.prepare(`SELECT source_key FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 1`).get(
      "projection_integrity_probe",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * bump FTS generation（rebuild/purge 后）。
 */
export function bumpFtsGeneration(db: DatabaseSync): number {
  db.prepare(`UPDATE schema_meta SET fts_generation = fts_generation + 1 WHERE id = 1`).run();
  return readSchemaMeta(db).ftsGeneration;
}

/**
 * 关闭数据库。
 */
export function closeDatabase(db: DatabaseSync): void {
  db.close();
}
