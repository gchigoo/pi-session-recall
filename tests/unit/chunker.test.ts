import { describe, expect, it } from "vitest";
import { canonicalizeText, chunkText, scalarLength } from "../../src/core/sessions/chunker.js";

describe("deterministic chunker", () => {
  it("canonicalizes newlines and trim", () => {
    expect(canonicalizeText("  a\r\nb\r  ")).toBe("a\nb");
  });

  it("is stable across repeated runs", () => {
    const input = `${"段落一。\n\n".repeat(40)}${"```\ncode\n```\n\n"}${"x".repeat(2500)}`;
    const runs = Array.from({ length: 5 }, () => chunkText(input));
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]).toEqual(runs[0]);
    }
    expect(runs[0]!.every((piece) => scalarLength(piece.text) <= 2000)).toBe(true);
  });

  it("does not emit empty chunks", () => {
    expect(chunkText("   \n\n  ")).toEqual([]);
  });
});
