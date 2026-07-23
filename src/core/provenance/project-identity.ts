import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * ProjectIdentity v1（roadmap §5.3）原型：用于 P0 provenance spike。
 */

export type ProjectKind = "git" | "cwd";

export interface ProjectIdentity {
  version: 1;
  kind: ProjectKind;
  normalizedRoot: string;
  projectKey: string;
  unresolved: boolean;
}

/**
 * 规范化路径分隔符与尾部斜杠；Windows 盘符小写。
 */
export function normalizeRootPath(input: string): string {
  let normalized = input.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export type PathExistsFn = (candidate: string) => boolean;

/**
 * 向上查找最近 git/worktree root；找不到则用 cwd。
 */
export function resolveProjectIdentity(
  cwd: string,
  existsSync: PathExistsFn = (candidate) => fs.existsSync(candidate),
): ProjectIdentity {
  const start = normalizeRootPath(cwd);
  let current = start;
  for (;;) {
    if (existsSync(path.join(current, ".git"))) {
      const normalizedRoot = normalizeRootPath(current);
      return {
        version: 1,
        kind: "git",
        normalizedRoot,
        projectKey: hashProjectKey("git", normalizedRoot),
        unresolved: false,
      };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return {
    version: 1,
    kind: "cwd",
    normalizedRoot: start,
    projectKey: hashProjectKey("cwd", start),
    unresolved: false,
  };
}

/**
 * 计算 projectKey。
 */
export function hashProjectKey(kind: ProjectKind, normalizedRoot: string): string {
  return createHash("sha256").update(`v1|${kind}|${normalizedRoot}`).digest("hex");
}
