import type { DatabaseSync } from "node:sqlite";
import { ERROR_CODES } from "../diagnostics/error-codes.js";
import { isProjectionAvailable } from "../store/db.js";
import { getChunksBySourceKeys, getRuntimeConfig, type StoredChunk } from "../store/repository.js";
import { parseSearchQuery } from "./query.js";

/**
 * 检索：SQL candidate 阶段绑定 project scope，再 rank/dedupe/budget。
 */

export type SearchScope = "project" | "all";

export interface SearchOptions {
  scope: SearchScope;
  projectKey?: string;
  limit?: number;
  maxLimit?: number;
  /** 排除当前 session（自动召回） */
  excludeSessionId?: string;
  /** 仅 autoEligible=true */
  autoEligibleOnly?: boolean;
  /** 仅 provenance=verified */
  verifiedOnly?: boolean;
  /** no-hit：词项覆盖低于该阈值的候选丢弃 */
  minTermCoverage?: number;
}

export interface SearchHit {
  sessionId: string;
  entryId: string;
  role: string;
  occurredAt: string;
  snippet: string;
  truncated: boolean;
  sourceKey: string;
  contentHash: string;
  originProjectKey: string;
  score: number;
}

export interface SearchResult {
  ok: true;
  query: string;
  hits: SearchHit[];
}

const CANDIDATE_CAP = 64;
const SNIPPET_MAX = 240;

/**
 * 执行搜索。
 */
export function searchChunks(
  db: DatabaseSync,
  rawQuery: string,
  options: SearchOptions,
): SearchResult {
  if (!isProjectionAvailable(db)) {
    throw new Error(ERROR_CODES.PROJECTION_UNAVAILABLE);
  }
  const config = getRuntimeConfig(db);
  if (!config.setupCompleted) {
    throw new Error(ERROR_CODES.SETUP_REQUIRED);
  }

  const parsed = parseSearchQuery(rawQuery);
  const maxLimit = options.maxLimit ?? 20;
  const limit = Math.min(Math.max(options.limit ?? config.manualLimit, 1), maxLimit);

  if (options.scope === "project" && !options.projectKey) {
    throw new Error(ERROR_CODES.QUERY_INVALID);
  }

  // 硬性范围条件在 FTS LIMIT 之前应用，避免他项目高分结果挤掉本项目候选
  const chunkFilters: string[] = [
    `c.session_id IN (SELECT session_id FROM sessions WHERE status = 'active')`,
  ];
  const chunkParams: Array<string | number> = [];

  if (options.scope === "project") {
    const projectKey = options.projectKey;
    if (!projectKey) {
      throw new Error(ERROR_CODES.QUERY_INVALID);
    }
    chunkFilters.push("c.origin_project_key = ?");
    chunkParams.push(projectKey);
  }
  if (options.excludeSessionId) {
    chunkFilters.push("c.session_id != ?");
    chunkParams.push(options.excludeSessionId);
  }
  if (options.autoEligibleOnly) {
    chunkFilters.push("c.auto_eligible = 1");
  }
  if (options.verifiedOnly) {
    chunkFilters.push("c.provenance = 'verified'");
  }

  const ftsLimit = Math.max(CANDIDATE_CAP * 4, 256);
  const sql = `WITH fts AS (
           SELECT source_key AS sourceKey, bm25(chunks_fts) AS rank
           FROM chunks_fts
           WHERE chunks_fts MATCH ?
             AND source_key IN (
               SELECT c.source_key FROM chunks c
               WHERE ${chunkFilters.join(" AND ")}
             )
           ORDER BY rank
           LIMIT ?
         )
         SELECT fts.sourceKey AS sourceKey, fts.rank AS rank
         FROM fts
         ORDER BY fts.rank
         LIMIT ?`;
  const queryParams: Array<string | number> = [
    parsed.matchExpression,
    ...chunkParams,
    ftsLimit,
    CANDIDATE_CAP,
  ];

  const rows = db.prepare(sql).all(...queryParams) as Array<{
    sourceKey: string;
    rank: number;
  }>;

  const rankByKey = new Map(rows.map((row) => [row.sourceKey, row.rank]));
  const chunks = getChunksBySourceKeys(
    db,
    rows.map((row) => row.sourceKey),
  );

  const minCoverage = options.minTermCoverage ?? 0;
  const scored = chunks
    .map((chunk) => {
      const bm25 = rankByKey.get(chunk.sourceKey) ?? 0;
      const coverage = computeTermCoverage(chunk.text, parsed.terms);
      const roleBoost = chunk.role === "user" ? 0.05 : 0;
      const recency = recencyBoost(chunk.occurredAt);
      const score = -bm25 + coverage + roleBoost + recency;
      return { chunk, score, coverage };
    })
    .filter((item) => item.coverage >= minCoverage);

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.chunk.sourceKey.localeCompare(b.chunk.sourceKey);
  });

  const deduped = dedupeChunks(scored.map((item) => item.chunk));
  const scoreMap = new Map(scored.map((item) => [item.chunk.sourceKey, item.score]));
  const hits = deduped.slice(0, limit).map((chunk) => {
    const snippet = truncateSnippet(chunk.text, SNIPPET_MAX);
    return {
      sessionId: chunk.sessionId,
      entryId: chunk.entryId,
      role: chunk.role,
      occurredAt: chunk.occurredAt,
      snippet: snippet.text,
      truncated: snippet.truncated,
      sourceKey: chunk.sourceKey,
      contentHash: chunk.contentHash,
      originProjectKey: chunk.originProjectKey,
      score: scoreMap.get(chunk.sourceKey) ?? 0,
    };
  });

  return { ok: true, query: parsed.raw, hits };
}

/**
 * 结果层按 originProjectKey + role + contentHash 去重。
 */
function dedupeChunks(chunks: StoredChunk[]): StoredChunk[] {
  const seen = new Set<string>();
  const out: StoredChunk[] = [];
  for (const chunk of chunks) {
    const key = `${chunk.originProjectKey}|${chunk.role}|${chunk.contentHash}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(chunk);
  }
  return out;
}

/**
 * 词项覆盖率。
 */
export function computeTermCoverage(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let hit = 0;
  for (const term of terms) {
    if (lower.includes(term.toLowerCase())) {
      hit += 1;
    }
  }
  return terms.length === 0 ? 0 : hit / terms.length;
}

/**
 * 简单 recency boost（越新越高，幅度很小）。
 */
function recencyBoost(occurredAt: string): number {
  const ts = Date.parse(occurredAt);
  if (Number.isNaN(ts)) {
    return 0;
  }
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  return Math.max(0, 0.1 - ageDays * 0.0001);
}

/**
 * snippet 截断并显式标记。
 */
function truncateSnippet(text: string, maxScalars: number): { text: string; truncated: boolean } {
  const chars = [...text];
  if (chars.length <= maxScalars) {
    return { text, truncated: false };
  }
  return { text: `${chars.slice(0, maxScalars).join("")}…`, truncated: true };
}
