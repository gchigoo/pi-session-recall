import { messagesContainEnvelopeMarker } from "./envelope.js";

/**
 * context 深拷贝注入：定位 user anchor，追加独立 text block。
 */

export interface AgentMessageLike {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

/**
 * 将 envelope 注入 messages 深拷贝；失败返回 null（调用方不修改 context）。
 */
export function injectEnvelopeIntoMessages(
  messages: AgentMessageLike[],
  prompt: string,
  envelopeText: string,
): AgentMessageLike[] | null {
  if (messagesContainEnvelopeMarker(messages)) {
    return null;
  }

  const cloned = structuredClone(messages) as AgentMessageLike[];
  const anchorIndex = findUserAnchorIndex(cloned, prompt);
  if (anchorIndex < 0) {
    return null;
  }

  const anchor = cloned[anchorIndex]!;
  if (anchor.role !== "user") {
    return null;
  }

  const envelopeBlock = { type: "text", text: envelopeText };

  if (typeof anchor.content === "string") {
    anchor.content = [{ type: "text", text: anchor.content }, envelopeBlock];
    return cloned;
  }

  if (Array.isArray(anchor.content)) {
    anchor.content = [...anchor.content, envelopeBlock];
    return cloned;
  }

  return null;
}

/**
 * 定位与当前 prompt 对应的最后一个真实 user message。
 */
export function findUserAnchorIndex(messages: AgentMessageLike[], prompt: string): number {
  const normalized = prompt.normalize("NFC").trim();
  let fallback = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "user") {
      continue;
    }
    if (fallback < 0) {
      fallback = i;
    }
    const text = extractUserText(message.content);
    if (text !== null && text.normalize("NFC").trim() === normalized) {
      return i;
    }
  }
  return fallback;
}

/**
 * 提取 user 文本（string 或首个 text block 拼接）。
 */
function extractUserText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: string }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

/**
 * 统计 messages 中 extension envelope 数量（测试用）。
 */
export function countEnvelopesInMessages(messages: AgentMessageLike[]): number {
  let count = 0;
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string" && content.includes("[[pi-session-recall:envelope:v1]]")) {
      count += 1;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: string }).text === "string" &&
          (block as { text: string }).text.includes("[[pi-session-recall:envelope:v1]]")
        ) {
          count += 1;
        }
      }
    }
  }
  return count;
}
