import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  currentProjectKey,
  ensureRuntimeSessionRoot,
  purgeIndexData,
  rebuildIndex,
  setupIndex,
} from "../../core/indexing/indexer.js";
import { searchChunks } from "../../core/retrieval/search.js";
import { prepareDataHome } from "../../core/config/data-home.js";
import { readSchemaMeta } from "../../core/store/db.js";
import { resolveDataHome, resolveDbPath } from "../../core/store/paths.js";
import {
  countChunks,
  excludeSession,
  getRuntimeConfig,
  includeSession,
  listSessionRoots,
  updateRuntimeConfig,
} from "../../core/store/repository.js";
import { PACKAGE_NAME, PACKAGE_VERSION, PRODUCT_DEFAULTS } from "../../shared/package-meta.js";
import { formatHitsPlain } from "./format.js";
import { openDbRequired, rememberError, tryOpenDb, type ExtensionRuntime } from "./runtime.js";

/**
 * /recall 命令处理。
 */

/**
 * 注册 /recall。
 */
export function registerRecallCommand(
  pi: {
    registerCommand: (
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => void;
  },
  runtime: ExtensionRuntime,
): void {
  pi.registerCommand("recall", {
    description: "Session recall: setup/search/status/exclude/include/rebuild/purge-index",
    handler: async (args, ctx) => {
      try {
        await handleRecall(args.trim(), ctx, runtime);
      } catch (error) {
        rememberError(runtime, error);
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, message, "error");
      }
    },
  });
}

/**
 * 解析并执行子命令。
 */
export async function handleRecall(
  args: string,
  ctx: ExtensionCommandContext,
  runtime: ExtensionRuntime,
): Promise<void> {
  const [sub, ...rest] = splitArgs(args);
  if (!sub || sub === "help") {
    notify(ctx, recallHelp(), "info");
    return;
  }

  switch (sub) {
    case "setup":
      await cmdSetup(ctx, runtime);
      return;
    case "search":
      await cmdSearch(rest.join(" "), ctx, runtime);
      return;
    case "status":
      cmdStatus(ctx, runtime);
      return;
    case "config":
      await cmdConfig(rest, ctx, runtime);
      return;
    case "exclude-session":
      await cmdExclude(rest[0], ctx, runtime);
      return;
    case "include-session":
      cmdInclude(rest[0], ctx, runtime);
      return;
    case "rebuild":
      await cmdRebuild(ctx, runtime);
      return;
    case "purge-index":
      await cmdPurgeIndex(ctx, runtime);
      return;
    default:
      notify(ctx, `Unknown /recall subcommand: ${sub}\n${recallHelp()}`, "warning");
  }
}

async function cmdSetup(ctx: ExtensionCommandContext, runtime: ExtensionRuntime): Promise<void> {
  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm(
      "Setup session recall",
      [
        "This will create a local plaintext SQLite index.",
        "Original Pi session files are never modified.",
        "Continue?",
      ].join("\n"),
    );
    if (!ok) {
      notify(ctx, "Setup cancelled.", "info");
      return;
    }
  }

  prepareDataHome();
  const db = openDbRequired(runtime);
  const agentSessions = path.join(getAgentDir(), "sessions");
  const runtimeDir = ctx.sessionManager.getSessionDir();
  setupIndex(db, [
    { id: "agent-sessions", path: agentSessions, source: "agent-dir" },
    { id: "runtime-session-dir", path: runtimeDir, source: "runtime-session-dir" },
  ]);
  notify(
    ctx,
    [
      "Setup complete.",
      `dataHome: ${resolveDataHome()}`,
      "Indexing enabled. Background bounded scans will run after turns;",
      "for a full backfill run: pi-session-recall index",
    ].join("\n"),
    "info",
  );
}

async function cmdSearch(
  raw: string,
  ctx: ExtensionCommandContext,
  runtime: ExtensionRuntime,
): Promise<void> {
  const tokens = splitArgs(raw);
  let scopeAll = false;
  const queryParts: string[] = [];
  for (const token of tokens) {
    if (token === "--all") {
      scopeAll = true;
      continue;
    }
    queryParts.push(token);
  }
  const query = queryParts.join(" ").trim();
  if (!query) {
    notify(ctx, "Usage: /recall search [--all] <query>", "warning");
    return;
  }

  const db = tryOpenDb(runtime);
  if (!db) {
    notify(ctx, "Not set up. Run /recall setup", "warning");
    return;
  }
  const config = getRuntimeConfig(db);
  if (!config.setupCompleted) {
    notify(ctx, "Not set up. Run /recall setup", "warning");
    return;
  }

  const result = searchChunks(db, query, {
    scope: scopeAll ? "all" : "project",
    ...(scopeAll ? {} : { projectKey: currentProjectKey(ctx.cwd) }),
    limit: PRODUCT_DEFAULTS.manualSearchDefaultLimit,
    maxLimit: PRODUCT_DEFAULTS.manualSearchMaxLimit,
  });
  notify(ctx, formatHitsPlain(result.hits), "info");
}

