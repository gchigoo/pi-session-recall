import type { SearchHit } from "../../core/retrieval/search.js";

/**
 * 安全渲染搜索结果：plain text，不含 path，显式 truncated。
 */

export interface SafeToolHit {
  sessionId: string;
  entryId: string;
  role: string;
  occurredAt: string;
  snippet: string;
  truncated: boolean;
}

/**
 * 将 hit 转为 tool 安全 JSON（剥离 path/score/sourceKey 等内部字段）。
 */
export function toSafeToolHits(hits: SearchHit[]): SafeToolHit[] {
  return hits.map((hit) => ({
    sessionId: hit.sessionId,
    entryId: hit.entryId,
    role: hit.role,
    occurredAt: hit.occurredAt,
    snippet: sanitizeSnippet(hit.snippet),
    truncated: hit.truncated,
  }));
}

/**
 * TUI/print 纯文本渲染。
 */
export function formatHitsPlain(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return "No hits.";
  }
  return hits
    .map((hit) => {
      const flag = hit.truncated ? " [truncated]" : "";
      const snippet = sanitizeSnippet(hit.snippet);
      return `${hit.sessionId}  ${hit.entryId}  ${hit.role}  ${hit.occurredAt}${flag}\n  ${snippet}`;
    })
    .join("\n\n");
}

/**
 * 去掉 ANSI / 控制字符，避免历史文本污染终端。
 */
export function sanitizeSnippet(text: string): string {
  // 有意匹配控制字符；禁用 no-control-regex
  /* eslint-disable no-control-regex -- strip terminal control sequences from untrusted history text */
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  /* eslint-enable no-control-regex */
}

/**
 * 断言对象不含 path 字段（测试用）。
 */
export function assertNoPathLeak(value: unknown): void {
  const json = JSON.stringify(value);
  if (/"path"\s*:/.test(json) || /\\\\|\/home\/|\/Users\/|[A-Za-z]:\\/.test(json)) {
    // 允许 snippet 内偶然出现类路径片段；仅拦截明确 path 键
    if (/"path"\s*:/.test(json)) {
      throw new Error("path-leak");
    }
  }
}
