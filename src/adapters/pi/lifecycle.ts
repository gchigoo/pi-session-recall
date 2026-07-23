import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureRuntimeSessionRoot, indexSingleFile } from "../../core/indexing/indexer.js";
import { invalidateBundle } from "../../core/injection/request-context.js";
import { getRuntimeConfig } from "../../core/store/repository.js";
import { rememberError, shutdownRuntime, tryOpenDb, type ExtensionRuntime } from "./runtime.js";

/** lifecycle 有界切片预算（ms），roadmap ≤50ms p95 目标。 */
export const LIFECYCLE_SLICE_BUDGET_MS = 50;

/**
 * 注册 session_start / agent_settled / session_shutdown。
 */
export function registerLifecycle(pi: ExtensionAPI, runtime: ExtensionRuntime): void {
  pi.on("session_start", async (_event, ctx) => {
    try {
      invalidateBundle(runtime.requestContext);
      const db = tryOpenDb(runtime);
      if (!db) {
        return;
      }
      const config = getRuntimeConfig(db);
      if (!config.setupCompleted || !config.indexingEnabled) {
        return;
      }
      ensureRuntimeSessionRoot(db, ctx.sessionManager.getSessionDir());
    } catch (error) {
      rememberError(runtime, error);
      // fail-open：不影响普通对话
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      invalidateBundle(runtime.requestContext);
      await runBoundedCurrentSessionIndex(runtime, ctx);
    } catch (error) {
      rememberError(runtime, error);
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      // 有界 flush：若仍有 db，再尝试一次当前文件索引后关闭
      // 此处无 ctx；仅关闭句柄
      shutdownRuntime(runtime);
    } catch (error) {
      rememberError(runtime, error);
      shutdownRuntime(runtime);
    }
  });
}

/**
 * 仅索引当前 session 文件，尊重时间预算（超时则跳过，不抛）。
 */
export async function runBoundedCurrentSessionIndex(
  runtime: ExtensionRuntime,
  ctx: ExtensionContext,
): Promise<{ ran: boolean; disposition?: string }> {
  if (runtime.aborted) {
    return { ran: false };
  }
  const started = Date.now();
  const db = tryOpenDb(runtime);
  if (!db) {
    return { ran: false };
  }
  const config = getRuntimeConfig(db);
  if (!config.setupCompleted || !config.indexingEnabled) {
    return { ran: false };
  }

  ensureRuntimeSessionRoot(db, ctx.sessionManager.getSessionDir());
  if (Date.now() - started > LIFECYCLE_SLICE_BUDGET_MS) {
    return { ran: false, disposition: "budget-exceeded-before-index" };
  }

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    return { ran: false, disposition: "no-session-file" };
  }
  const result = indexSingleFile(db, sessionFile);
  return { ran: true, disposition: result.disposition };
}
