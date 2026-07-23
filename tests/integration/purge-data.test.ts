import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareDataHome, purgeDataHome } from "../../src/core/config/data-home.js";
import { ERROR_CODES } from "../../src/core/diagnostics/error-codes.js";
import { setupIndex } from "../../src/core/indexing/indexer.js";
import { closeDatabase, openDatabase } from "../../src/core/store/db.js";
import {
  ensureDataHome,
  isDataHomePurged,
  resetPurgeLatchForTests,
  resolveDataHome,
} from "../../src/core/store/paths.js";

describe("purge-data process boundary", () => {
  let dataHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    resetPurgeLatchForTests();
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-purge-"));
    previousHome = process.env.PI_SESSION_RECALL_HOME;
    process.env.PI_SESSION_RECALL_HOME = dataHome;
  });

  afterEach(() => {
    resetPurgeLatchForTests();
    if (previousHome === undefined) {
      delete process.env.PI_SESSION_RECALL_HOME;
    } else {
      process.env.PI_SESSION_RECALL_HOME = previousHome;
    }
    try {
      fs.rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("deletes data-home and blocks same-process recreate", () => {
    prepareDataHome(dataHome);
    const db = openDatabase({ dataHome });
    setupIndex(db, [
      {
        id: "r1",
        path: path.join(dataHome, "sessions"),
        source: "user-added",
      },
    ]);
    closeDatabase(db);

    const result = purgeDataHome(dataHome);
    expect(result.deleted).toBe(true);
    expect(fs.existsSync(dataHome)).toBe(false);
    expect(isDataHomePurged()).toBe(true);
    expect(() => ensureDataHome(resolveDataHome())).toThrow(ERROR_CODES.PURGE_RESTART_REQUIRED);
    expect(() => openDatabase({ dataHome })).toThrow(ERROR_CODES.PURGE_RESTART_REQUIRED);
  });
});
