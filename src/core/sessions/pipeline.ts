import fs from "node:fs";
import path from "node:path";
import { CHUNKER_VERSION, POLICY_VERSION } from "../config/versions.js";
import { ERROR_CODES, type DiagnosticEvent } from "../diagnostics/error-codes.js";
import { applyContentPolicy, isIndexableRole } from "../policy/content-policy.js";
import {
  resolveSessionProvenance,
  type EntryAttribution,
  type ProvenanceReport,
} from "../provenance/resolver.js";
import { chunkText } from "./chunker.js";
import { contentHash, sessionHash, sourceKey } from "./hash.js";
import { parseSessionText, type ParsedSession } from "./parser.js";
import {
  assertReadableSessionFile,
  createRootRegistry,
  type RootRegistry,
} from "./root-registry.js";

/**
 * P1 只读索引管道：parse → provenance → policy → chunks。
 */

export type ProvenanceLabel = "verified" | "unresolved";

export interface CanonicalChunk {
  sourceKey: string;
  sessionId: string;
  entryId: string;
  blockIndex: number;
  chunkIndex: number;
  role: string;
  occurredAt: string;
  originProjectKey: string;
  provenance: ProvenanceLabel;
  contentHash: string;
  text: string;
  autoEligible: boolean;
  persistDisposition: "allow" | "redacted";
  chunkerVersion: string;
  policyVersion: string;
}

export interface IndexSessionResult {
  sessionId: string | null;
  chunks: CanonicalChunk[];
  diagnostics: DiagnosticEvent[];
  unresolvedCopiedCount: number;
  parsed: ParsedSession;
  provenance?: ProvenanceReport;
}

/**
 * 索引单个 session 文件，产出可快照的 canonical chunks（不含 path）。
 */
export function indexSessionFile(
  sessionFile: string,
  options?: {
    registry?: RootRegistry;
    readFileSync?: typeof fs.readFileSync;
    existsSync?: typeof fs.existsSync;
    lstatSync?: typeof fs.lstatSync;
  },
): IndexSessionResult {
  const readFileSync = options?.readFileSync ?? fs.readFileSync;
  const existsSync = options?.existsSync ?? fs.existsSync;
  const lstatSync = options?.lstatSync ?? fs.lstatSync;
  const registry =
    options?.registry ??
    createRootRegistry([
      {
        id: "default",
        path: path.dirname(path.resolve(sessionFile)),
        source: "user-added",
        enabled: true,
      },
    ]);

  const pathCheck = assertReadableSessionFile(sessionFile, registry, existsSync, lstatSync);
  if (!pathCheck.ok) {
    return {
      sessionId: null,
      chunks: [],
      diagnostics: [pathCheck.diagnostic],
      unresolvedCopiedCount: 0,
      parsed: {
        status: "header-invalid",
        entries: [],
        messages: [],
        diagnostics: [pathCheck.diagnostic],
        byteLength: 0,
        trailingLineHash: null,
        nextByteOffset: 0,
      },
    };
  }

  const text = readFileSync(sessionFile, "utf8");
  return indexSessionText(text, {
    sessionFile,
    registry,
    readFileSync,
    existsSync,
  });
}

/**
 * 索引 session 文本（便于单测注入）。
 */
