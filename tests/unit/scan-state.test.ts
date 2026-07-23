import { describe, expect, it } from "vitest";
import { buildScanCursor, detectScanDisposition } from "../../src/core/sessions/scan-state.js";

describe("scan state", () => {
  const base = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "s1",
      cwd: "/tmp/a",
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    JSON.stringify({
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "one", timestamp: 1 },
    }),
    "",
  ].join("\n");

  it("detects append", () => {
    const cursor = buildScanCursor(base);
    const appended = `${base.trimEnd()}\n${JSON.stringify({
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: "two", timestamp: 2 },
    })}\n`;
    expect(detectScanDisposition(cursor, appended)).toBe("append");
  });

  it("detects truncate", () => {
    const cursor = buildScanCursor(base);
    expect(detectScanDisposition(cursor, `${base.slice(0, 20)}\n`)).toBe("truncate");
  });

  it("detects rewrite when prefix changes", () => {
    const cursor = buildScanCursor(base);
    const rewritten = base.replace("one", "ONE");
    expect(detectScanDisposition(cursor, rewritten)).toBe("rewrite");
  });
});
