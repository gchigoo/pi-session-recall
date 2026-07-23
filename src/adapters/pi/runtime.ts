import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  createRequestContext,
  invalidateBundle,
  type RequestContextState,
} from "../../core/injection/request-context.js";
import { closeDatabase, openDatabase } from "../../core/store/db.js";
import { resolveDataHome, resolveDbPath } from "../../core/store/paths.js";

/**
 * Extension 运行时状态：懒开 DB、shutdown abort、RequestContext。
 */

export interface ExtensionRuntime {
  aborted: boolean;
  db: DatabaseSync | null;
  lastError: string | null;
  requestContext: RequestContextState;
}

/**
 * 创建运行时。
 */
export function createRuntime(): ExtensionRuntime {
  return {
    aborted: false,
    db: null,
    lastError: null,
    requestContext: createRequestContext(),
  };
}

/**
 * 若已 setup 则懒打开可写 DB；未 setup 返回 null（不抛）。
 */
export function tryOpenDb(runtime: ExtensionRuntime): DatabaseSync | null {
  if (runtime.aborted) {
    return null;
  }
  if (runtime.db) {
    return runtime.db;
  }
  const dbPath = resolveDbPath(resolveDataHome());
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  try {
    runtime.db = openDatabase();
    return runtime.db;
  } catch (error) {
    runtime.lastError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

/**
 * 强制打开（setup 命令用）。
 */
export function openDbRequired(runtime: ExtensionRuntime): DatabaseSync {
  if (runtime.db) {
    return runtime.db;
  }
  runtime.db = openDatabase();
  return runtime.db;
}

/**
 * 关闭 DB 并标记 abort（session_shutdown）。
 */
export function shutdownRuntime(runtime: ExtensionRuntime): void {
  runtime.aborted = true;
  invalidateBundle(runtime.requestContext);
  if (runtime.db) {
    try {
      closeDatabase(runtime.db);
    } catch {
      // fail-open
    }
    runtime.db = null;
  }
}

/**
 * 记录错误但不抛出。
 */
export function rememberError(runtime: ExtensionRuntime, error: unknown): void {
  runtime.lastError = error instanceof Error ? error.message : String(error);
}
