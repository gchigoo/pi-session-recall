import fs from "node:fs";
import path from "node:path";
import { ERROR_CODES } from "../diagnostics/error-codes.js";
import { closeDatabase, openDatabase } from "../store/db.js";
import {
  assertNotPurgedInProcess,
  ensureDataHome,
  markDataHomePurged,
  resolveDataHome,
  resolveDbPath,
} from "../store/paths.js";
import { getRuntimeConfig } from "../store/repository.js";

/**
 * data-home 生命周期辅助（含 purge-data）。
 */

/**
 * 若未 setup 则抛错。
 */
export function assertSetup(dataHome = resolveDataHome()): void {
  assertNotPurgedInProcess();
  const dbPath = resolveDbPath(dataHome);
  if (!fs.existsSync(dbPath)) {
    throw new Error(ERROR_CODES.SETUP_REQUIRED);
  }
  const db = openDatabase({ dataHome, readonly: true });
  try {
    const config = getRuntimeConfig(db);
    if (!config.setupCompleted) {
      throw new Error(ERROR_CODES.SETUP_REQUIRED);
    }
  } finally {
    closeDatabase(db);
  }
}

/**
 * 删除整个 data-home；若无法取得写锁则判定存在活跃 writer。
 * 成功后本进程禁止再创建 data-home（需重启进程）。
 */
export function purgeDataHome(dataHome = resolveDataHome()): {
  deleted: boolean;
  dataHome: string;
} {
  assertNotPurgedInProcess();
  const resolved = path.resolve(dataHome);
  if (!fs.existsSync(resolved)) {
    markDataHomePurged();
    return { deleted: false, dataHome: resolved };
  }
  const dbPath = resolveDbPath(resolved);
  if (fs.existsSync(dbPath)) {
    try {
      const db = openDatabase({ dataHome: resolved });
      try {
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");
      } finally {
        closeDatabase(db);
      }
    } catch {
      throw new Error(ERROR_CODES.WRITER_ACTIVE);
    }
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  markDataHomePurged();
  return { deleted: true, dataHome: resolved };
}

/**
 * setup 前确保目录。
 */
export function prepareDataHome(dataHome = resolveDataHome()): string {
  return ensureDataHome(dataHome);
}
