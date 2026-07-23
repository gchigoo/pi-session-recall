import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { currentProjectKey } from "../../core/indexing/indexer.js";
import { searchChunks } from "../../core/retrieval/search.js";
import { getRuntimeConfig } from "../../core/store/repository.js";
import { PRODUCT_DEFAULTS } from "../../shared/package-meta.js";
import { toSafeToolHits } from "./format.js";
import { rememberError, tryOpenDb, type ExtensionRuntime } from "./runtime.js";

/**
 * 只读 session_recall tool：固定 current project，无 all-project 参数。
 * 工具结果会进入当前 Pi session；未来索引因 role=toolResult 排除。
 */

/**
 * 创建 tool 定义。
 */
export function createSessionRecallTool(runtime: ExtensionRuntime) {
  return defineTool({
    name: "session_recall",
    label: "Session Recall",
    description:
      "Search prior sessions in the current project only. Returns sessionId/entryId/role/time/snippet. Does not search all projects. Results persist in this session as tool output and are not re-indexed.",
    promptSnippet: "Search current-project session history (read-only)",
    parameters: Type.Object({
      query: Type.String({ description: "Search query (1-500 scalars)" }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: PRODUCT_DEFAULTS.toolSearchMaxLimit,
          description: `Max results (1-${PRODUCT_DEFAULTS.toolSearchMaxLimit}, default ${PRODUCT_DEFAULTS.toolSearchDefaultLimit})`,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const db = tryOpenDb(runtime);
        if (!db) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "setup-required",
                  message: "Run /recall setup first",
                }),
              },
            ],
            details: {},
          };
        }
        const config = getRuntimeConfig(db);
        if (!config.setupCompleted) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "setup-required" }),
              },
            ],
            details: {},
          };
        }

        const limit = params.limit ?? PRODUCT_DEFAULTS.toolSearchDefaultLimit;
        const result = searchChunks(db, params.query, {
          scope: "project",
          projectKey: currentProjectKey(ctx.cwd),
          limit,
          maxLimit: PRODUCT_DEFAULTS.toolSearchMaxLimit,
        });
        const hits = toSafeToolHits(result.hits);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ hits }) }],
          details: { count: hits.length },
        };
      } catch (error) {
        rememberError(runtime, error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : "search-failed",
              }),
            },
          ],
          details: { error: true },
        };
      }
    },
  });
}
