import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ERROR_CODES, type DiagnosticEvent } from "../diagnostics/error-codes.js";

/**
 * Session root 注册与路径策略（roadmap §4.2）。
 */

export type SessionRootSource = "agent-dir" | "runtime-session-dir" | "user-added";

export interface SessionRoot {
  id: string;
  path: string;
  source: SessionRootSource;
  enabled: boolean;
}

export interface RootRegistry {
  roots: SessionRoot[];
}

/** 旧版 user root ID：前缀 + 路径前 6 字节 hex（易碰撞）。 */
const LEGACY_USER_ROOT_ID = /^user-[0-9a-f]{12}$/i;

/**
 * 规范化 root 路径：resolve → realpath（不存在则回退）→ win32 小写。
 */
export function canonicalizeRootPath(input: string): string {
  const resolved = path.resolve(input);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // 路径尚未创建时 realpath 失败，保留 resolve 结果
  }
  if (process.platform === "win32") {
    return canonical.toLowerCase();
  }
  return canonical;
}

/**
 * 由路径生成稳定 user root ID（全路径 sha256 前 32 hex）。
 */
export function rootIdForPath(input: string): string {
  const canonicalPath = canonicalizeRootPath(input);
  const digest = createHash("sha256").update(canonicalPath).digest("hex");
  return `user-${digest.slice(0, 32)}`;
}

/**
 * 是否为 1.0.0 碰撞易发的旧 user root ID。
 */
export function isLegacyUserRootId(id: string): boolean {
  return LEGACY_USER_ROOT_ID.test(id);
}

/**
 * 路径是否相等（win32 大小写不敏感）。
 */
export function pathsEqual(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/**
 * 文件是否落在 root 目录下（win32 大小写不敏感）。
 */
export function isPathUnderRoot(filePath: string, rootPath: string): boolean {
  const resolved = path.resolve(filePath);
  const normalizedRoot = path.resolve(rootPath);
  if (process.platform === "win32") {
    const lowerFile = resolved.toLowerCase();
    const lowerRoot = normalizedRoot.toLowerCase();
    return lowerFile === lowerRoot || lowerFile.startsWith(`${lowerRoot}${path.sep}`);
  }
  return resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${path.sep}`);
}

/**
 * 创建 root registry。
 */
export function createRootRegistry(roots: SessionRoot[]): RootRegistry {
  return {
    roots: roots.map((root) => ({
      ...root,
      path: path.resolve(root.path),
    })),
  };
}

/**
 * 路径是否落在已启用的注册 root 内。
 */
export function isPathInsideRoots(filePath: string, registry: RootRegistry): boolean {
  return registry.roots
    .filter((root) => root.enabled)
    .some((root) => isPathUnderRoot(filePath, root.path));
}

/**
 * 校验历史文件是否允许只读打开：必须是 regular、非 symlink。
 */
export function assertReadableSessionFile(
  filePath: string,
  registry: RootRegistry,
  existsSync: typeof fs.existsSync = fs.existsSync,
  lstatSync: typeof fs.lstatSync = fs.lstatSync,
): { ok: true } | { ok: false; diagnostic: DiagnosticEvent } {
  if (!isPathInsideRoots(filePath, registry)) {
    return {
      ok: false,
      diagnostic: {
        code: ERROR_CODES.PATH_REJECTED,
        detail: "outside-registered-roots",
      },
    };
  }
  if (!existsSync(filePath)) {
    return {
      ok: false,
      diagnostic: {
        code: ERROR_CODES.PATH_REJECTED,
        detail: "missing",
      },
    };
  }
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        ok: false,
        diagnostic: {
          code: ERROR_CODES.PATH_REJECTED,
          detail: "not-regular-file",
        },
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      diagnostic: {
        code: ERROR_CODES.PATH_REJECTED,
        detail: "stat-failed",
      },
    };
  }
}
