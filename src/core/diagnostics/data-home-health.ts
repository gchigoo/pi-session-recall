import fs from "node:fs";
import path from "node:path";
import { resolveDataHome, resolveDbPath } from "../store/paths.js";
import { LIMITS } from "./limits.js";

/**
 * data-home 权限与容量诊断（不含正文）。
 */

export interface DataHomeHealth {
  dataHome: string;
  exists: boolean;
  writable: boolean;
  dbExists: boolean;
  dbBytes: number | null;
  dbOverLimit: boolean;
  mode: string | null;
  ok: boolean;
  issues: string[];
}

/**
 * 诊断 data-home 可写性与 DB 大小。
 */
export function diagnoseDataHome(dataHome = resolveDataHome()): DataHomeHealth {
  const resolved = path.resolve(dataHome);
  const issues: string[] = [];
  const exists = fs.existsSync(resolved);
  let writable = false;
  let mode: string | null = null;
  if (exists) {
    try {
      const stat = fs.statSync(resolved);
      mode = (stat.mode & 0o777).toString(8);
      const probe = path.join(resolved, `.write-probe-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe, { force: true });
      writable = true;
    } catch {
      writable = false;
      issues.push("not-writable");
    }
  } else {
    issues.push("missing");
  }

  const dbPath = resolveDbPath(resolved);
  const dbExists = fs.existsSync(dbPath);
  let dbBytes: number | null = null;
  let dbOverLimit = false;
  if (dbExists) {
    dbBytes = fs.statSync(dbPath).size;
    dbOverLimit = dbBytes > LIMITS.maxDbBytes;
    if (dbOverLimit) {
      issues.push("db-over-limit");
    }
  }

  return {
    dataHome: resolved,
    exists,
    writable,
    dbExists,
    dbBytes,
    dbOverLimit,
    mode,
    ok: issues.length === 0 && exists && writable,
    issues,
  };
}
