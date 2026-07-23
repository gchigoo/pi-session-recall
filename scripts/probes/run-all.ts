import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 依次运行 P0 probes / fixture build / spikes。
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

const steps = [
  "scripts/probes/capability.ts",
  "scripts/build-fixtures.ts",
  "scripts/spikes/provenance.ts",
  "scripts/spikes/cjk-retrieval.ts",
] as const;

let failed = false;
for (const script of steps) {
  console.log(`\n=== ${script} ===`);
  const result = spawnSync(process.execPath, [tsxCli, script], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
}
