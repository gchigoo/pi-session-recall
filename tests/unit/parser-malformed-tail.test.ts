import { describe, expect, it } from "vitest";
import { parseSessionText } from "../../src/core/sessions/parser.js";
import { buildScanCursor, completeJsonlPrefix } from "../../src/core/sessions/scan-state.js";

describe("malformed tail hold", () => {
  it("skips incomplete final line without newline", () => {
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "s1",
      cwd: "/tmp/a",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const msg = JSON.stringify({
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "complete", timestamp: 1 },
    });
    const text = `${header}\n${msg}\n{"type":"message","id":"partial`;
    const parsed = parseSessionText(text);
    expect(parsed.status).toBe("ok");
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.nextByteOffset).toBe(Buffer.byteLength(`${header}\n${msg}\n`, "utf8"));
    expect(parsed.nextByteOffset).toBeLessThan(parsed.byteLength);
  });

  it("buildScanCursor ignores incomplete tail", () => {
    const complete = ' {"a":1}\n';
    const withTail = `${complete}{"partial`;
    expect(completeJsonlPrefix(withTail)).toBe(complete);
    const cursor = buildScanCursor(withTail);
    expect(cursor.sizeBytes).toBe(Buffer.byteLength(complete, "utf8"));
    expect(cursor.byteOffset).toBe(cursor.sizeBytes);
  });
});
