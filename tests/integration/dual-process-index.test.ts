import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeSessionFixture } from "../../src/core/sessions/fixture-builder.js";
import { closeDatabase, openDatabase } from "../../src/core/store/db.js";
import { countChunks } from "../../src/core/store/repository.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runWorker(dataHome: string, rootDir: string): Promise<number> {
  return new Promise((resolve) => {
    const tsWorker = path.join(dataHome, `worker-${process.pid}-${Math.random()}.ts`);
    const indexer = `${repoRoot.replaceAll("\\", "/")}/src/core/indexing/indexer.ts`;
    const dbMod = `${repoRoot.replaceAll("\\", "/")}/src/core/store/db.ts`;
    fs.writeFileSync(
      tsWorker,
      `
import { runIndex, setupIndex } from ${JSON.stringify(indexer)};
import { closeDatabase, openDatabase } from ${JSON.stringify(dbMod)};
const dataHome = process.env.PI_SESSION_RECALL_HOME!;
const root = process.env.PSR_ROOT!;
const db = openDatabase({ dataHome });
try {
  setupIndex(db, [{ id: "r1", path: root, source: "user-added" }]);
} catch {
  // already setup / race
}
try {
  runIndex(db);
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  if (!msg.includes("busy") && !msg.includes("locked") && !msg.includes("db-busy")) {
    throw error;
  }
}
closeDatabase(db);
`,
      "utf8",
    );
    const child = spawn("npx", ["tsx", tsWorker], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PI_SESSION_RECALL_HOME: dataHome,
        PSR_ROOT: rootDir,
      },
      shell: process.platform === "win32",
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

describe("dual-process index safety", () => {
  let dataHome: string;
  let rootDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-dual-"));
    rootDir = path.join(dataHome, "sessions");
    fs.mkdirSync(rootDir, { recursive: true });
    previousHome = process.env.PI_SESSION_RECALL_HOME;
    process.env.PI_SESSION_RECALL_HOME = dataHome;

    for (let i = 0; i < 8; i += 1) {
      fs.writeFileSync(
        path.join(rootDir, `s${i}.jsonl`),
        serializeSessionFixture({
          name: `s${i}`,
          header: {
            id: `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa${i}`,
            cwd: "/tmp/pi-session-recall-fixtures/project-a",
          },
          entries: [
            {
              id: `e${i}e${i}e${i}e${i}`,
              parentId: null,
              role: "user",
              text: `dual-process-term-${i}`,
            },
          ],
        }),
        "utf8",
      );
    }
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.PI_SESSION_RECALL_HOME;
    } else {
      process.env.PI_SESSION_RECALL_HOME = previousHome;
    }
    try {
      fs.rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("two writers produce no duplicate canonical rows", async () => {
    const [codeA, codeB] = await Promise.all([
      runWorker(dataHome, rootDir),
      runWorker(dataHome, rootDir),
    ]);
    expect(codeA === 0 || codeB === 0).toBe(true);

    const db = openDatabase({ dataHome });
    expect(countChunks(db)).toBeGreaterThan(0);
    const dup = db
      .prepare(
        `SELECT source_key, content_hash, policy_version, COUNT(*) AS n
         FROM chunks GROUP BY 1,2,3 HAVING n > 1`,
      )
      .all() as unknown[];
    expect(dup).toHaveLength(0);
    closeDatabase(db);
  }, 120_000);
});
