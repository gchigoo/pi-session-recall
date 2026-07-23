import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleBeforeAgentStart, handleContext } from "../../src/adapters/pi/auto-hooks.js";
import { createRuntime, openDbRequired } from "../../src/adapters/pi/runtime.js";
import { TRUST_RULE_TEXT } from "../../src/core/injection/constants.js";
import { autoRetrieve } from "../../src/core/injection/auto-retrieve.js";
import { countEnvelopesInMessages } from "../../src/core/injection/inject.js";
import {
  ensureRuntimeSessionRoot,
  indexSingleFile,
  setupIndex,
} from "../../src/core/indexing/indexer.js";
import { closeDatabase } from "../../src/core/store/db.js";
import { updateRuntimeConfig } from "../../src/core/store/repository.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesDir = path.join(repoRoot, "tests", "fixtures", "sessions");
const projectA = "/tmp/pi-session-recall-fixtures/project-a";
const projectB = "/tmp/pi-session-recall-fixtures/project-b";
const LINEAR_SESSION = "11111111-1111-1111-1111-111111111111";

function mockCtx(cwd: string, sessionId: string) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionDir: () => fixturesDir,
    },
  } as never;
}

describe("P4 auto recall integration", () => {
  let dataHome: string;
  let previousHome: string | undefined;
  let openDb: ReturnType<typeof openDbRequired> | null = null;

  beforeEach(() => {
    dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-p4-"));
    previousHome = process.env.PI_SESSION_RECALL_HOME;
    process.env.PI_SESSION_RECALL_HOME = dataHome;
    openDb = null;
  });

  afterEach(() => {
    if (openDb) {
      try {
        closeDatabase(openDb);
      } catch {
        // ignore
      }
      openDb = null;
    }
    if (previousHome === undefined) {
      delete process.env.PI_SESSION_RECALL_HOME;
    } else {
      process.env.PI_SESSION_RECALL_HOME = previousHome;
    }
    try {
      fs.rmSync(dataHome, { recursive: true, force: true });
    } catch {
      // Windows 偶发文件锁
    }
  });

  function prepareIndex(runtime = createRuntime()) {
    openDb = openDbRequired(runtime);
    setupIndex(openDb, [{ id: "fixtures", path: fixturesDir, source: "user-added" }]);
    ensureRuntimeSessionRoot(openDb, fixturesDir);
    indexSingleFile(openDb, path.join(fixturesDir, "linear.jsonl"), { forceFull: true });
    indexSingleFile(openDb, path.join(fixturesDir, "cross-project-fork-child.jsonl"), {
      forceFull: true,
    });
    return runtime;
  }

  it("auto off: before_agent_start and context have zero side effects", () => {
    const runtime = prepareIndex();
    const prompt = "linear query about authentication";
    const before = handleBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt,
        systemPrompt: "BASE",
        systemPromptOptions: {} as never,
      },
      mockCtx(projectA, "current-session"),
      runtime,
    );
    expect(before).toBeUndefined();
    expect(runtime.requestContext.active).toBeNull();

    const ctxResult = handleContext(
      {
        type: "context",
        messages: [{ role: "user", content: prompt }] as never,
      },
      mockCtx(projectA, "current-session"),
      runtime,
    );
    expect(ctxResult).toBeUndefined();
  });

  it("auto on: trust rule + single envelope; excludes current session; project scope", () => {
    const runtime = prepareIndex();
    updateRuntimeConfig(openDb!, { autoRecall: true });

    const sameSession = autoRetrieve(openDb!, {
      prompt: "authentication",
      cwd: projectA,
      currentSessionId: LINEAR_SESSION,
      requestId: "req-same",
    });
    expect(sameSession.bundle).toBeNull();
    expect(sameSession.reason).toBe("no-hit");

    const otherProject = autoRetrieve(openDb!, {
      prompt: "authentication",
      cwd: projectB,
      currentSessionId: "other-session",
      requestId: "req-b",
    });
    expect(otherProject.bundle).toBeNull();

    const prompt = "tell me about authentication";
    const before = handleBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt,
        systemPrompt: "BASE",
        systemPromptOptions: {} as never,
      },
      mockCtx(projectA, "other-session"),
      runtime,
    );
    expect(before?.systemPrompt).toBe(`BASE\n\n${TRUST_RULE_TEXT}`);
    expect(before?.systemPrompt).not.toContain("authentication");
    expect(before?.systemPrompt).not.toContain(LINEAR_SESSION);
    expect(runtime.requestContext.active).not.toBeNull();

    const messages = [
      { role: "user", content: prompt },
      { role: "assistant", content: "thinking..." },
      { role: "user", content: prompt },
    ];
    const first = handleContext(
      { type: "context", messages: messages as never },
      mockCtx(projectA, "other-session"),
      runtime,
    );
    expect(first?.messages).toBeDefined();
    expect(countEnvelopesInMessages(first!.messages as never)).toBe(1);

    // tool loop 复用同一 bundle，仍至多一个 envelope
    const second = handleContext(
      { type: "context", messages: first!.messages },
      mockCtx(projectA, "other-session"),
      runtime,
    );
    expect(second).toBeUndefined();
  });

  it("no-hit leaves system prompt untouched", () => {
    const runtime = prepareIndex();
    updateRuntimeConfig(openDb!, { autoRecall: true });
    const before = handleBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "zzzz-unrelated-token-xyz",
        systemPrompt: "BASE",
        systemPromptOptions: {} as never,
      },
      mockCtx(projectA, "other-session"),
      runtime,
    );
    expect(before).toBeUndefined();
    expect(runtime.requestContext.active).toBeNull();
  });

  it("fixture JSONL contains zero envelope / trust markers", () => {
    for (const name of fs.readdirSync(fixturesDir)) {
      if (!name.endsWith(".jsonl")) {
        continue;
      }
      const body = fs.readFileSync(path.join(fixturesDir, name), "utf8");
      expect(body).not.toContain("[[pi-session-recall:envelope");
      expect(body).not.toContain("trust-rule-v1");
    }
  });
});
