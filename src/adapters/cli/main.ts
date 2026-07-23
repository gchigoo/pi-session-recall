import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareDataHome, purgeDataHome } from "../../core/config/data-home.js";
import { diagnoseDataHome } from "../../core/diagnostics/data-home-health.js";
import { mapSqliteError } from "../../core/diagnostics/sqlite-errors.js";
import {
  currentProjectKey,
  purgeIndexData,
  rebuildIndex,
  runIndex,
  setupIndex,
} from "../../core/indexing/indexer.js";
import { searchChunks, type SearchOptions } from "../../core/retrieval/search.js";
import { closeDatabase, openDatabase, readSchemaMeta } from "../../core/store/db.js";
import { resolveDataHome, resolveDbPath } from "../../core/store/paths.js";
import { checkProjectionIntegrity } from "../../core/store/projection.js";
import {
  countChunks,
  excludeSession,
  getRuntimeConfig,
  includeSession,
  listSessionRoots,
} from "../../core/store/repository.js";
import { IMPLEMENTATION_PHASE, PACKAGE_NAME, PACKAGE_VERSION } from "../../shared/package-meta.js";

/**
 * Companion CLI：setup / index / search / status / rebuild / purge。
 */

/**
 * CLI 主入口。
 */
export async function runCli(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const command = args[0];

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return 0;
  }
  if (command === "--version" || command === "-V" || command === "version") {
    console.log(`${PACKAGE_NAME} ${PACKAGE_VERSION} (${IMPLEMENTATION_PHASE})`);
    return 0;
  }

  try {
    switch (command) {
      case "setup":
        return cmdSetup(args.slice(1));
      case "index":
        return cmdIndex(args.slice(1));
      case "search":
        return cmdSearch(args.slice(1));
      case "status":
        return cmdStatus(args.slice(1));
      case "exclude-session":
        return cmdExclude(args.slice(1));
      case "include-session":
        return cmdInclude(args.slice(1));
      case "rebuild":
        return cmdRebuild();
      case "purge-index":
        return cmdPurgeIndex();
      case "purge-data":
        return cmdPurgeData();
      case "probe":
        console.log(
          JSON.stringify(
            {
              package: PACKAGE_NAME,
              version: PACKAGE_VERSION,
              phase: IMPLEMENTATION_PHASE,
              dataHome: resolveDataHome(),
            },
            null,
            2,
          ),
        );
        return 0;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        return 1;
    }
  } catch (error) {
    const code = mapSqliteError(error);
    console.error(JSON.stringify({ ok: false, error: code }));
    return 1;
  }
}

/**
 * setup [--root <dir>]...
 */
function cmdSetup(args: string[]): number {
  const roots = parseRoots(args);
  const dataHome = prepareDataHome();
  const db = openDatabase({ dataHome });
  try {
    const defaultRoot =
      roots.length > 0
        ? roots
        : [
            {
              id: "agent-sessions",
              path: path.join(os.homedir(), ".pi", "agent", "sessions"),
              source: "agent-dir" as const,
            },
          ];
    setupIndex(db, defaultRoot);
    console.log(
      JSON.stringify(
        {
          ok: true,
          dataHome,
          dbPath: resolveDbPath(dataHome),
          roots: listSessionRoots(db),
          note: "Index is a plaintext local copy. Original Pi sessions are never modified. Run: pi-session-recall index",
        },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    closeDatabase(db);
  }
}

/**
 * index [--root <dir>]
 */
function cmdIndex(args: string[]): number {
  const root = readOption(args, "--root");
  const db = openDatabase();
  try {
    const indexOptions = root ? { rootPath: root } : {};
    const result = runIndex(db, indexOptions);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return 0;
  } finally {
    closeDatabase(db);
  }
}

/**
 * search <query> [--scope project|all] [--json] [--limit n]
 */
function cmdSearch(args: string[]): number {
  const scope = (readOption(args, "--scope") as "project" | "all" | undefined) ?? "project";
  const limitRaw = readOption(args, "--limit");
  const asJson = args.includes("--json");
  const query = collectQuery(args);
  if (!query) {
    console.error("usage: pi-session-recall search <query> [--scope project|all] [--json]");
    return 1;
  }
  const db = openDatabase();
  try {
    const searchOptions: SearchOptions = { scope };
    if (limitRaw) {
      searchOptions.limit = Number(limitRaw);
    }
    if (scope === "project") {
      searchOptions.projectKey = currentProjectKey();
    }
    const result = searchChunks(db, query, searchOptions);
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const hit of result.hits) {
        const flag = hit.truncated ? " [truncated]" : "";
        console.log(
          `${hit.sessionId} ${hit.entryId} ${hit.role} ${hit.occurredAt}${flag}\n  ${hit.snippet}\n`,
        );
      }
      if (result.hits.length === 0) {
        console.log("No hits.");
      }
    }
    return 0;
  } finally {
    closeDatabase(db);
  }
}

/**
 * status [--json]
 */
function cmdStatus(args: string[]): number {
  const asJson = args.includes("--json");
  const dataHome = resolveDataHome();
  const dbPath = resolveDbPath(dataHome);
  if (!fs.existsSync(dbPath)) {
    const payload = { ok: false, setupCompleted: false, dataHome };
    console.log(
      asJson ? JSON.stringify(payload, null, 2) : "Not set up. Run: pi-session-recall setup",
    );
    return 0;
  }
  const db = openDatabase({ dataHome });
  try {
    const health = diagnoseDataHome(dataHome);
    const projection = checkProjectionIntegrity(db);
    const payload = {
      ok: health.ok && projection.ok,
      dataHome,
      dbPath,
      meta: readSchemaMeta(db),
      config: getRuntimeConfig(db),
      roots: listSessionRoots(db),
      chunkCount: countChunks(db),
      currentProjectKey: currentProjectKey(),
      health,
      projection,
    };
    console.log(asJson ? JSON.stringify(payload, null, 2) : formatStatus(payload));
    return 0;
  } finally {
    closeDatabase(db);
  }
}