function cmdStatus(ctx: ExtensionCommandContext, runtime: ExtensionRuntime): void {
  const db = tryOpenDb(runtime);
  if (!db) {
    notify(ctx, `${PACKAGE_NAME} not set up.\nRun /recall setup`, "info");
    return;
  }
  const config = getRuntimeConfig(db);
  const meta = readSchemaMeta(db);
  const roots = listSessionRoots(db);
  const lines = [
    `${PACKAGE_NAME} ${PACKAGE_VERSION}`,
    `setup: ${config.setupCompleted}`,
    `indexing: ${config.indexingEnabled}`,
    `autoRecall: ${config.autoRecall}`,
    `chunks: ${countChunks(db)}`,
    `schema: ${meta.schemaVersion} / fts: ${meta.ftsProjectionVersion}`,
    `dataHome: ${resolveDataHome()}`,
    `db: ${path.basename(resolveDbPath())}`,
    `projectKey: ${currentProjectKey(ctx.cwd).slice(0, 12)}…`,
    `roots: ${roots.length}`,
  ];
  notify(ctx, lines.join("\n"), "info");
}

async function cmdConfig(
  rest: string[],
  ctx: ExtensionCommandContext,
  runtime: ExtensionRuntime,
): Promise<void> {
  const db = tryOpenDb(runtime);
  if (!db) {
    notify(ctx, "Not set up. Run /recall setup", "warning");
    return;
  }
  if (rest.length === 0) {
    const config = getRuntimeConfig(db);
    notify(
      ctx,
      `indexing=${config.indexingEnabled} autoRecall=${config.autoRecall} manualLimit=${config.manualLimit}`,
      "info",
    );
    return;
  }
  if (rest[0] === "auto" && (rest[1] === "on" || rest[1] === "off")) {
    if (rest[1] === "on") {
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Enable auto recall?",
          [
            "When enabled, a small amount of related history may be temporarily",
            "injected into the provider context (not written to the session file).",
            "History is untrusted data. Continue?",
          ].join("\n"),
        );
        if (!ok) {
          notify(ctx, "Cancelled.", "info");
          return;
        }
      }
      updateRuntimeConfig(db, { autoRecall: true });
      notify(ctx, "autoRecall=true", "info");
      return;
    }
    updateRuntimeConfig(db, { autoRecall: false });
    notify(ctx, "autoRecall=false", "info");
    return;
  }
  notify(ctx, "Usage: /recall config [auto on|off]", "warning");
}

async function cmdExclude(
  target: string | undefined,
  ctx: ExtensionCommandContext,
  runtime: ExtensionRuntime,
): Promise<void> {
  const db = tryOpenDb(runtime);
  if (!db) {
    notify(ctx, "Not set up. Run /recall setup", "warning");
    return;
  }
  const sessionId = !target || target === "current" ? ctx.sessionManager.getSessionId() : target;
  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm("Exclude session", `Exclude ${sessionId} from index?`);
    if (!ok) {
      return;
    }
  }
  excludeSession(db, sessionId);
  notify(ctx, `Excluded ${sessionId}`, "info");
}

function cmdInclude(
  sessionId: string | undefined,
  ctx: ExtensionCommandContext,
  runtime: ExtensionRuntime,
): void {
  if (!sessionId) {
    notify(ctx, "Usage: /recall include-session <session-id>", "warning");
    return;
  }
  const db = tryOpenDb(runtime);
  if (!db) {
    notify(ctx, "Not set up. Run /recall setup", "warning");
    return;
  }
  includeSession(db, sessionId);
  notify(ctx, `Included ${sessionId}. Run /recall rebuild or wait for scans to reindex.`, "info");
}

async function cmdRebuild(ctx: ExtensionCommandContext, runtime: ExtensionRuntime): Promise<void> {
  const db = tryOpenDb(runtime);
  if (!db) {
    notify(ctx, "Not set up. Run /recall setup", "warning");
    return;
  }
  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm("Rebuild index", "Clear chunks and rebuild from roots?");
    if (!ok) {
      return;
    }
  }
  ensureRuntimeSessionRoot(db, ctx.sessionManager.getSessionDir());
  const result = rebuildIndex(db);
  notify(
    ctx,
    `Rebuild done. indexedSessions=${result.indexedSessions} chunks=${result.chunksUpserted}`,
    "info",
  );
}

async function cmdPurgeIndex(
  ctx: ExtensionCommandContext,
  runtime: ExtensionRuntime,
): Promise<void> {
  const db = tryOpenDb(runtime);
  if (!db) {
    notify(ctx, "Not set up. Run /recall setup", "warning");
    return;
  }
  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm(
      "Purge index",
      "Clear chunks/FTS/cursors and disable indexing/autoRecall?\nOriginal Pi sessions are NOT deleted.",
    );
    if (!ok) {
      return;
    }
  }
  purgeIndexData(db);
  notify(ctx, "Index purged. indexing/autoRecall disabled. Pi sessions untouched.", "info");
}

/**
 * 空格分词（保留简单形态）。
 */
export function splitArgs(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

function recallHelp(): string {
  return [
    "/recall setup",
    "/recall search [--all] <query>",
    "/recall status",
    "/recall config [auto on|off]",
    "/recall exclude-session <session-id|current>",
    "/recall include-session <session-id>",
    "/recall rebuild",
    "/recall purge-index",
  ].join("\n");
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  // print/json/rpc：hasUI 可能为 false，仍尽量 notify
  try {
    ctx.ui.notify(message, level);
  } catch {
    // fail-open
  }
}
