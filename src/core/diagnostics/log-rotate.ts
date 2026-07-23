import fs from "node:fs";
import path from "node:path";
import { resolveDataHome } from "../store/paths.js";
import { LIMITS } from "./limits.js";

/**
 * data-home 诊断日志：无 query/path/正文，超限轮换。
 */

/**
 * 诊断日志路径。
 */
export function resolveDiagnosticLogPath(dataHome = resolveDataHome()): string {
  return path.join(dataHome, "diagnostics.log");
}

/**
 * 追加一行诊断（失败静默）。
 */
export function appendDiagnostic(line: string, dataHome = resolveDataHome()): void {
  try {
    if (!fs.existsSync(dataHome)) {
      return;
    }
    const filePath = resolveDiagnosticLogPath(dataHome);
    rotateIfNeeded(filePath);
    const safe = line.replace(/[\r\n]+/g, " ").slice(0, 500);
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${safe}\n`, "utf8");
  } catch {
    // fail-open
  }
}

/**
 * 超过上限则轮换为 .1。
 */
export function rotateIfNeeded(filePath: string, maxBytes = LIMITS.maxDiagnosticLogBytes): void {
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }
    const size = fs.statSync(filePath).size;
    if (size < maxBytes) {
      return;
    }
    const rotated = `${filePath}.1`;
    fs.rmSync(rotated, { force: true });
    fs.renameSync(filePath, rotated);
  } catch {
    // fail-open
  }
}
