/**
 * 稳定错误码（docs/p0-freeze.md）。
 */
export const ERROR_CODES = {
  LEGACY_UNSUPPORTED: "legacy-unsupported",
  HEADER_INVALID: "header-invalid",
  ENTRY_MALFORMED: "entry-malformed",
  ENTRY_OVERSIZED: "entry-oversized",
  PROVENANCE_UNRESOLVED: "provenance-unresolved",
  PARENT_MISSING: "parent-missing",
  PARENT_OUTSIDE_REGISTERED_ROOTS: "parent-outside-registered-roots",
  PARENT_CYCLE: "parent-cycle",
  PROJECTION_UNAVAILABLE: "projection-unavailable",
  SECRET_REJECTED: "secret-rejected",
  QUERY_INVALID: "query-invalid",
  SETUP_REQUIRED: "setup-required",
  SCANNER_FAIL_CLOSED: "scanner-fail-closed",
  PATH_REJECTED: "path-rejected",
  DB_BUSY: "db-busy",
  LEASE_HELD: "lease-held",
  WRITER_ACTIVE: "writer-active",
  FTS_CORRUPT: "fts-corrupt",
  DISK_FULL: "disk-full",
  PERMISSION_DENIED: "permission-denied",
  SIZE_LIMIT_EXCEEDED: "size-limit-exceeded",
  PURGE_RESTART_REQUIRED: "purge-restart-required",
  INDEXING_DISABLED: "indexing-disabled",
  REBUILD_PARTIAL: "rebuild-partial",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * 无正文诊断事件（不得包含 query/text/path）。
 */
export interface DiagnosticEvent {
  code: ErrorCode | string;
  ruleId?: string;
  count?: number;
  sessionHash?: string;
  diagnosticId?: string;
  detail?: string;
}
