import { describe, expect, it } from "vitest";
import { cjkBigrams, queryTerms } from "../../src/core/retrieval/cjk-terms.js";

describe("CJK term helpers", () => {
  it("builds bigrams for Chinese text", () => {
    expect(cjkBigrams("认证")).toEqual(["认证"]);
    expect(cjkBigrams("登录认证")).toEqual(["登录", "录认", "认证"]);
  });

  it("collects latin and cjk terms", () => {
    const terms = queryTerms("authentication 认证");
    expect(terms).toContain("authentication");
    expect(terms).toContain("认证");
  });
});
