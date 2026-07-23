import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { indexSingleFile, runIndex, setupIndex } from "../../src/core/indexing/indexer.js";
import { searchChunks } from "../../src/core/retrieval/search.js";
import { serializeSessionFixture } from "../../src/core/sessions/fixture-builder.js";
import { closeDatabase, openDatabase } from "../../src/core/store/db.js";
import { countChunks } from "../../src/core/store/repository.js";

/**
 * 100k chunks warm search benchmark（roadmap §9.4）。
 */

const TARGET_CHUNKS = 100_000;
const PROJECT_COUNT = 20;
const QUERY_COUNT = 1_000;
const WARMUP = 50;

const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-bench100k-"));
const rootDir = path.join(dataHome, "sessions");
fs.mkdirSync(rootDir, { recursive: true });
process.env.PI_SESSION_RECALL_HOME = dataHome;

let written = 0;
let fileIndex = 0;
const cjkPool = ["认证", "网关", "检索", "索引", "会话", "权限", "分词", "召回"];
while (written < TARGET_CHUNKS) {
  const project = fileIndex % PROJECT_COUNT;
  const entries = [];
  let parent: string | null = null;
  // 更大文件减少 IO；CJK 仅稀疏出现，避免全库同词压垮 FTS
  for (let i = 0; i < 200 && written < TARGET_CHUNKS; i += 1) {
    const id = `${fileIndex.toString(16).padStart(4, "0")}${i.toString(16).padStart(4, "0")}`;
    const cjk = written % 20 === 0 ? cjkPool[written % cjkPool.length]! : "普通";
    entries.push({
      id,
      parentId: parent,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `p${project} doc-${written} keyword-${written % 997} ${cjk}内容 symbol-${written % 53} file_name_${written % 17}.ts`,
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
        cwd: `/tmp/pi-session-recall-bench/project-${project}`,
      },
      entries,
    }),
    "utf8",
  );
  fileIndex += 1;
}

const db = openDatabase({ dataHome });
const indexStart = performance.now();
setupIndex(db, [{ id: "bench", path: rootDir, source: "user-added" }]);
runIndex(db, { forceFull: true });
const indexMs = performance.now() - indexStart;
const chunkCount = countChunks(db);

// session_start 风格：再次打开（不含首次 migration 的冷路径近似）
closeDatabase(db);
const openLatencies: number[] = [];
for (let i = 0; i < 30; i += 1) {
  const t0 = performance.now();
  const reopen = openDatabase({ dataHome });
  openLatencies.push(performance.now() - t0);
  closeDatabase(reopen);
}
openLatencies.sort((a, b) => a - b);
const sessionStartP95 = openLatencies[Math.floor(openLatencies.length * 0.95)] ?? 0;

const db2 = openDatabase({ dataHome });

// lifecycle slice：单文件增量
const sampleFile = path.join(rootDir, "s-0.jsonl");
const sliceLatencies: number[] = [];
for (let i = 0; i < 40; i += 1) {
  const t0 = performance.now();
  indexSingleFile(db2, sampleFile);
  sliceLatencies.push(performance.now() - t0);
}
sliceLatencies.sort((a, b) => a - b);
const lifecycleP95 = sliceLatencies[Math.floor(sliceLatencies.length * 0.95)] ?? 0;

const queryAt = (i: number): string => {
  if (i % 5 === 0) {
    return cjkPool[i % cjkPool.length]!;
  }
  if (i % 5 === 1) {
    return `symbol-${i % 53}`;
  }
  return `keyword-${i % 997}`;
};

for (let i = 0; i < WARMUP; i += 1) {
  searchChunks(db2, queryAt(i), { scope: "all", limit: 5 });
}

const latencies: number[] = [];
for (let i = 0; i < QUERY_COUNT; i += 1) {
  const q = queryAt(i);
  const start = performance.now();
  searchChunks(db2, q, { scope: "all", limit: 5 });
  latencies.push(performance.now() - start);
}
latencies.sort((a, b) => a - b);
const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;

closeDatabase(db2);

const dbBytes = fs.existsSync(path.join(dataHome, "index.sqlite"))
  ? fs.statSync(path.join(dataHome, "index.sqlite")).size
  : 0;

fs.rmSync(dataHome, { recursive: true, force: true });

const report = {
  ok: chunkCount >= TARGET_CHUNKS && p95 <= 100 && sessionStartP95 <= 100 && lifecycleP95 <= 50,
  env: {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    ramGb: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
    node: process.version,
    sqlite: "node:sqlite",
    filesystem: path.parse(os.tmpdir()).root,
    indexConfig: "fts-v1-content-cjkbigram WAL busy_timeout=1000",
  },
  chunkCount,
  projects: PROJECT_COUNT,
  indexMs: Number(indexMs.toFixed(2)),
  dbBytes,
  queries: QUERY_COUNT,
  warmP50Ms: Number(p50.toFixed(2)),
  warmP95Ms: Number(p95.toFixed(2)),
  sessionStartP95Ms: Number(sessionStartP95.toFixed(2)),
  lifecycleSliceP95Ms: Number(lifecycleP95.toFixed(2)),
  gates: {
    warmSearchP95: "<=100ms",
    sessionStartP95: "<=100ms",
    lifecycleSliceP95: "<=50ms",
  },
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  process.exitCode = 1;
}
