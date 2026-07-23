import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ERROR_CODES } from "../diagnostics/error-codes.js";

/**
 * rebuild lease：短租约 + generation，防止双进程同时 rebuild。
 */

const LEASE_TTL_MS = 120_000;

export interface RebuildLease {
  holder: string;
  generation: number;
}

/**
 * 尝试获取 rebuild lease；失败抛 lease-held / db-busy。
 */
export function tryAcquireRebuildLease(
  db: DatabaseSync,
  holder = `pid-${process.pid}-${randomUUID().slice(0, 8)}`,
): RebuildLease {
  const now = Date.now();
  const acquiredAt = new Date(now).toISOString();
  const expiresAt = new Date(now + LEASE_TTL_MS).toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(
        `SELECT holder, generation, expires_at AS expiresAt FROM rebuild_leases WHERE id = 1`,
      )
      .get() as { holder: string; generation: number; expiresAt: string } | undefined;

    if (row) {
      const expired = Date.parse(row.expiresAt) <= now;
      if (!expired && row.holder !== holder) {
        db.exec("ROLLBACK");
        throw new Error(ERROR_CODES.LEASE_HELD);
      }
      const generation = row.generation + 1;
      db.prepare(
        `UPDATE rebuild_leases
         SET holder = ?, generation = ?, acquired_at = ?, expires_at = ?
         WHERE id = 1`,
      ).run(holder, generation, acquiredAt, expiresAt);
      db.exec("COMMIT");
      return { holder, generation };
    }

    db.prepare(
      `INSERT INTO rebuild_leases(id, holder, generation, acquired_at, expires_at)
       VALUES (1, ?, 1, ?, ?)`,
    ).run(holder, acquiredAt, expiresAt);
    db.exec("COMMIT");
    return { holder, generation: 1 };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  }
}

/**
 * 释放 lease（仅 holder 匹配时）。
 */
export function releaseRebuildLease(db: DatabaseSync, holder: string): void {
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `UPDATE rebuild_leases
       SET expires_at = ?
       WHERE id = 1 AND holder = ?`,
    ).run(new Date(0).toISOString(), holder);
    db.exec("COMMIT");
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
  }
}

/**
 * 当前是否有未过期 lease。
 */
export function isLeaseHeld(db: DatabaseSync): boolean {
  const row = db
    .prepare(`SELECT holder, expires_at AS expiresAt FROM rebuild_leases WHERE id = 1`)
    .get() as { holder: string; expiresAt: string } | undefined;
  if (!row) {
    return false;
  }
  return Date.parse(row.expiresAt) > Date.now();
}
