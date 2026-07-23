import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { autoRetrieve } from "../../core/injection/auto-retrieve.js";
import { TRUST_RULE_TEXT } from "../../core/injection/constants.js";
import { injectEnvelopeIntoMessages, type AgentMessageLike } from "../../core/injection/inject.js";
import {
  getActiveBundle,
  invalidateBundle,
  newRequestId,
  setActiveBundle,
} from "../../core/injection/request-context.js";
import { rememberError, tryOpenDb, type ExtensionRuntime } from "./runtime.js";

/** context 钩子返回值（主包未 re-export ContextEventResult） */
export type ContextHookResult = { messages: ContextEvent["messages"] };

/**
 * 注册 before_agent_start / context 自动召回钩子（fail-open）。
 */
export function registerAutoHooks(pi: ExtensionAPI, runtime: ExtensionRuntime): void {
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      return handleBeforeAgentStart(event, ctx, runtime);
    } catch (error) {
      rememberError(runtime, error);
      invalidateBundle(runtime.requestContext);
      return undefined;
    }
  });

  pi.on("context", async (event, ctx) => {
    try {
      return handleContext(event, ctx, runtime);
    } catch (error) {
      rememberError(runtime, error);
      return undefined;
    }
  });
}

/**
 * before_agent_start：检索并缓存 bundle；非空时追加 trust rule。
 * 不使用 event.message / sendMessage / appendEntry。
 */
export function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
  runtime: ExtensionRuntime,
): BeforeAgentStartEventResult | undefined {
  invalidateBundle(runtime.requestContext);

  const db = tryOpenDb(runtime);
  if (!db) {
    return undefined;
  }

  const sessionId = ctx.sessionManager.getSessionId();
  const requestId = newRequestId();
  const retrieved = autoRetrieve(db, {
    prompt: event.prompt,
    cwd: ctx.cwd,
    currentSessionId: sessionId,
    requestId,
  });

  setActiveBundle(runtime.requestContext, retrieved.bundle, event.prompt);

  if (!retrieved.bundle) {
    return undefined;
  }

  // 仅追加固定 trust rule；query/正文不进 system prompt
  return {
    systemPrompt: `${event.systemPrompt}\n\n${TRUST_RULE_TEXT}`,
  };
}

/**
 * context：复用 bundle，注入最后一个 user anchor。
 */
export function handleContext(
  event: ContextEvent,
  _ctx: ExtensionContext,
  runtime: ExtensionRuntime,
): ContextHookResult | undefined {
  const bundle = getActiveBundle(runtime.requestContext);
  const prompt = runtime.requestContext.activePrompt;
  if (!bundle || !prompt) {
    return undefined;
  }

  const injected = injectEnvelopeIntoMessages(
    event.messages as unknown as AgentMessageLike[],
    prompt,
    bundle.envelopeText,
  );
  if (!injected) {
    return undefined;
  }
  return { messages: injected as unknown as ContextEvent["messages"] };
}
