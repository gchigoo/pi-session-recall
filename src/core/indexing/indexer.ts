import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ERROR_CODES } from "../diagnostics/error-codes.js";
import { assertFileWithinLimit } from "../diagnostics/limits.js";
import { appendDiagnostic } from "../diagnostics/log-rotate.js";
import { toCodedError } from "../diagnostics/sqlite-errors.js";
import { resolveProjectIdentity } from "../provenance/project-identity.js";
import { buildScanCursor, detectScanDisposition } from "../sessions/scan-state.js";
import { indexSessionFile } from "../sessions/pipeline.js";
import { createRootRegistry, pathsEqual, rootIdForPath } from "../sessions/root-registry.js";
import { clearPartialRebuild, markPartialRebuild } from "../store/projection.js";
import {
  beginSessionReconcile,
  clearIndexBodies,
  getRuntimeConfig,
  getSession,
  isSessionExcluded,
  listSessionRoots,
  purgeIndex,
  replaceSessionChunks,
  updateRuntimeConfig,
  upsertProject,
  upsertSession,
  upsertSessionRoot,
  type SessionRow,
} from "../store/repository.js";
import { discoverSessionFiles } from "./discover.js";
import { releaseRebuildLease, tryAcquireRebuildLease } from "./lease.js";

/**
 * full / incremental / reconcile indexer。
 */

export interface IndexRunResult {
  scannedFiles: number;
  indexedSessions: number;
  skippedExcluded: number;
  chunksUpserted: number;
  dispositions: Record<string, number>;
}

/**
 * setup：写入 root、标记 setup 完成并启用 indexing。
 */
export function setupIndex(
  db: DatabaseSync,
  roots: Array<{
    id: string;
    path: string;
    source: "agent-dir" | "runtime-session-dir" | "user-added";
  }>,
): void {
  for (const root of roots) {
    upsertSessionRoot(db, {
      id: root.id,
      path: path.resolve(root.path),
      source: root.source,
      enabled: true,
    });
  }
  updateRuntimeConfig(db, {
    setupCompleted: true,
    indexingEnabled: true,
    autoRecall: false,
  });
}

/**
 * 对已注册 roots 执行索引（尊重 exclusions 与 indexing_enabled）。
 */
export function runIndex(
  db: DatabaseSync,
  options?: { rootPath?: string; forceFull?: boolean },
): IndexRunResult {
  const config = getRuntimeConfig(db);
  if (!config.setupCompleted) {
    throw new Error(ERROR_CODES.SETUP_REQUIRED);
  }
  if (!config.indexingEnabled) {
    throw new Error(ERROR_CODES.INDEXING_DISABLED);
  }

  let roots = listSessionRoots(db).filter((root) => root.enabled);
  if (options?.rootPath) {
    const resolved = path.resolve(options.rootPath);
    const existing = roots.find((root) => pathsEqual(root.path, resolved));
    if (!existing) {
      upsertSessionRoot(db, {
        id: rootIdForPath(resolved),
        path: resolved,
        source: "user-added",
        enabled: true,
      });
      roots = listSessionRoots(db).filter((root) => root.enabled);
    }
    roots = roots.filter((root) => pathsEqual(root.path, resolved));
  }

  const registry = createRootRegistry(roots);
  const scannedRootIds = roots.map((root) => root.id);
  const files = discoverSessionFiles(roots);
  const dispositions: Record<string, number> = {};
  let indexedSessions = 0;
  let skippedExcluded = 0;
  let chunksUpserted = 0;

  for (const file of files) {
    const one = indexDiscoveredFile(db, file.filePath, file.rootId, {
      forceFull: options?.forceFull === true,
      registry,
    });
    bump(dispositions, one.disposition);
    if (one.disposition === "excluded") {
      skippedExcluded += 1;
      continue;
    }
    if (one.indexed) {
      indexedSessions += 1;
      chunksUpserted += one.chunksUpserted;
    }
  }

  // 删除对账仅限本次扫描的 root，避免 index --root A 误删 B
  reconcileDeletedFiles(
    db,
    scannedRootIds,
    files.map((item) => path.resolve(item.filePath)),
  );

  return {
    scannedFiles: files.length,
    indexedSessions,
    skippedExcluded,
    chunksUpserted,
    dispositions,
  };
}

/**
 * rebuild：lease + partial gate + 清空正文后强制全量。
 */
