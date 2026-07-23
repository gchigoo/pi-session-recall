import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Extension load smoke：pi -e 加载 P3 extension。
 * 无模型 API key 时允许非零退出，只要扩展模块可加载且无注册错误。
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "extensions", "index.ts");
const piBin = process.platform === "win32" ? "pi.cmd" : "pi";

const smoke = spawnSync(piBin, ["-e", extension, "--no-session", "--no-tools", "-p", "pong"], {
  cwd: root,
  encoding: "utf8",
  timeout: 90_000,
  env: { ...process.env },
  shell: process.platform === "win32",
});

const combined = `${smoke.stdout ?? ""}\n${smoke.stderr ?? ""}\n${smoke.error?.message ?? ""}`;
const loadError =
  /Cannot find module|SyntaxError|Failed to load extension|registerCommand|registerTool/i.test(
    combined,
  ) && /pi-session-recall|extensions/i.test(combined);

console.log(
  JSON.stringify(
    {
      status: smoke.status,
      error: smoke.error?.message ?? null,
      loadError,
      stdoutPreview: (smoke.stdout ?? "").slice(0, 500),
      stderrPreview: (smoke.stderr ?? "").slice(0, 500),
    },
    null,
    2,
  ),
);

if (loadError || smoke.error) {
  process.exitCode = 1;
}
