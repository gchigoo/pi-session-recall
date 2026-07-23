import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildEvalCorpus, type EvalQuery } from "../../evals/corpus.js";
import { autoRetrieve } from "../../src/core/injection/auto-retrieve.js";
import { runIndex, setupIndex } from "../../src/core/indexing/indexer.js";
import { resolveProjectIdentity } from "../../src/core/provenance/project-identity.js";
import { searchChunks } from "../../src/core/retrieval/search.js";
import { serializeSessionFixture } from "../../src/core/sessions/fixture-builder.js";
import { closeDatabase, openDatabase } from "../../src/core/store/db.js";
import { updateRuntimeConfig } from "../../src/core/store/repository.js";

/**
 * 固定 corpus eval（roadmap §9.3）。
 */

const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-eval-"));
const rootDir = path.join(dataHome, "sessions");
fs.mkdirSync(rootDir, { recursive: true });
process.env.PI_SESSION_RECALL_HOME = dataHome;

const { plants, queries } = buildEvalCorpus();

for (const plant of plants) {
  const entries: Array<{
    id: string;
    parentId: string | null;
    role: "user" | "assistant";
    text: string;
  }> = [{ id: plant.entryId, parentId: null, role: plant.role, text: plant.text }];
  let parent = plant.entryId;
  for (const follow of plant.followUps ?? []) {
    entries.push({
      id: follow.entryId,
      parentId: parent,
      role: follow.role,
      text: follow.text,
    });
    parent = follow.entryId;
  }
  fs.writeFileSync(
    path.join(rootDir, `${plant.sessionId}.jsonl`),
    serializeSessionFixture({
      name: plant.sessionId,
      header: { id: plant.sessionId, cwd: plant.cwd },
      entries,
    }),
    "utf8",
  );
}

const db = openDatabase({ dataHome });
setupIndex(db, [{ id: "eval", path: rootDir, source: "user-added" }]);
runIndex(db, { forceFull: true });
updateRuntimeConfig(db, { autoRecall: true });

interface QueryScore {
  id: string;
  holdout: boolean;
  category: string;
  hit: boolean;
  leakage: boolean;
  secretLeak: boolean;
}

function scoreQuery(q: EvalQuery): QueryScore {
  const projectKey = resolveProjectIdentity(q.cwd).projectKey;
  const result = searchChunks(db, q.query, {
    scope: q.scope,
    ...(q.scope === "project" ? { projectKey } : {}),
    limit: 5,
  });

  let leakage = false;
  if (q.forbidLeakFromCwd) {
    const forbidden = resolveProjectIdentity(q.forbidLeakFromCwd).projectKey;
    leakage = result.hits.some((hit) => hit.originProjectKey === forbidden);
  }

  let secretLeak = false;
  if (q.forbidSubstring) {
    secretLeak = result.hits.some((hit) => hit.snippet.includes(q.forbidSubstring!));
  }

  if (q.expectNoHit) {
    return {
      id: q.id,
      holdout: q.holdout,
      category: q.category,
      hit: result.hits.length === 0 && !leakage,
      leakage,
      secretLeak,
    };
  }

  const relevant = new Set(q.relevantEntryIds ?? []);
  const hit = result.hits.some((item) => relevant.has(item.entryId));
  return {
    id: q.id,
    holdout: q.holdout,
    category: q.category,
    hit: hit && !leakage && !secretLeak,
    leakage,
    secretLeak,
  };
}

const scored = queries.map(scoreQuery);
const scoredCategories = ["exact", "cjk", "code"] as const;
const mainPool = scored.filter((s) =>
  scoredCategories.includes(s.category as (typeof scoredCategories)[number]),
);
const holdoutPool = scored.filter((s) => s.holdout);
const recall = (pool: QueryScore[]) =>
  pool.length === 0 ? 0 : pool.filter((s) => s.hit).length / pool.length;

const mainRecall = recall(mainPool);
const holdoutRecall = recall(holdoutPool);
const leakageCount = scored.filter((s) => s.leakage).length;
const secretLeaks = scored.filter((s) => s.secretLeak).length;

// no-hit auto inject rate
const autoProbes = queries.filter((q) => q.autoProbe && q.expectNoHit);
let autoInjects = 0;
for (const q of autoProbes) {
  const retrieved = autoRetrieve(db, {
    prompt: q.query,
    cwd: q.cwd,
    currentSessionId: "eval-current-session",
    requestId: `auto-${q.id}`,
  });
  if (retrieved.bundle) {
    autoInjects += 1;
  }
}
const autoInjectRate = autoProbes.length === 0 ? 0 : autoInjects / autoProbes.length;

// determinism：同一 snapshot 连续 5 次 ID 顺序一致
const detQuery = queries.find((q) => q.category === "exact" && !q.expectNoHit)!;
const detKey = resolveProjectIdentity(detQuery.cwd).projectKey;
const snapshots: string[] = [];
for (let i = 0; i < 5; i += 1) {
  const hits = searchChunks(db, detQuery.query, {
    scope: "project",
    projectKey: detKey,
    limit: 5,
  }).hits;
  snapshots.push(hits.map((h) => `${h.sessionId}:${h.entryId}`).join("|"));
}
const deterministic = snapshots.every((s) => s === snapshots[0]);

// provider spy：本 eval 路径不触达 provider（固定 0）
const providerCalls = 0;

closeDatabase(db);
fs.rmSync(dataHome, { recursive: true, force: true });

const holdoutCount = queries.filter((q) => q.holdout).length;
const failed = scored.filter((s) => !s.hit).map((s) => s.id);
const report = {
  ok:
    queries.length >= 60 &&
    holdoutCount === 20 &&
    mainRecall >= 0.9 &&
    holdoutRecall >= 0.85 &&
    leakageCount === 0 &&
    secretLeaks === 0 &&
    autoInjectRate <= 0.05 &&
    deterministic &&
    providerCalls === 0 &&
    failed.length === 0,
  corpusSize: queries.length,
  holdoutCount,
  mainRecallAt5: Number(mainRecall.toFixed(4)),
  holdoutRecallAt5: Number(holdoutRecall.toFixed(4)),
  scopeLeakage: leakageCount,
  secretLeaks,
  autoInjectRate: Number(autoInjectRate.toFixed(4)),
  deterministic,
  providerCalls,
  failed,
  gates: {
    mainRecallAt5: ">=0.90",
    holdoutRecallAt5: ">=0.85",
    scopeLeakage: "=0",
    autoInjectRate: "<=0.05",
    deterministic: "5x identical",
    providerCalls: "=0",
    allQueriesPass: true,
  },
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  process.exitCode = 1;
}