export function indexSessionText(
  text: string,
  options: {
    sessionFile: string;
    registry: RootRegistry;
    readFileSync?: typeof fs.readFileSync;
    existsSync?: typeof fs.existsSync;
  },
): IndexSessionResult {
  const parsed = parseSessionText(text);
  const diagnostics = [...parsed.diagnostics];

  if (parsed.status !== "ok" || !parsed.header) {
    return {
      sessionId: parsed.header?.id ?? null,
      chunks: [],
      diagnostics,
      unresolvedCopiedCount: 0,
      parsed,
    };
  }

  const provenanceOptions: {
    registeredRoots: string[];
    readFileSync?: typeof fs.readFileSync;
    existsSync?: typeof fs.existsSync;
  } = {
    registeredRoots: options.registry.roots.filter((root) => root.enabled).map((root) => root.path),
  };
  if (options.readFileSync) {
    provenanceOptions.readFileSync = options.readFileSync;
  }
  if (options.existsSync) {
    provenanceOptions.existsSync = options.existsSync;
  }
  const provenance = resolveSessionProvenance(options.sessionFile, provenanceOptions);

  const attributionByEntry = new Map<string, EntryAttribution>();
  for (const item of provenance.attributions) {
    attributionByEntry.set(item.entryId, item);
  }

  const chunks: CanonicalChunk[] = [];
  let unresolvedCopiedCount = 0;

  for (const message of parsed.messages) {
    if (!isIndexableRole(message.role)) {
      continue;
    }

    const attribution = attributionByEntry.get(message.id);
    if (!attribution || attribution.provenance === "unresolved" || !attribution.originProjectKey) {
      unresolvedCopiedCount += 1;
      const diagnostic: DiagnosticEvent = {
        code: ERROR_CODES.PROVENANCE_UNRESOLVED,
        sessionHash: sessionHash(parsed.header.id),
        count: 1,
      };
      if (attribution?.reason) {
        diagnostic.detail = attribution.reason;
      }
      diagnostics.push(diagnostic);
      continue;
    }

    for (const block of message.textBlocks) {
      const decision = applyContentPolicy(block.text);
      diagnostics.push(...decision.diagnostics);
      if (decision.persistDisposition === "reject" || decision.text.length === 0) {
        continue;
      }

      const pieces = chunkText(decision.text);
      for (const piece of pieces) {
        const key = sourceKey({
          sessionId: parsed.header.id,
          entryId: message.id,
          blockIndex: block.blockIndex,
          chunkIndex: piece.chunkIndex,
        });
        chunks.push({
          sourceKey: key,
          sessionId: parsed.header.id,
          entryId: message.id,
          blockIndex: block.blockIndex,
          chunkIndex: piece.chunkIndex,
          role: message.role,
          occurredAt: message.timestamp,
          originProjectKey: attribution.originProjectKey,
          provenance: "verified",
          contentHash: contentHash(piece.text),
          text: piece.text,
          autoEligible: decision.autoEligible,
          persistDisposition: decision.persistDisposition,
          chunkerVersion: CHUNKER_VERSION,
          policyVersion: POLICY_VERSION,
        });
      }
    }
  }

  // 稳定排序，保证 snapshot 确定性
  chunks.sort((a, b) => {
    if (a.entryId !== b.entryId) {
      return a.entryId.localeCompare(b.entryId);
    }
    if (a.blockIndex !== b.blockIndex) {
      return a.blockIndex - b.blockIndex;
    }
    return a.chunkIndex - b.chunkIndex;
  });

  return {
    sessionId: parsed.header.id,
    chunks,
    diagnostics,
    unresolvedCopiedCount,
    parsed,
    provenance,
  };
}

/**
 * 生成可快照摘要（不含 path，正文可保留合成 fixture）。
 */
export function toChunkSnapshot(result: IndexSessionResult): unknown {
  return {
    sessionId: result.sessionId,
    unresolvedCopiedCount: result.unresolvedCopiedCount,
    diagnosticCodes: result.diagnostics.map((item) => item.code).sort(),
    chunks: result.chunks.map((chunk) => ({
      sourceKey: chunk.sourceKey,
      entryId: chunk.entryId,
      blockIndex: chunk.blockIndex,
      chunkIndex: chunk.chunkIndex,
      role: chunk.role,
      originProjectKey: chunk.originProjectKey,
      provenance: chunk.provenance,
      contentHash: chunk.contentHash,
      text: chunk.text,
      autoEligible: chunk.autoEligible,
      persistDisposition: chunk.persistDisposition,
      chunkerVersion: chunk.chunkerVersion,
      policyVersion: chunk.policyVersion,
    })),
  };
}
