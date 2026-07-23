import { createHash } from "node:crypto";
import { hashLine } from "./parser.js";

/**
 * Session 文件变更识别：append / rewrite / truncate（roadmap §5.1）。
 */

export type ScanDisposition = "unchanged" | "append" | "rewrite" | "truncate" | "full-reconcile";

export interface ScanCursor {
  byteOffset: number;
  trailingLineHash: string | null;
  /** 已消费前缀 hash */
  prefixHash: string | null;
  sizeBytes: number;
}

/**
 * 根据游标与当前完整文件内容判定扫描处置。
 */
export function detectScanDisposition(cursor: ScanCursor | null, content: string): ScanDisposition {
  if (!cursor) {
    return "full-reconcile";
  }

  const complete = completeJsonlPrefix(content);
  const sizeBytes = Buffer.byteLength(complete, "utf8");
  if (sizeBytes < cursor.sizeBytes) {
    return "truncate";
  }

  if (cursor.byteOffset > 0) {
    const prefix = Buffer.from(complete, "utf8").subarray(0, cursor.byteOffset);
    if (cursor.prefixHash && sha256(prefix) !== cursor.prefixHash) {
      return "rewrite";
    }
    const prefixText = prefix.toString("utf8");
    const lastLine = trailingCompleteLine(prefixText);
    if (
      cursor.trailingLineHash &&
      lastLine !== null &&
      hashLine(lastLine) !== cursor.trailingLineHash
    ) {
      return "full-reconcile";
    }
  }

  if (sizeBytes === cursor.sizeBytes) {
    return "unchanged";
  }
  return "append";
}

/**
 * 仅取以换行结束的完整 JSONL 前缀（忽略残缺尾）。
 */
export function completeJsonlPrefix(content: string): string {
  if (content.endsWith("\n")) {
    return content;
  }
  const idx = content.lastIndexOf("\n");
  if (idx < 0) {
    return "";
  }
  return content.slice(0, idx + 1);
}

/**
 * 从完整内容构建游标（残缺尾不计入 offset/size）。
 */
export function buildScanCursor(content: string): ScanCursor {
  const complete = completeJsonlPrefix(content);
  const buf = Buffer.from(complete, "utf8");
  const trailing = trailingCompleteLine(complete);
  return {
    byteOffset: buf.length,
    trailingLineHash: trailing ? hashLine(trailing) : null,
    prefixHash: buf.length > 0 ? sha256(buf) : null,
    sizeBytes: buf.length,
  };
}

/**
 * 取末尾完整非空行。
 */
function trailingCompleteLine(content: string): string | null {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : null;
}

function sha256(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
