import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/adapters/cli/main.js";

describe("CLI scaffold", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["node", "pi-session-recall", "--version"]);
    expect(code).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain("pi-session-recall");
  });

  it("rejects unknown command", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runCli(["node", "pi-session-recall", "search"]);
    expect(code).toBe(1);
    expect(error).toHaveBeenCalled();
  });
});
