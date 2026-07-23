import { describe, expect, it } from "vitest";
import { extractTextBlocks, parseSessionText } from "../../src/core/sessions/parser.js";

describe("strict session parser", () => {
  it("parses v3 header and message text blocks", () => {
    const text = [
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
        message: { role: "user", content: "hello", timestamp: 1 },
      }),
      "",
    ].join("\n");

    const parsed = parseSessionText(text);
    expect(parsed.status).toBe("ok");
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.textBlocks).toEqual([{ blockIndex: 0, text: "hello" }]);
    expect(parsed.trailingLineHash).toBeTruthy();
  });

  it("rejects legacy header", () => {
    const text = `${JSON.stringify({
      type: "session",
      version: 2,
      id: "s1",
      cwd: "/tmp/a",
      timestamp: "2026-01-01T00:00:00.000Z",
    })}\n`;
    const parsed = parseSessionText(text);
    expect(parsed.status).toBe("legacy-unsupported");
    expect(parsed.messages).toHaveLength(0);
  });

  it("skips thinking/toolCall blocks for assistant", () => {
    const blocks = extractTextBlocks("assistant", [
      { type: "thinking", thinking: "nope" },
      { type: "text", text: "yes" },
      { type: "toolCall", id: "c1", name: "bash", arguments: {} },
    ]);
    expect(blocks).toEqual([{ blockIndex: 0, text: "yes" }]);
  });

  it("records malformed lines without body text", () => {
    const text = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "s1",
        cwd: "/tmp/a",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      "{not-json",
      "",
    ].join("\n");
    const parsed = parseSessionText(text);
    expect(parsed.status).toBe("ok");
    expect(parsed.diagnostics.some((item) => item.code === "entry-malformed")).toBe(true);
    expect(JSON.stringify(parsed.diagnostics)).not.toContain("not-json");
  });
});
