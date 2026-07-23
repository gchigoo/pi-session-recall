/**
 * 冻结版本字符串（P0 freeze）。
 */
export const SCHEMA_VERSION = "schema-v1";
export const CHUNKER_VERSION = "chunker-v1";
export const POLICY_VERSION = "policy-v1";
export const FTS_PROJECTION_VERSION = "fts-v1-content-cjkbigram";

/** chunker-v1 参数，变更必须 bump CHUNKER_VERSION。 */
export const CHUNKER_CONFIG = {
  targetScalars: 1200,
  hardMaxScalars: 2000,
  overlapScalars: 80,
  minMergeScalars: 200,
} as const;

/** parser 单行硬上限（UTF-8 bytes）。 */
export const PARSER_MAX_LINE_BYTES = 1_048_576;
