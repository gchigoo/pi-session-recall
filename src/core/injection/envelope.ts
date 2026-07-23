import { estimateEnvelopeTokens } from "./estimator.js";
import {
  AUTO_MAX_ESTIMATED_TOKENS,
  AUTO_MAX_RECORDS,
  ENVELOPE_END,
  ENVELOPE_START,
  ENVELOPE_VERSION,
} from "./constants.js";

/**
 * Versioned Recall Envelope 构建与预算裁剪。
 */

export interface EnvelopeRecord {
  role: string;
  occurredAt: string;
  sessionId: string;
  entryId: string;
  contentHash: string;
  text: string;
  score: number;
}

export interface RecallBundle {
  requestId: string;
  prompt: string;
  records: EnvelopeRecord[];
  envelopeText: string;
  estimatedTokens: number;
  trustRuleAppended: boolean;
}

/**
 * 转义正文中的冲突 marker 字符序列。
 */
export function escapeEnvelopeMarkers(text: string): string {
  return text
    .replaceAll("[[pi-session-recall:envelope:v1]]", "[[pi-session-recall\\:envelope\\:v1]]")
    .replaceAll("[[/pi-session-recall:envelope:v1]]", "[[/pi-session-recall\\:envelope\\:v1]]");
}

/**
 * 按 4 records / 600 tokens 从最低分开始移除，构建 envelope。
 */
export function buildRecallBundle(
  requestId: string,
  prompt: string,
  ranked: EnvelopeRecord[],
): RecallBundle | null {
  const sorted = [...ranked].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.sessionId.localeCompare(b.sessionId);
  });

  let selected = sorted.slice(0, AUTO_MAX_RECORDS);
  while (selected.length > 0) {
    const envelopeText = renderEnvelope(requestId, selected);
    const estimatedTokens = estimateEnvelopeTokens(envelopeText);
    if (estimatedTokens <= AUTO_MAX_ESTIMATED_TOKENS) {
      return {
        requestId,
        prompt,
        records: selected,
        envelopeText,
        estimatedTokens,
        trustRuleAppended: true,
      };
    }
    // 从最低排名移除
    let minIdx = 0;
    for (let i = 1; i < selected.length; i += 1) {
      if (selected[i]!.score < selected[minIdx]!.score) {
        minIdx = i;
      }
    }
    selected = selected.filter((_, index) => index !== minIdx);
  }
  return null;
}

/**
 * 渲染 envelope 文本。
 */
export function renderEnvelope(requestId: string, records: EnvelopeRecord[]): string {
  const lines = [
    ENVELOPE_START,
    `version: ${ENVELOPE_VERSION}`,
    `requestId: ${requestId}`,
    `recordCount: ${records.length}`,
    "records:",
  ];
  for (const record of records) {
    lines.push(`- role: ${record.role}`);
    lines.push(`  occurredAt: ${record.occurredAt}`);
    lines.push(`  sessionId: ${record.sessionId}`);
    lines.push(`  entryId: ${record.entryId}`);
    lines.push(`  contentHash: ${record.contentHash}`);
    lines.push(`  textLength: ${[...record.text].length}`);
    lines.push("  text: |");
    for (const line of escapeEnvelopeMarkers(record.text).split("\n")) {
      lines.push(`    ${line}`);
    }
  }
  lines.push(ENVELOPE_END);
  return lines.join("\n");
}

/**
 * 消息中是否已含冲突/既有 envelope marker。
 */
export function messagesContainEnvelopeMarker(messages: unknown[]): boolean {
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string" && content.includes("[[pi-session-recall:envelope")) {
      return true;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: string }).text === "string" &&
          (block as { text: string }).text.includes("[[pi-session-recall:envelope")
        ) {
          return true;
        }
      }
    }
  }
  return false;
}