function cmdExclude(args: string[]): number {
  const sessionId = args[0];
  if (!sessionId) {
    console.error("usage: pi-session-recall exclude-session <session-id>");
    return 1;
  }
  const db = openDatabase();
  try {
    excludeSession(db, sessionId);
    console.log(JSON.stringify({ ok: true, excluded: sessionId }, null, 2));
    return 0;
  } finally {
    closeDatabase(db);
  }
}

function cmdInclude(args: string[]): number {
  const sessionId = args[0];
  if (!sessionId) {
    console.error("usage: pi-session-recall include-session <session-id>");
    return 1;
  }
  const db = openDatabase();
  try {
    includeSession(db, sessionId);
    console.log(JSON.stringify({ ok: true, included: sessionId }, null, 2));
    return 0;
  } finally {
    closeDatabase(db);
  }
}

function cmdRebuild(): number {
  const db = openDatabase();
  try {
    const result = rebuildIndex(db);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return 0;
  } finally {
    closeDatabase(db);
  }
}

function cmdPurgeIndex(): number {
  const db = openDatabase();
  try {
    purgeIndexData(db);
    const config = getRuntimeConfig(db);
    console.log(
      JSON.stringify(
        {
          ok: true,
          purged: true,
          indexingEnabled: config.indexingEnabled,
          autoRecall: config.autoRecall,
          note: "Chunks/FTS/cursors cleared. Original Pi sessions were NOT deleted.",
        },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    closeDatabase(db);
  }
}

function cmdPurgeData(): number {
  const result = purgeDataHome();
  console.log(
    JSON.stringify(
      {
        ok: true,
        ...result,
        restartRequired: true,
        note: "Extension data-home removed. Restart process before setup. Pi sessions NOT deleted.",
      },
      null,
      2,
    ),
  );
  return 0;
}

/**
 * 解析重复 --root。
 */
function parseRoots(args: string[]): Array<{ id: string; path: string; source: "user-added" }> {
  const roots: Array<{ id: string; path: string; source: "user-added" }> = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root" && args[i + 1]) {
      const rootPath = path.resolve(args[i + 1]!);
      roots.push({
        id: `user-${Buffer.from(rootPath).toString("hex").slice(0, 12)}`,
        path: rootPath,
        source: "user-added",
      });
      i += 1;
    }
  }
  return roots;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1]!.startsWith("--")) {
    return args[index + 1];
  }
  return undefined;
}

/**
 * 收集 search 查询字符串。
 */
function collectQuery(args: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i]!;
    if (item === "--scope" || item === "--limit") {
      i += 1;
      continue;
    }
    if (item === "--json") {
      continue;
    }
    if (item.startsWith("--")) {
      continue;
    }
    parts.push(item);
  }
  return parts.join(" ").trim();
}

function formatStatus(payload: {
  dataHome: string;
  config: {
    setupCompleted: boolean;
    indexingEnabled: boolean;
    autoRecall: boolean;
    projectionStatus: string;
  };
  chunkCount: number;
  roots: Array<{ path: string; enabled: boolean }>;
  projection?: { ok: boolean; status: string };
  health?: { ok: boolean };
}): string {
  return [
    `${PACKAGE_NAME} ${PACKAGE_VERSION} (${IMPLEMENTATION_PHASE})`,
    `dataHome: ${payload.dataHome}`,
    `setup: ${payload.config.setupCompleted}`,
    `indexing: ${payload.config.indexingEnabled}`,
    `autoRecall: ${payload.config.autoRecall}`,
    `projection: ${payload.config.projectionStatus}${payload.projection ? ` ok=${payload.projection.ok}` : ""}`,
    `health: ${payload.health ? (payload.health.ok ? "ok" : "issues") : "n/a"}`,
    `chunks: ${payload.chunkCount}`,
    `roots: ${payload.roots.length}`,
    ...payload.roots.map((root) => `  - ${root.enabled ? "on" : "off"} ${root.path}`),
  ].join("\n");
}

/**
 * 打印用法。
 */
function printHelp(): void {
  console.log(`${PACKAGE_NAME} ${PACKAGE_VERSION} (${IMPLEMENTATION_PHASE})

Usage:
  pi-session-recall setup [--root <dir>]...
  pi-session-recall index [--root <dir>]
  pi-session-recall search <query> [--scope project|all] [--limit n] [--json]
  pi-session-recall status [--json]
  pi-session-recall exclude-session <session-id>
  pi-session-recall include-session <session-id>
  pi-session-recall rebuild
  pi-session-recall purge-index
  pi-session-recall purge-data

Notes:
  - Install does not scan history; setup is required.
  - Default search scope is current project.
  - purge-index: clear chunks/FTS/cursors; keep data-home; disable indexing/auto.
  - purge-data: delete entire extension data-home; restart process before setup.
  - Neither purge nor package remove deletes original Pi JSONL sessions.
  - Index purge ≠ package remove ≠ deleting Pi session JSONL.
`);
}
