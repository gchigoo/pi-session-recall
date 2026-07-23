import { ENVELOPE_FIXED_OVERHEAD_TOKENS } from "./constants.js";

/**
 * 保守 token 估算：ceil(UTF8 bytes / 2) + fixed overhead。
 */

/**
 * 估算文本 token 数。
 */
export function estimateTokens(text: string): number {
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil(bytes / 2);
}

/**
 * 估算完整 envelope 的 token（含固定开销）。
 */
export function estimateEnvelopeTokens(bodyText: string): number {
  return estimateTokens(bodyText) + ENVELOPE_FIXED_OVERHEAD_TOKENS;
}
