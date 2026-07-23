import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 本地 package lifecycle smoke：build → pack allowlist → CLI setup/index/purge。
 * 不执行远程 npm publish。
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOW_PREFIXES = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "dist/",
  "src/",
  "extensions/",
  "bin/",
];

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
    timeout: 180_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

run("npm", ["run", "build"]);

const packListOut = run("npm", ["pack", "--dry-run", "--json"]);
const parsed = JSON.parse(packListOut) as Array<{ files?: Array<{ path: string }> }>;
const tarballFiles = (parsed[0]?.files ?? []).map((f) => f.path.replaceAll("\\", "/"));

const forbidden = tarballFiles.filter((file) => {
  if (file === "package.json") {
    return false;
  }
  return !ALLOW_PREFIXES.some(
    (prefix) => file === prefix.replace(/\/$/, "") || file.startsWith(prefix),
  );
});

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "psr-pkg-"));
const sessions = path.join(tmpHome, "sessions");
const dataHome = path.join(tmpHome, "data");
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(
  path.join(sessions, "tiny.jsonl"),
  `${JSON.stringify({
    type: "session",
    version: 3,
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/pkg-lifecycle",
  })}\n${JSON.stringify({
    type: "message",
    id: "abcd1234",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: "pkg lifecycle term", timestamp: 1 },
  })}\n`,
  "utf8",
);

const cliEnv = { PI_SESSION_RECALL_HOME: dataHome };
run("npx", ["tsx", "bin/pi-session-recall.ts", "setup", "--root", sessions], cliEnv);
run("npx", ["tsx", "bin/pi-session-recall.ts", "index"], cliEnv);
const searchOut = run(
  "npx",
  ["tsx", "bin/pi-session-recall.ts", "search", "lifecycle", "--scope", "all", "--json"],
  cliEnv,
);
run("npx", ["tsx", "bin/pi-session-recall.ts", "purge-index"], cliEnv);
run("npx", ["tsx", "bin/pi-session-recall.ts", "purge-data"], cliEnv);

const dataHomeExists = fs.existsSync(dataHome);
fs.rmSync(tmpHome, { recursive: true, force: true });

const searchOk = /lifecycle|hits/i.test(searchOut);
const report = {
  ok: forbidden.length === 0 && !dataHomeExists && searchOk,
  tarballFileCount: tarballFiles.length,
  forbidden,
  purgeDataRemovedHome: !dataHomeExists,
  searchOk,
  note: "Local lifecycle only; remote npm publish is not authorized.",
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  process.exitCode = 1;
}
