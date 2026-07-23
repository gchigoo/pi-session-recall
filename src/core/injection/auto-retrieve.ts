import type { DatabaseSync } from "node:sqlite";
import { currentProjectKey } from "../indexing/indexer.js";
import { isProjectionAvailable } from "../store/db.js";
import { getRuntimeConfig } from "../store/repository.js";
import { searchChunks } from "../retrieval/search.js";
import { AUTO_MAX_RECORDS, AUTO_MIN_TERM_COVERAGE } from "./constants.js";
import { buildRecallBundle, type EnvelopeRecord, type RecallBundle } from "./envelope.js";

/**
 * 自动召回检索门与 bundle 构建。
 */

export interface AutoRetrieveInput {
  prompt: string;
  cwd: string;
  currentSessionId: string;
  requestId: string;
}

export interface AutoRetrieveResult {
  bundle: RecallBundle | null;
  reason?: string;
}

/**
 * 在全部 gate 通过时构建非空 bundle；否则返回 null（no-hit / disabled）。
 */
export function autoRetrieve(db: DatabaseSync, input: AutoRetrieveInput): AutoRetrieveResult {
  const config = getRuntimeConfig(db);
  if (!config.setupCompleted) {
    return { bundle: null, reason: "setup-required" };
  }
  if (!config.autoRecall) {
    return { bundle: null, reason: "auto-off" };
  }
  if (!isProjectionAvailable(db)) {
    return {
      bundle: null,
      reason: config.projectionStatus === "partial" ? "rebuild-partial" : "projection-unavailable",
    };
  }

  let projectKey: string;
  try {
    projectKey = currentProjectKey(input.cwd);
  } catch {
    return { bundle: null, reason: "project-unresolved" };
  }

  const query = input.prompt.trim();
  if (query.length === 0) {
    return { bundle: null, reason: "empty-prompt" };
  }

  try {
    const result = searchChunks(db, query, {
      scope: "project",
      projectKey,
      excludeSessionId: input.currentSessionId,
      autoEligibleOnly: true,
      verifiedOnly: true,
      minTermCoverage: AUTO_MIN_TERM_COVERAGE,
      limit: AUTO_MAX_RECORDS,
      maxLimit: AUTO_MAX_RECORDS,
    });

    if (result.hits.length === 0) {
      return { bundle: null, reason: "no-hit" };
    }

    const records: EnvelopeRecord[] = result.hits.map((hit) => ({
      role: hit.role,
      occurredAt: hit.occurredAt,
      sessionId: hit.sessionId,
      entryId: hit.entryId,
      contentHash: hit.contentHash,
      text: hit.snippet,
      score: hit.score,
    }));

    const bundle = buildRecallBundle(input.requestId, query, records);
    if (!bundle) {
      return { bundle: null, reason: "budget-empty" };
    }
    return { bundle };
  } catch (error) {
    return {
      bundle: null,
      reason: error instanceof Error ? error.message : "retrieve-failed",
    };
  }
}
