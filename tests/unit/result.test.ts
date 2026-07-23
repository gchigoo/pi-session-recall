import { describe, expect, it } from "vitest";
import { err, ok } from "../../src/shared/result.js";

describe("Result helpers", () => {
  it("builds ok/err variants", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err("x")).toEqual({ ok: false, error: "x" });
  });
});
