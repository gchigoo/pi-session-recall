import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 纯合成 Pi session v3 fixture 构建器（不含真实用户内容）。
 */

export interface SessionHeaderInput {
  id?: string;
  cwd: string;
  parentSession?: string;
  timestamp?: string;
}

export interface MessageEntryInput {
  id?: string;
  parentId: string | null;
  role: "user" | "assistant" | "toolResult" | "custom";
  text?: string;
  thinking?: string;
  toolName?: string;
  customType?: string;
  timestamp?: string;
}

export interface CompactionEntryInput {
  id?: string;
  parentId: string | null;
  summary: string;
  timestamp?: string;
}

export type FixtureEntry = MessageEntryInput | CompactionEntryInput | Record<string, unknown>;

export interface SessionFixtureSpec {
  name: string;
  header: SessionHeaderInput;
  entries: FixtureEntry[];
}

/**
 * 生成 8 位 hex entry ID。
 */
export function makeEntryId(seed?: string): string {
  if (seed) {
    return createHash("sha256").update(seed).digest("hex").slice(0, 8);
  }
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

/**
 * 构造 v3 session header JSON 对象。
 */
export function buildHeader(input: SessionHeaderInput): Record<string, unknown> {
  const header: Record<string, unknown> = {
    type: "session",
    version: 3,
    id: input.id ?? randomUUID(),
    timestamp: input.timestamp ?? "2026-01-01T00:00:00.000Z",
    cwd: input.cwd,
  };
  if (input.parentSession !== undefined) {
    header.parentSession = input.parentSession;
  }
  return header;
}

/**
 * 构造 message entry。
 */
export function buildMessageEntry(input: MessageEntryInput): Record<string, unknown> {
  const id = input.id ?? makeEntryId(`${input.role}:${input.text ?? input.thinking ?? ""}`);
  const timestamp = input.timestamp ?? "2026-01-01T00:00:01.000Z";

  if (input.role === "user") {
    return {
      type: "message",
      id,
      parentId: input.parentId,
      timestamp,
      message: {
        role: "user",
        content: input.text ?? "",
        timestamp: Date.parse(timestamp),
      },
    };
  }

  if (input.role === "assistant") {
    const content: Array<Record<string, unknown>> = [];
    if (input.thinking) {
      content.push({ type: "thinking", thinking: input.thinking });
    }
    if (input.text) {
      content.push({ type: "text", text: input.text });
    }
    if (input.toolName) {
      content.push({
        type: "toolCall",
        id: `call_${id}`,
        name: input.toolName,
        arguments: { probe: true },
      });
    }
    return {
      type: "message",
      id,
      parentId: input.parentId,
      timestamp,
      message: {
        role: "assistant",
        content,
        api: "probe",
        provider: "probe",
        model: "probe",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.parse(timestamp),
      },
    };
  }

  if (input.role === "toolResult") {
    return {
      type: "message",
      id,
      parentId: input.parentId,
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: `call_${input.parentId ?? "root"}`,
        toolName: input.toolName ?? "bash",
        content: [{ type: "text", text: input.text ?? "tool-output" }],
        isError: false,
        timestamp: Date.parse(timestamp),
      },
    };
  }

  return {
    type: "message",
    id,
    parentId: input.parentId,
    timestamp,
    message: {
      role: "custom",
      customType: input.customType ?? "probe",
      content: input.text ?? "custom",
      display: false,
      timestamp: Date.parse(timestamp),
    },
  };
}

/**
 * 构造 compaction summary entry。
 */
export function buildCompactionEntry(input: CompactionEntryInput): Record<string, unknown> {
  return {
    type: "compaction",
    id: input.id ?? makeEntryId(`compaction:${input.summary}`),
    parentId: input.parentId,
    timestamp: input.timestamp ?? "2026-01-01T00:00:02.000Z",
    summary: input.summary,
    tokensBefore: 1000,
  };
}

/**
 * 将 fixture 规格序列化为 JSONL 文本。
 */
export function serializeSessionFixture(spec: SessionFixtureSpec): string {
  const lines = [JSON.stringify(buildHeader(spec.header))];
  for (const entry of spec.entries) {
    if ("role" in entry) {
      lines.push(JSON.stringify(buildMessageEntry(entry as MessageEntryInput)));
    } else if ("summary" in entry && !("type" in entry)) {
      lines.push(JSON.stringify(buildCompactionEntry(entry as CompactionEntryInput)));
    } else {
      lines.push(JSON.stringify(entry));
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 将一组 fixture 写到目录。
 */
export function writeSessionFixtures(dir: string, specs: SessionFixtureSpec[]): string[] {
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const spec of specs) {
    const filePath = path.join(dir, `${spec.name}.jsonl`);
    writeFileSync(filePath, serializeSessionFixture(spec), "utf8");
    paths.push(filePath);
  }
  return paths;
}
