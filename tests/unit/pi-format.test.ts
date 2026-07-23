import { describe, expect, it } from "vitest";
import {
  assertNoPathLeak,
  formatHitsPlain,
  sanitizeSnippet,
  toSafeToolHits,
} from "../../src/adapters/pi/format.js";
import type { SearchHit } from "../../src/core/retrieval/search.js";

const sampleHit: SearchHit = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  entryId: "abcd1234",
  role: "user",
  occurredAt: "2026-01-01T00:00:00.000Z",
  snippet: "hello \u001b[31mred\u001b[0m world",
  truncated: true,
  sourceKey: "sk",
  contentHash: "ch",
  originProjectKey: "pk",
  score: 1,
};

describe("pi format", () => {
  it("strips ansi and omits path fields from tool hits", () => {
    const hits = toSafeToolHits([sampleHit]);
    expect(hits[0]?.snippet).toBe("hello red world");
    expect(hits[0]).not.toHaveProperty("path");
    expect(hits[0]).not.toHaveProperty("sourceKey");
    assertNoPathLeak(hits);
  });

  it("formats plain text with truncated marker", () => {
    const text = formatHitsPlain([sampleHit]);
    expect(text).toContain("[truncated]");
    expect(text).toContain("abcd1234");
    expect(text).not.toContain("path");
  });

  it("sanitizeSnippet removes control chars", () => {
    expect(sanitizeSnippet("a\u0007b")).toBe("ab");
  });
});