export function rebuildIndex(db: DatabaseSync): IndexRunResult {
  const config = getRuntimeConfig(db);
  if (!config.setupCompleted) {
    throw new Error(ERROR_CODES.SETUP_REQUIRED);
  }
  const lease = tryAcquireRebuildLease(db);
  try {
    markPartialRebuild(db);
    clearIndexBodies(db);
    updateRuntimeConfig(db, { indexingEnabled: true });
    const result = runIndex(db, { forceFull: true });
    clearPartialRebuild(db);
    appendDiagnostic("rebuild-ok");
    return result;
  } catch (error) {
    appendDiagnostic(`rebuild-fail:${error instanceof Error ? error.message : "error"}`);
    throw toCodedError(error);
  } finally {
    releaseRebuildLease(db, lease.holder);
  }
}

/**
 * purge-index：清空正文并关闭 indexing/auto。
 */
export function purgeIndexData(db: DatabaseSync): void {
  purgeIndex(db);
}

/**
 * 解析当前 cwd 的 project key（供 search scope=project）。
 */
export function currentProjectKey(cwd = process.cwd()): string {
  return resolveProjectIdentity(cwd).projectKey;
}

/**
 * 索引单个 session 文件（供 extension 有界增量使用）。
 */
export function indexSingleFile(
  db: DatabaseSync,
  filePath: string,
  options?: { rootId?: string; forceFull?: boolean },
): { indexed: boolean; disposition: string; chunksUpserted: number; sessionId: string | null } {
  const config = getRuntimeConfig(db);
  if (!config.setupCompleted || !config.indexingEnabled) {
    return { indexed: false, disposition: "indexing-disabled", chunksUpserted: 0, sessionId: null };
  }
  const roots = listSessionRoots(db).filter((root) => root.enabled);
  const resolved = path.resolve(filePath);
  let rootId = options?.rootId;
  if (!rootId) {
    const owning = roots.find((root) => {
      const rootPath = path.resolve(root.path);
      if (pathsEqual(resolved, rootPath)) {
        return true;
      }
      if (process.platform === "win32") {
        return resolved.toLowerCase().startsWith(`${rootPath.toLowerCase()}${path.sep}`);
      }
      return resolved.startsWith(`${rootPath}${path.sep}`);
    });
    if (!owning) {
      return { indexed: false, disposition: "outside-roots", chunksUpserted: 0, sessionId: null };
    }
    rootId = owning.id;
  }
  const registry = createRootRegistry(roots);
  const one = indexDiscoveredFile(db, resolved, rootId, {
    forceFull: options?.forceFull === true,
    registry,
  });
  return {
    indexed: one.indexed,
    disposition: one.disposition,
    chunksUpserted: one.chunksUpserted,
    sessionId: one.sessionId,
  };
}

/**
 * 确保 runtime session dir 已注册为 root（路径已存在则只启用）。
 */
export function ensureRuntimeSessionRoot(db: DatabaseSync, sessionDir: string): void {
  const resolved = path.resolve(sessionDir);
  const existing = listSessionRoots(db).find((root) => pathsEqual(root.path, resolved));
  if (existing) {
    if (!existing.enabled) {
      upsertSessionRoot(db, { ...existing, enabled: true });
    }
    return;
  }
  upsertSessionRoot(db, {
    id: "runtime-session-dir",
    path: resolved,
    source: "runtime-session-dir",
    enabled: true,
  });
}

interface IndexOneResult {
  indexed: boolean;
  disposition: string;
  chunksUpserted: number;
  sessionId: string | null;
}

/**
 * 索引已发现的单个文件。
 */
