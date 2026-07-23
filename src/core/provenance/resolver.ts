import fs from "node:fs";
import path from "node:path";
import { ERROR_CODES } from "../diagnostics/error-codes.js";
import { contentHash, stableStringify } from "../sessions/hash.js";
import {
  parseSessionText,
  type ParsedMessageEntry,
  type SessionHeader,
} from "../sessions/parser.js";
import { resolveProjectIdentity, type ProjectIdentity } from "./project-identity.js";

/**
 * Parent-chain provenance resolver（roadmap §5.2）。
 */

export type ProvenanceStatus = "verified" | "unresolved";

export interface EntryAttribution {
  entryId: string;
  role: string;
  provenance: ProvenanceStatus;
  originProjectKey?: string;
  reason?: string;
}

export interface ProvenanceReport {
  sessionId: string;
  headerProject: ProjectIdentity;
  attributions: EntryAttribution[];
  unresolvedCopiedCount: number;
}

const MAX_PARENT_DEPTH = 32;

/**
 * 对 session 文件做 provenance 归属分析。
 */
export function resolveSessionProvenance(
  sessionFile: string,
  options?: {
    registeredRoots?: string[];
    readFileSync?: typeof fs.readFileSync;
    existsSync?: typeof fs.existsSync;
  },
): ProvenanceReport {
  const readFileSync = options?.readFileSync ?? fs.readFileSync;
  const existsSync = options?.existsSync ?? fs.existsSync;
  const registeredRoots = (options?.registeredRoots ?? [path.dirname(sessionFile)]).map((root) =>
    path.resolve(root),
  );

  const parsed = parseSessionText(readFileSync(sessionFile, "utf8"));
  if (parsed.status !== "ok" || !parsed.header) {
    return {
      sessionId: "unknown",
      headerProject: resolveProjectIdentity(".", existsSync),
      attributions: [],
      unresolvedCopiedCount: 0,
    };
  }

  const header = parsed.header;
  const messages = parsed.messages;
  const headerProject = resolveProjectIdentity(header.cwd, existsSync);

  if (!header.parentSession) {
    return {
      sessionId: header.id,
      headerProject,
      attributions: messages.map((entry) => ({
        entryId: entry.id,
        role: entry.role,
        provenance: "verified",
        originProjectKey: headerProject.projectKey,
      })),
      unresolvedCopiedCount: 0,
    };
  }

  const ancestors = loadAncestorChain(header.parentSession, {
    registeredRoots,
    readFileSync,
    existsSync,
    maxDepth: MAX_PARENT_DEPTH,
  });

  if (!ancestors.ok) {
    return {
      sessionId: header.id,
      headerProject,
      attributions: messages.map((entry) => ({
        entryId: entry.id,
        role: entry.role,
        provenance: "unresolved",
        reason: ancestors.reason,
      })),
      unresolvedCopiedCount: messages.length,
    };
  }

  const earliestByFingerprint = new Map<string, { projectKey: string; depth: number }>();
  for (const [depth, ancestor] of ancestors.sessions.entries()) {
    const project = resolveProjectIdentity(ancestor.header.cwd, existsSync);
    for (const entry of ancestor.messages) {
      const fingerprint = entryFingerprint(entry);
      const existing = earliestByFingerprint.get(fingerprint);
      if (!existing || depth < existing.depth) {
        earliestByFingerprint.set(fingerprint, {
          projectKey: project.projectKey,
          depth,
        });
      }
    }
  }

  // 同 ID 内容冲突：child 与任一祖先同 ID 但指纹不同 → unresolved
  const ancestorById = new Map<string, string>();
  for (const ancestor of ancestors.sessions) {
    for (const entry of ancestor.messages) {
      ancestorById.set(entry.id, entryFingerprint(entry));
    }
  }

  const attributions: EntryAttribution[] = [];
  let unresolvedCopiedCount = 0;
  for (const entry of messages) {
    const fingerprint = entryFingerprint(entry);
    const ancestorFp = ancestorById.get(entry.id);
    if (ancestorFp && ancestorFp !== fingerprint) {
      unresolvedCopiedCount += 1;
      attributions.push({
        entryId: entry.id,
        role: entry.role,
        provenance: "unresolved",
        reason: ERROR_CODES.PROVENANCE_UNRESOLVED,
      });
      continue;
    }

    const match = earliestByFingerprint.get(fingerprint);
    if (match) {
      attributions.push({
        entryId: entry.id,
        role: entry.role,
        provenance: "verified",
        originProjectKey: match.projectKey,
      });
      continue;
    }

    attributions.push({
      entryId: entry.id,
      role: entry.role,
      provenance: "verified",
      originProjectKey: headerProject.projectKey,
    });
  }

  return {
    sessionId: header.id,
    headerProject,
    attributions,
    unresolvedCopiedCount,
  };
}

/**
 * entry 指纹：entryId + parentId + type + role + content hash。
 */
export function entryFingerprint(entry: ParsedMessageEntry): string {
  const hash = contentHash(stableStringify(entry.rawContent));
  return `${entry.id}|${entry.parentId ?? "null"}|message|${entry.role}|${hash}`;
}

interface AncestorLoadOk {
  ok: true;
  sessions: Array<{ header: SessionHeader; messages: ParsedMessageEntry[] }>;
}

interface AncestorLoadErr {
  ok: false;
  reason: string;
}

/**
 * 在已注册 roots 内解析受限 parentSession chain。
 */
function loadAncestorChain(
  parentSession: string,
  options: {
    registeredRoots: string[];
    readFileSync: typeof fs.readFileSync;
    existsSync: typeof fs.existsSync;
    maxDepth: number;
  },
): AncestorLoadOk | AncestorLoadErr {
  const sessions: AncestorLoadOk["sessions"] = [];
  const visitedPaths = new Set<string>();
  const visitedHeaders = new Set<string>();
  let current: string | undefined = parentSession;

  for (let depth = 0; depth < options.maxDepth && current; depth += 1) {
    const resolved = path.resolve(current);
    if (visitedPaths.has(resolved)) {
      return { ok: false, reason: ERROR_CODES.PARENT_CYCLE };
    }
    visitedPaths.add(resolved);

    if (!isPathInsideRegisteredRoots(resolved, options.registeredRoots)) {
      return { ok: false, reason: ERROR_CODES.PARENT_OUTSIDE_REGISTERED_ROOTS };
    }
    if (!options.existsSync(resolved)) {
      return { ok: false, reason: ERROR_CODES.PARENT_MISSING };
    }

    const parsed = parseSessionText(options.readFileSync(resolved, "utf8"));
    if (parsed.status !== "ok" || !parsed.header) {
      return { ok: false, reason: ERROR_CODES.PARENT_MISSING };
    }
    if (visitedHeaders.has(parsed.header.id)) {
      return { ok: false, reason: ERROR_CODES.PARENT_CYCLE };
    }
    visitedHeaders.add(parsed.header.id);
    sessions.push({ header: parsed.header, messages: parsed.messages });
    current = parsed.header.parentSession;
  }

  if (current) {
    return { ok: false, reason: "parent-chain-too-deep" };
  }

  return { ok: true, sessions: sessions.reverse() };
}

/**
 * 路径是否落在任一注册 root 下。
 */
function isPathInsideRegisteredRoots(filePath: string, roots: string[]): boolean {
  const resolved = path.resolve(filePath);
  return roots.some((root) => {
    const normalizedRoot = path.resolve(root);
    return resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${path.sep}`);
  });
}
