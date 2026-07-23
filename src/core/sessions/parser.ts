import { createHash } from "node:crypto";
import { PARSER_MAX_LINE_BYTES } from "../config/versions.js";
import { ERROR_CODES, type DiagnosticEvent } from "../diagnostics/error-codes.js";
import { sessionHash } from "./hash.js";

/**
 * Strict Pi session v3 JSONL streaming parser（roadmap §5.1）。
 */

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  cwd: string;
  timestamp: string;
  parentSession?: string;
}

export interface ParsedEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  byteOffset: number;
  lineHash: string;
}

export interface TextBlock {
  blockIndex: number;
  text: string;
}

export interface ParsedMessageEntry extends ParsedEntryBase {
  type: "message";
  role: string;
  rawContent: unknown;
  textBlocks: TextBlock[];
}

export type ParsedEntry = ParsedMessageEntry | (ParsedEntryBase & { type: string });

export type SessionParseStatus = "ok" | "header-invalid" | "legacy-unsupported" | "empty";

export interface ParsedSession {
  status: SessionParseStatus;
  header?: SessionHeader;
  entries: ParsedEntry[];
  messages: ParsedMessageEntry[];
  diagnostics: DiagnosticEvent[];
  /** 完整文件字节长度 */
  byteLength: number;
  /** 末尾完整行 hash（增量游标） */
  trailingLineHash: string | null;
  /** 下一可追加 byte offset */
  nextByteOffset: number;
}

/**
 * 解析完整 session 文本（按行扫描，不把正文写入 diagnostics）。
 */
export function parseSessionText(text: string): ParsedSession {
  const diagnostics: DiagnosticEvent[] = [];
  const byteLength = Buffer.byteLength(text, "utf8");
  if (text.length === 0) {
    return {
      status: "empty",
      entries: [],
      messages: [],
      diagnostics: [{ code: ERROR_CODES.HEADER_INVALID, detail: "empty" }],
      byteLength: 0,
      trailingLineHash: null,
      nextByteOffset: 0,
    };
  }

  const { lines, completeByteLength } = splitJsonlLines(text);
  if (lines.length === 0) {
    return {
      status: "empty",
      entries: [],
      messages: [],
      diagnostics: [{ code: ERROR_CODES.HEADER_INVALID, detail: "empty" }],
      byteLength,
      trailingLineHash: null,
      nextByteOffset: completeByteLength,
    };
  }

  const headerLine = lines[0]!;
  if (Buffer.byteLength(headerLine.text, "utf8") > PARSER_MAX_LINE_BYTES) {
    return {
      status: "header-invalid",
      entries: [],
      messages: [],
      diagnostics: [
        {
          code: ERROR_CODES.ENTRY_OVERSIZED,
          detail: "header",
        },
      ],
      byteLength,
      trailingLineHash: null,
      nextByteOffset: 0,
    };
  }

  let headerRaw: unknown;
  try {
    headerRaw = JSON.parse(headerLine.text);
  } catch {
    return {
      status: "header-invalid",
      entries: [],
      messages: [],
      diagnostics: [{ code: ERROR_CODES.HEADER_INVALID, detail: "json" }],
      byteLength,
      trailingLineHash: null,
      nextByteOffset: 0,
    };
  }

  const headerCheck = validateHeader(headerRaw);
  if (!headerCheck.ok) {
    return {
      status: headerCheck.status,
      entries: [],
      messages: [],
      diagnostics: [headerCheck.diagnostic],
      byteLength,
      trailingLineHash: null,
      nextByteOffset: 0,
    };
  }

  const header = headerCheck.header;
  const sidHash = sessionHash(header.id);
  const entries: ParsedEntry[] = [];
  const messages: ParsedMessageEntry[] = [];

  for (const line of lines.slice(1)) {
    if (Buffer.byteLength(line.text, "utf8") > PARSER_MAX_LINE_BYTES) {
      diagnostics.push({
        code: ERROR_CODES.ENTRY_OVERSIZED,
        sessionHash: sidHash,
        count: 1,
      });
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(line.text);
    } catch {
      diagnostics.push({
        code: ERROR_CODES.ENTRY_MALFORMED,
        sessionHash: sidHash,
        count: 1,
        detail: "json",
      });
      continue;
    }

    if (!isRecord(raw)) {
      diagnostics.push({
        code: ERROR_CODES.ENTRY_MALFORMED,
        sessionHash: sidHash,
        count: 1,
        detail: "not-object",
      });
      continue;
    }

    const type = raw.type;
    if (typeof type !== "string") {
      diagnostics.push({
        code: ERROR_CODES.ENTRY_MALFORMED,
        sessionHash: sidHash,
        count: 1,
        detail: "missing-type",
      });
      continue;
    }

    // 未知 type：记诊断，不中断
    if (
      type !== "message" &&
      type !== "compaction" &&
      type !== "model_change" &&
      type !== "thinking_level_change" &&
      type !== "branch_summary" &&
      type !== "custom" &&
      type !== "file" &&
      type !== "session_info"
    ) {
      diagnostics.push({
        code: ERROR_CODES.ENTRY_MALFORMED,
        sessionHash: sidHash,
        count: 1,
        detail: "unknown-type",
      });
    }

    if (typeof raw.id !== "string" || !("parentId" in raw) || typeof raw.timestamp !== "string") {
      diagnostics.push({
        code: ERROR_CODES.ENTRY_MALFORMED,
        sessionHash: sidHash,
        count: 1,
        detail: "entry-base",
      });
      continue;
    }

    const parentId =
      raw.parentId === null || typeof raw.parentId === "string" ? raw.parentId : null;
    if (raw.parentId !== null && typeof raw.parentId !== "string") {
      diagnostics.push({
        code: ERROR_CODES.ENTRY_MALFORMED,
        sessionHash: sidHash,
        count: 1,
        detail: "parentId",
      });
      continue;
    }

    const base: ParsedEntryBase = {
      type,
      id: raw.id,
      parentId,
      timestamp: raw.timestamp,
      byteOffset: line.byteOffset,
      lineHash: hashLine(line.text),
    };

    if (type === "message") {
      const message = raw.message;
      if (!isRecord(message) || typeof message.role !== "string") {
        diagnostics.push({
          code: ERROR_CODES.ENTRY_MALFORMED,
          sessionHash: sidHash,
          count: 1,
          detail: "message",
        });
        continue;
      }
      const parsedMessage: ParsedMessageEntry = {
        ...base,
        type: "message",
        role: message.role,
        rawContent: message.content,
        textBlocks: extractTextBlocks(message.role, message.content),
      };
      entries.push(parsedMessage);
      messages.push(parsedMessage);
      continue;
    }

    entries.push(base);
  }

  const lastLine = lines[lines.length - 1];
  return {
    status: "ok",
    header,
    entries,
    messages,
    diagnostics,
    byteLength,
    trailingLineHash: lastLine ? hashLine(lastLine.text) : null,
    // 未以换行结束的残缺尾不推进游标
    nextByteOffset: completeByteLength,
  };
}

