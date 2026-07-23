import { PARSER_MAX_LINE_BYTES } from "../config/versions.js";
import { ERROR_CODES } from "./error-codes.js";

/**
 * DB / 文件 / 行大小上限（诊断用，非加密保证）。
 */

export const LIMITS = {
  /** 索引库建议上限 */
  maxDbBytes: 512 * 1024 * 1024,
  /** 单 session JSONL 上限 */
  maxSessionFileBytes: 64 * 1024 * 1024,
  /** 与 parser 硬上限一致 */
  maxLineBytes: PARSER_MAX_LINE_BYTES,
  /** 诊断日志文件上限 */
  maxDiagnosticLogBytes: 2 * 1024 * 1024,
} as const;

/**
 * 校验文件大小；超限抛 size-limit-exceeded。
 */
export function assertFileWithinLimit(
  byteLength: number,
  limit = LIMITS.maxSessionFileBytes,
): void {
  if (byteLength > limit) {
    throw new Error(ERROR_CODES.SIZE_LIMIT_EXCEEDED);
  }
}

/**
 * 校验 DB 文件大小。
 */
export function assertDbWithinLimit(byteLength: number, limit = LIMITS.maxDbBytes): void {
  if (byteLength > limit) {
    throw new Error(ERROR_CODES.SIZE_LIMIT_EXCEEDED);
  }
}
