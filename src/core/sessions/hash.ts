import { createHash } from "node:crypto";
import { CHUNKER_VERSION, POLICY_VERSION } from "../config/versions.js";

/**
 * sourceKey / contentHash 与稳定序列化。
 */

/**
 * 稳定 JSON 序列化（对象键排序）。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/**
 * SHA256 hex。
 */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 正文 content hash（脱敏后文本）。
 */
export function contentHash(text: string): string {
  return sha256Hex(text);
}

/**
 * sourceKey = SHA256(sessionId, entryId, blockIndex, chunkIndex, chunkerVersion)
 */
export function sourceKey(input: {
  sessionId: string;
  entryId: string;
  blockIndex: number;
  chunkIndex: number;
  chunkerVersion?: string;
}): string {
  const version = input.chunkerVersion ?? CHUNKER_VERSION;
  return sha256Hex(
    [
      input.sessionId,
      input.entryId,
      String(input.blockIndex),
      String(input.chunkIndex),
      version,
    ].join("|"),
  );
}

/**
 * 幂等唯一键组成部分：sourceKey + contentHash + policyVersion。
 */
export function persistenceIdentity(input: {
  sourceKey: string;
  contentHash: string;
  policyVersion?: string;
}): string {
  return `${input.sourceKey}|${input.contentHash}|${input.policyVersion ?? POLICY_VERSION}`;
}

/**
 * session 路径/ID 的无正文 hash（诊断用）。
 */
export function sessionHash(sessionId: string): string {
  return sha256Hex(sessionId).slice(0, 16);
}