/**
 * 按行切分 JSONL，保留 UTF-8 byte offset。
 * 无换行结束的残缺尾不进入结果（malformed tail hold）。
 */
function splitJsonlLines(text: string): {
  lines: Array<{ text: string; byteOffset: number }>;
  completeByteLength: number;
} {
  const result: Array<{ text: string; byteOffset: number }> = [];
  let byteOffset = 0;
  let lineStart = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\r" && text[i + 1] === "\n") {
      const line = text.slice(lineStart, i);
      if (line.length > 0) {
        result.push({ text: line, byteOffset });
      }
      byteOffset += Buffer.byteLength(text.slice(lineStart, i + 2), "utf8");
      i += 2;
      lineStart = i;
      continue;
    }
    if (text[i] === "\n") {
      const line = text.slice(lineStart, i);
      if (line.length > 0) {
        result.push({ text: line, byteOffset });
      }
      byteOffset += Buffer.byteLength(text.slice(lineStart, i + 1), "utf8");
      i += 1;
      lineStart = i;
      continue;
    }
    i += 1;
  }
  // 残缺尾：不推入 lines，completeByteLength 停在上一完整行后
  return { lines: result, completeByteLength: byteOffset };
}

/**
 * 校验 header。
 */
function validateHeader(
  raw: unknown,
):
  | { ok: true; header: SessionHeader }
  | { ok: false; status: SessionParseStatus; diagnostic: DiagnosticEvent } {
  if (!isRecord(raw) || raw.type !== "session") {
    return {
      ok: false,
      status: "header-invalid",
      diagnostic: { code: ERROR_CODES.HEADER_INVALID, detail: "type" },
    };
  }
  if (typeof raw.version !== "number") {
    return {
      ok: false,
      status: "header-invalid",
      diagnostic: { code: ERROR_CODES.HEADER_INVALID, detail: "version" },
    };
  }
  if (raw.version !== 3) {
    return {
      ok: false,
      status: "legacy-unsupported",
      diagnostic: { code: ERROR_CODES.LEGACY_UNSUPPORTED, detail: `v${raw.version}` },
    };
  }
  if (
    typeof raw.id !== "string" ||
    typeof raw.cwd !== "string" ||
    typeof raw.timestamp !== "string"
  ) {
    return {
      ok: false,
      status: "header-invalid",
      diagnostic: { code: ERROR_CODES.HEADER_INVALID, detail: "fields" },
    };
  }
  const header: SessionHeader = {
    type: "session",
    version: 3,
    id: raw.id,
    cwd: raw.cwd,
    timestamp: raw.timestamp,
  };
  if (typeof raw.parentSession === "string") {
    header.parentSession = raw.parentSession;
  }
  return { ok: true, header };
}

/**
 * 仅提取 user/assistant 的 text blocks。
 */
export function extractTextBlocks(role: string, content: unknown): TextBlock[] {
  if (role !== "user" && role !== "assistant") {
    return [];
  }
  if (typeof content === "string") {
    return content.length > 0 ? [{ blockIndex: 0, text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: TextBlock[] = [];
  let blockIndex = 0;
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
      continue;
    }
    if (item.text.length === 0) {
      continue;
    }
    blocks.push({ blockIndex, text: item.text });
    blockIndex += 1;
  }
  return blocks;
}

/**
 * 行 hash。
 */
export function hashLine(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
