import { randomUUID } from "node:crypto";
import type { RecallBundle } from "./envelope.js";

/**
 * RequestContext：before_agent_start 建 bundle，tool loop 复用，settled/新 prompt 失效。
 */

export interface RequestContextState {
  active: RecallBundle | null;
  /** 最近一次 before_agent_start 的 prompt，供 context 注入匹配 */
  activePrompt: string | null;
  generation: number;
}

/**
 * 创建空 RequestContext。
 */
export function createRequestContext(): RequestContextState {
  return { active: null, activePrompt: null, generation: 0 };
}

/**
 * 生成 request id。
 */
export function newRequestId(): string {
  return randomUUID();
}

/**
 * 安装新 bundle（新 user prompt）。
 */
export function setActiveBundle(
  state: RequestContextState,
  bundle: RecallBundle | null,
  prompt: string,
): void {
  state.active = bundle;
  state.activePrompt = prompt;
  state.generation += 1;
}

/**
 * 使 bundle 失效。
 */
export function invalidateBundle(state: RequestContextState): void {
  state.active = null;
  state.activePrompt = null;
  state.generation += 1;
}

/**
 * 读取可注入的 active bundle。
 */
export function getActiveBundle(state: RequestContextState): RecallBundle | null {
  return state.active;
}
