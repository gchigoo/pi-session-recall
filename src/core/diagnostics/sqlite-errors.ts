import { ERROR_CODES, type ErrorCode } from "./error-codes.js";

/**
 * 将 node:sqlite / 系统错误映射为稳定错误码。
 */

/**
 * 从任意 thrown value 提取稳定错误码字符串。
 */
export function mapSqliteError(error: unknown): ErrorCode | string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("busy") ||
    lower.includes("locked") ||
    lower.includes("sqlite_busy") ||
    lower.includes("database is locked")
  ) {
    return ERROR_CODES.DB_BUSY;
  }
  if (lower.includes("disk") && (lower.includes("full") || lower.includes("enospc"))) {
    return ERROR_CODES.DISK_FULL;
  }
  if (lower.includes("eacces") || lower.includes("eperm") || lower.includes("permission")) {
    return ERROR_CODES.PERMISSION_DENIED;
  }
  if (lower.includes("fts") || lower.includes("corrupt") || lower.includes("malformed database")) {
    return ERROR_CODES.FTS_CORRUPT;
  }
  // 已是稳定码则原样返回
  for (const code of Object.values(ERROR_CODES)) {
    if (message === code || message.endsWith(code)) {
      return code;
    }
  }
  return message;
}

/**
 * 包装为带稳定码的 Error。
 */
export function toCodedError(error: unknown): Error {
  const code = mapSqliteError(error);
  if (error instanceof Error && error.message === code) {
    return error;
  }
  return new Error(code);
}
