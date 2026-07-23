import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../../src/core/retrieval/query.js";

describe("parseSearchQuery", () => {
  it("builds quoted match expression from terms", () => {
    const parsed = parseSearchQuery("认证 authentication");
    expect(parsed.terms).toContain("认证");
    expect(parsed.terms).toContain("authentication");
    expect(parsed.matchExpression).toContain('content:"认证"');
    expect(parsed.matchExpression).toContain('cjk:"认证"');
  });

  it("rejects oversized query", () => {
    expect(() => parseSearchQuery("x".repeat(600))).toThrow("query-invalid");
  });
});
