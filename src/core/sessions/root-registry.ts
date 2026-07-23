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
  const resolved = path.resolve(filePath);
  return registry.roots
    .filter((root) => root.enabled)
    .some((root) => {
      const normalizedRoot = path.resolve(root.path);
      return resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${path.sep}`);
    });
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
