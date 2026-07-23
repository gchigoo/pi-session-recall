import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupIndex, runIndex } from "../../src/core/indexing/indexer.js";
import { searchChunks } from "../../src/core/retrieval/search.js";
import { closeDatabase, openDatabase } from "../../src/core/store/db.js";
import { countChunks } from "../../src/core/store/repository.js";
import { serializeSessionFixture } from "../../src/core/sessions/fixture-builder.js";

/**
 * 10k chunks smoke benchmark（P2 阶段门，非正式 100k）。
 */
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-bench-"));
const rootDir = path.join(dataHome, "sessions");
fs.mkdirSync(rootDir, { recursive: true });
process.env.PI_SESSION_RECALL_HOME = dataHome;

const TARGET_CHUNKS = 10_000;
const QUERY_COUNT = 200;

let written = 0;
let fileIndex = 0;
while (written < TARGET_CHUNKS) {
  const entries = [];
  let parent: string | null = null;
  for (let i = 0; i < 50 && written < TARGET_CHUNKS; i += 1) {
    const id = `e${fileIndex.toString(16).padStart(4, "0")}${i.toString(16).padStart(4, "0")}`;
    entries.push({
      id,
      parentId: parent,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `doc-${written} keyword-${written % 97} 认证检索 mixed-${written % 13}`,
    });
    parent = id;
    written += 1;
  }
  fs.writeFileSync(
    path.join(rootDir, `s-${fileIndex}.jsonl`),
    serializeSessionFixture({
      name: `s-${fileIndex}`,
      header: {
        id: `${fileIndex.toString().padStart(8, "0")}-0000-4000-8000-000000000000`,
        cwd: "/tmp/pi-session-recall-fixtures/project-a",
      },
      entries,
    }),
    "utf8",
  );
  fileIndex += 1;
}

const db = openDatabase({ dataHome });
const t0 = performance.now();
setupIndex(db, [{ id: "bench", path: rootDir, source: "user-added" }]);
runIndex(db, { forceFull: true });
const indexMs = performance.now() - t0;
const chunkCount = countChunks(db);

// warmup：排除冷启动
for (let i = 0; i < 20; i += 1) {
  searchChunks(db, i % 2 === 0 ? `keyword-${i % 97}` : "认证", { scope: "all", limit: 5 });
}

const latencies: number[] = [];
for (let i = 0; i < QUERY_COUNT; i += 1) {
  const q = i % 2 === 0 ? `keyword-${i % 97}` : "认证";
  const start = performance.now();
  searchChunks(db, q, { scope: "all", limit: 5 });
  latencies.push(performance.now() - start);
}
latencies.sort((a, b) => a - b);
const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

closeDatabase(db);
fs.rmSync(dataHome, { recursive: true, force: true });

// P2 smoke 门：正式 100k/p95<=100ms 留到 P6
const report = {
  ok: chunkCount >= TARGET_CHUNKS && p95 <= 300,
  chunkCount,
  indexMs: Number(indexMs.toFixed(2)),
  queries: QUERY_COUNT,
  p95Ms: Number(p95.toFixed(2)),
  gate: "p95<=300ms warm for 10k smoke (P2)",
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  process.exitCode = 1;
}
