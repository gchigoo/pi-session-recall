import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ERROR_CODES } from "../diagnostics/error-codes.js";

/**
 * 扩展 data-home 与数据库路径解析。
 */

export const DATA_HOME_ENV = "PI_SESSION_RECALL_HOME";

/** purge-data 后本进程禁止再创建 data-home */
let purgedThisProcess = false;

/**
 * 解析 data-home：优先环境变量，否则 ~/.pi/agent/pi-session-recall。
 */
export function resolveDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DATA_HOME_ENV];
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".pi", "agent", "pi-session-recall");
}

/**
 * 主索引数据库路径。
 */
export function resolveDbPath(dataHome = resolveDataHome()): string {
  return path.join(dataHome, "index.sqlite");
}

/**
 * 标记本进程已 purge-data。
 */
export function markDataHomePurged(): void {
  purgedThisProcess = true;
}

/**
 * 是否已在本进程 purge。
 */
export function isDataHomePurged(): boolean {
  return purgedThisProcess;
}

/**
 * 测试用：重置 purge latch。
 */
export function resetPurgeLatchForTests(): void {
  purgedThisProcess = false;
}

/**
 * purge 后禁止 mkdir / 打开可写 DB。
 */
export function assertNotPurgedInProcess(): void {
  if (purgedThisProcess) {
    throw new Error(ERROR_CODES.PURGE_RESTART_REQUIRED);
  }
}

/**
 * 确保 data-home 目录存在（purge 后同进程拒绝），POSIX 收紧为 0700。
 */
export function ensureDataHome(dataHome = resolveDataHome()): string {
  assertNotPurgedInProcess();
  fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dataHome, 0o700);
    } catch {
      // 某些挂载点可能拒绝 chmod，不阻断启动
    }
  }
  return dataHome;
}

/**
 * 收紧 DB 及 WAL/SHM 文件权限为 0600（win32 跳过）。
 */
export function hardenDbFilePermissions(dbPath: string): void {
  if (process.platform === "win32") {
    return;
  }
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      fs.chmodSync(candidate, 0o600);
    } catch {
      // 忽略单文件 chmod 失败
    }
  }
}
