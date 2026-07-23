import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectIdentity } from "../../src/core/provenance/project-identity.js";
import { resolveSessionProvenance } from "../../src/core/provenance/resolver.js";

/**
 * Cross-project fork provenance spike：对合成 fixtures 跑规则并写报告。
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesDir = path.join(root, "tests", "fixtures", "sessions");
const reportDir = path.join(root, "docs", "spikes");
const reportPath = path.join(reportDir, "provenance-report.md");

interface CaseResult {
  name: string;
  sessionId: string;
  headerProjectKey: string;
  attributions: Array<{
    entryId: string;
    role: string;
    provenance: string;
    originProjectKey?: string;
    reason?: string;
  }>;
  assertions: Array<{ name: string; pass: boolean; detail: string }>;
}

/**
 * 运行 provenance spike。
 */
function main(): void {
  if (!fs.existsSync(path.join(fixturesDir, "cross-project-fork-child.jsonl"))) {
    throw new Error("Fixtures missing. Run: npm run fixture:build");
  }

  const projectA = resolveProjectIdentity("/tmp/pi-session-recall-fixtures/project-a");
  const projectB = resolveProjectIdentity("/tmp/pi-session-recall-fixtures/project-b");

  const cases: CaseResult[] = [];

  const crossChild = resolveSessionProvenance(
    path.join(fixturesDir, "cross-project-fork-child.jsonl"),
    { registeredRoots: [fixturesDir] },
  );
  cases.push({
    name: "cross-project-fork-child",
    sessionId: crossChild.sessionId,
    headerProjectKey: crossChild.headerProject.projectKey,
    attributions: crossChild.attributions,
    assertions: [
      {
        name: "copied-history-stays-project-a",
        pass: crossChild.attributions
          .slice(0, 2)
          .every(
            (item) =>
              item.provenance === "verified" && item.originProjectKey === projectA.projectKey,
          ),
        detail: `expected origin=${projectA.projectKey.slice(0, 12)}…`,
      },
      {
        name: "child-new-entry-is-project-b",
        pass:
          crossChild.attributions[2]?.provenance === "verified" &&
          crossChild.attributions[2]?.originProjectKey === projectB.projectKey,
        detail: `got=${crossChild.attributions[2]?.originProjectKey?.slice(0, 12)}…`,
      },
      {
        name: "no-leak-to-child-scope-for-copied",
        pass: crossChild.attributions
          .slice(0, 2)
          .every((item) => item.originProjectKey !== projectB.projectKey),
        detail: "copied entries must not use child project key",
      },
    ],
  });

  const missing = resolveSessionProvenance(path.join(fixturesDir, "missing-parent-fork.jsonl"), {
    registeredRoots: [fixturesDir],
  });
  cases.push({
    name: "missing-parent-fork",
    sessionId: missing.sessionId,
    headerProjectKey: missing.headerProject.projectKey,
    attributions: missing.attributions,
    assertions: [
      {
        name: "fail-closed-unresolved",
        pass: missing.attributions.every((item) => item.provenance === "unresolved"),
        detail: `unresolvedCopiedCount=${missing.unresolvedCopiedCount}`,
      },
      {
        name: "not-guessed-as-child-scope",
        pass: missing.attributions.every((item) => item.originProjectKey === undefined),
        detail: "no originProjectKey when parent missing",
      },
    ],
  });

  const sameProject = resolveSessionProvenance(path.join(fixturesDir, "clone-same-project.jsonl"), {
    registeredRoots: [fixturesDir],
  });
  cases.push({
    name: "clone-same-project",
    sessionId: sameProject.sessionId,
    headerProjectKey: sameProject.headerProject.projectKey,
    attributions: sameProject.attributions,
    assertions: [
      {
        name: "all-verified-same-project",
        pass: sameProject.attributions.every(
          (item) => item.provenance === "verified" && item.originProjectKey === projectA.projectKey,
        ),
        detail: `projectA=${projectA.projectKey.slice(0, 12)}…`,
      },
    ],
  });

  const allPass = cases.every((item) => item.assertions.every((assertion) => assertion.pass));
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    reportPath,
    renderReport(cases, projectA.projectKey, projectB.projectKey),
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        ok: allPass,
        reportPath,
        cases: cases.map((item) => ({
          name: item.name,
          pass: item.assertions.every((assertion) => assertion.pass),
          assertions: item.assertions,
        })),
      },
      null,
      2,
    ),
  );

  if (!allPass) {
    process.exitCode = 1;
  }
}

/**
 * 渲染 markdown 报告。
 */
function renderReport(cases: CaseResult[], projectAKey: string, projectBKey: string): string {
  const lines = [
    "# Provenance Spike Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Rules under test",
    "",
    "- No parentSession: origin = header project",
    "- Fork/clone: copied entry fingerprint matches earliest verifiable ancestor origin",
    "- Child-only new entries: origin = child header project",
    "- Missing/out-of-root/cycle parent: fail-closed unresolved (no guessed child scope)",
    "",
    `projectAKey: \`${projectAKey}\``,
    `projectBKey: \`${projectBKey}\``,
    "",
  ];

  for (const item of cases) {
    lines.push(`## Case: ${item.name}`, "");
    lines.push(`sessionId: \`${item.sessionId}\``);
    lines.push(`headerProjectKey: \`${item.headerProjectKey}\``, "");
    lines.push("| entryId | role | provenance | originProjectKey | reason |");
    lines.push("|---|---|---|---|---|");
    for (const attr of item.attributions) {
      lines.push(
        `| ${attr.entryId} | ${attr.role} | ${attr.provenance} | ${attr.originProjectKey ?? ""} | ${attr.reason ?? ""} |`,
      );
    }
    lines.push("", "Assertions:", "");
    for (const assertion of item.assertions) {
      lines.push(`- ${assertion.pass ? "PASS" : "FAIL"} ${assertion.name}: ${assertion.detail}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

main();
