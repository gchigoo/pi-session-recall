import {
  CHUNKER_VERSION,
  FTS_PROJECTION_VERSION,
  POLICY_VERSION,
  SCHEMA_VERSION,
} from "../config/versions.js";

/**
 * schema-v1 DDL 与初始种子。
 */

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version TEXT NOT NULL,
    chunker_version TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    fts_projection_version TEXT NOT NULL,
    fts_generation INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS runtime_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    setup_completed INTEGER NOT NULL DEFAULT 0,
    indexing_enabled INTEGER NOT NULL DEFAULT 0,
    auto_recall INTEGER NOT NULL DEFAULT 0,
    manual_limit INTEGER NOT NULL DEFAULT 5,
    tool_limit INTEGER NOT NULL DEFAULT 5,
    auto_max_records INTEGER NOT NULL DEFAULT 4,
    auto_max_tokens INTEGER NOT NULL DEFAULT 600,
    config_version INTEGER NOT NULL DEFAULT 1,
    projection_status TEXT NOT NULL DEFAULT 'ready'
  )`,
  `CREATE TABLE IF NOT EXISTS rebuild_leases (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    holder TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session_roots (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS projects (
    project_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    normalized_root TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    parent_session_ref TEXT,
    header_project_key TEXT,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    prefix_hash TEXT,
    trailing_line_hash TEXT,
    scan_byte_offset INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    error_code TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (root_id) REFERENCES session_roots(id)
  )`,
  `CREATE TABLE IF NOT EXISTS chunks (
    source_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    session_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    block_index INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    origin_project_key TEXT NOT NULL,
    provenance TEXT NOT NULL,
    role TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    text TEXT NOT NULL,
    auto_eligible INTEGER NOT NULL,
    chunker_version TEXT NOT NULL,
    PRIMARY KEY (source_key, content_hash, policy_version)
  )`,
  `CREATE TABLE IF NOT EXISTS session_exclusions (
    session_id TEXT PRIMARY KEY,
    excluded_at TEXT NOT NULL,
    reason TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_origin ON chunks(origin_project_key)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`,
] as const;

/**
 * FTS5 projection（content + cjk bigram）。
 */
export const FTS_CREATE = `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  source_key UNINDEXED,
  content,
  cjk,
  tokenize = 'unicode61'
)`;

/**
 * 初始 schema_meta / runtime_config 行。
 */
export function seedMetaSql(): string[] {
  return [
    `INSERT OR IGNORE INTO schema_meta(
      id, schema_version, chunker_version, policy_version, fts_projection_version, fts_generation
    ) VALUES (
      1,
      '${SCHEMA_VERSION}',
      '${CHUNKER_VERSION}',
      '${POLICY_VERSION}',
      '${FTS_PROJECTION_VERSION}',
      1
    )`,
    `INSERT OR IGNORE INTO runtime_config(id) VALUES (1)`,
  ];
}
