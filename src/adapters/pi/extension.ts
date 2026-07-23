import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoHooks } from "./auto-hooks.js";
import { registerRecallCommand } from "./commands.js";
import { registerLifecycle } from "./lifecycle.js";
import { createRuntime } from "./runtime.js";
import { createSessionRecallTool } from "./tool.js";

/**
 * Pi extension 入口（P4：手动召回 + 可选自动召回）。
 * - /recall 与 session_recall tool
 * - agent_settled 有界增量索引
 * - autoRecall 默认关闭；开启后 before_agent_start + context 临时注入
 */
export default function piSessionRecallExtension(pi: ExtensionAPI): void {
  const runtime = createRuntime();

  registerRecallCommand(pi, runtime);
  pi.registerTool(createSessionRecallTool(runtime));
  registerLifecycle(pi, runtime);
  registerAutoHooks(pi, runtime);
}