function indexDiscoveredFile(
  db: DatabaseSync,
  filePath: string,
  rootId: string,
  options: { forceFull: boolean; registry: ReturnType<typeof createRootRegistry> },
): IndexOneResult {
  const stat = fs.statSync(filePath);
  assertFileWithinLimit(stat.size);
  // 单一快照：后续 parse / provenance 对当前文件复用同一份 content
  const content = fs.readFileSync(filePath, "utf8");
  const snapshotRead = createSnapshotReadFileSync(filePath, content);
  const parsedQuick = indexSessionFile(filePath, {
    registry: options.registry,
    readFileSync: snapshotRead,
  });
  if (!parsedQuick.sessionId) {
    return { indexed: false, disposition: "header-invalid", chunksUpserted: 0, sessionId: null };
  }
  if (isSessionExcluded(db, parsedQuick.sessionId)) {
    return {
      indexed: false,
      disposition: "excluded",
      chunksUpserted: 0,
      sessionId: parsedQuick.sessionId,
    };
  }

  const previous = getSession(db, parsedQuick.sessionId);
  const cursor = previous
    ? {
        byteOffset: previous.scanByteOffset,
        trailingLineHash: previous.trailingLineHash,
        prefixHash: previous.prefixHash,
        sizeBytes: previous.fileSize,
      }
    : null;
  const disposition = options.forceFull ? "full-reconcile" : detectScanDisposition(cursor, content);
  if (disposition === "unchanged") {
    // 路径迁移：同 session_id 更新 file_path
    if (previous && !pathsEqual(previous.filePath, filePath)) {
      upsertSession(db, {
        ...previous,
        rootId,
        filePath: path.resolve(filePath),
        updatedAt: new Date().toISOString(),
      });
      return {
        indexed: false,
        disposition: "moved",
        chunksUpserted: 0,
        sessionId: parsedQuick.sessionId,
      };
    }
    return {
      indexed: false,
      disposition,
      chunksUpserted: 0,
      sessionId: parsedQuick.sessionId,
    };
  }

  const project = parsedQuick.provenance?.headerProject;
  if (project) {
    upsertProject(db, {
      projectKey: project.projectKey,
      kind: project.kind,
      normalizedRoot: project.normalizedRoot,
    });
  }

  // rewrite/truncate/full：先 staging 禁用 auto，再替换
  if (
    previous &&
    (disposition === "rewrite" || disposition === "truncate" || disposition === "full-reconcile")
  ) {
    beginSessionReconcile(db, parsedQuick.sessionId);
  }

  replaceSessionChunks(db, parsedQuick.sessionId, parsedQuick.chunks);
  const scan = buildScanCursor(content);
  const row: SessionRow = {
    sessionId: parsedQuick.sessionId,
    rootId,
    parentSessionRef: parsedQuick.parsed.header?.parentSession ?? null,
    headerProjectKey: project?.projectKey ?? null,
    filePath: path.resolve(filePath),
    fileSize: scan.sizeBytes,
    prefixHash: scan.prefixHash,
    trailingLineHash: scan.trailingLineHash,
    scanByteOffset: scan.byteOffset,
    status: "active",
    errorCode: null,
    updatedAt: new Date().toISOString(),
  };
  upsertSession(db, row);
  return {
    indexed: true,
    disposition,
    chunksUpserted: parsedQuick.chunks.length,
    sessionId: parsedQuick.sessionId,
  };
}

/**
 * 当前 session 文件读自内存快照，父 session 等仍走真实 fs。
 */
function createSnapshotReadFileSync(sessionFile: string, snapshot: string): typeof fs.readFileSync {
  const resolvedSession = path.resolve(sessionFile);
  const wrapped = ((
    target: fs.PathOrFileDescriptor,
    options?:
      | {
          encoding?: BufferEncoding | null;
          flag?: string;
        }
      | BufferEncoding
      | null,
  ) => {
    const targetPath =
      typeof target === "string" || target instanceof URL ? path.resolve(String(target)) : null;
    if (targetPath !== null && pathsEqual(targetPath, resolvedSession)) {
      const encoding =
        typeof options === "string"
          ? options
          : options && typeof options === "object"
            ? options.encoding
            : "utf8";
      if (encoding === undefined || encoding === null) {
        return Buffer.from(snapshot, "utf8");
      }
      return snapshot;
    }
    return fs.readFileSync(target as Parameters<typeof fs.readFileSync>[0], options as never);
  }) as typeof fs.readFileSync;
  return wrapped;
}

/**
 * 删除文件已不存在的 session chunks（仅限本次扫描的 root）。
 */
function reconcileDeletedFiles(
  db: DatabaseSync,
  scannedRootIds: string[],
  existingFiles: string[],
): void {
  if (scannedRootIds.length === 0) {
    return;
  }
  const existing = new Set(existingFiles);
  const placeholders = scannedRootIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId, file_path AS filePath, status
       FROM sessions
       WHERE root_id IN (${placeholders})`,
    )
    .all(...scannedRootIds) as Array<{ sessionId: string; filePath: string; status: string }>;
  for (const row of rows) {
    if (row.status === "excluded") {
      continue;
    }
    if (!existing.has(path.resolve(row.filePath)) || !fs.existsSync(row.filePath)) {
      replaceSessionChunks(db, row.sessionId, []);
      db.prepare(
        `UPDATE sessions SET status = 'deleted', file_size = 0, scan_byte_offset = 0,
         prefix_hash = NULL, trailing_line_hash = NULL, updated_at = ? WHERE session_id = ?`,
      ).run(new Date().toISOString(), row.sessionId);
    }
  }
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}
