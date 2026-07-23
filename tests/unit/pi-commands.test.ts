import { describe, expect, it } from "vitest";
import { splitArgs } from "../../src/adapters/pi/commands.js";

describe("recall arg split", () => {
  it("splits subcommand tokens", () => {
    expect(splitArgs("search --all 认证 gateway")).toEqual(["search", "--all", "认证", "gateway"]);
  });
});
