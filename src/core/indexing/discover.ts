import fs from "node:fs";
import path from "node:path";
import type { SessionRoot } from "../sessions/root-registry.js";

/**
 * 在注册 roots 下发现 regular、非 symlink 的 .jsonl session 文件。
 */

export interface DiscoveredSessionFile {
  rootId: string;
  filePath: string;
}

/**
 * 递归发现 session JSONL（不做正文物化）。
 */
export function discoverSessionFiles(roots: SessionRoot[]): DiscoveredSessionFile[] {
  const found: DiscoveredSessionFile[] = [];
  for (const root of roots.filter((item) => item.enabled)) {
    walk(root.path, root.id, found);
  }
  found.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return found;
}

/**
 * 目录遍历。
 */
function walk(dir: string, rootId: string, out: DiscoveredSessionFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      walk(fullPath, rootId, out);
      continue;
    }
    if (stat.isFile() && entry.name.endsWith(".jsonl")) {
      out.push({ rootId, filePath: fullPath });
    }
  }
}
