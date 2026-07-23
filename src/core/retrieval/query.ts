import { ERROR_CODES } from "../diagnostics/error-codes.js";
import { queryTerms } from "./cjk-terms.js";

/**
 * 查询校验与 FTS 表达式构建。
 */

export interface ParsedQuery {
  raw: string;
  terms: string[];
  matchExpression: string;
}

const MAX_SCALARS = 500;
const MAX_BYTES = 2048;

/**
 * 校验并解析查询；永不把原始 MATCH 语法直传 SQLite。
 */
export function parseSearchQuery(raw: string): ParsedQuery {
  const normalized = raw.normalize("NFC").trim();
  if (normalized.length === 0) {
    throw new Error(ERROR_CODES.QUERY_INVALID);
  }
  if ([...normalized].length > MAX_SCALARS || Buffer.byteLength(normalized, "utf8") > MAX_BYTES) {
    throw new Error(ERROR_CODES.QUERY_INVALID);
  }
  const terms = queryTerms(normalized);
  if (terms.length === 0) {
    throw new Error(ERROR_CODES.QUERY_INVALID);
  }
  const matchExpression = terms
    .map((term) => {
      const quoted = `"${term.replaceAll('"', '""')}"`;
      return `(content:${quoted} OR cjk:${quoted})`;
    })
    .join(" OR ");
  return { raw: normalized, terms, matchExpression };
}
