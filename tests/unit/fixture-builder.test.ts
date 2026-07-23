import { describe, expect, it } from "vitest";
import { buildHeader, serializeSessionFixture } from "../../src/core/sessions/fixture-builder.js";

describe("fixture builder", () => {
  it("emits v3 header", () => {
    const header = buildHeader({ cwd: "/tmp/a", id: "abc" });
    expect(header).toMatchObject({ type: "session", version: 3, id: "abc", cwd: "/tmp/a" });
  });

  it("serializes JSONL with header first", () => {
    const text = serializeSessionFixture({
      name: "sample",
      header: { cwd: "/tmp/a", id: "abc" },
      entries: [{ parentId: null, role: "user", text: "hi", id: "deadbeef" }],
    });
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "session", version: 3 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: "message", id: "deadbeef" });
  });
});
