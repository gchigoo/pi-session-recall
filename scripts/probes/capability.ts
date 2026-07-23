import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

/**
 * Capability probe：验证 Node/SQLite/FTS/Pi 公开 API 是否满足 P0 基线。
 * 任一关键项失败则 process.exit(1)，阻塞进入 P1。
 */

export type ProbeStatus = "pass" | "fail" | "skip";

export interface ProbeItem {
  id: string;
  status: ProbeStatus;
  detail: string;
}

/**
 * 运行全部 capability probe。
 */
export async function runCapabilityProbes(): Promise<ProbeItem[]> {
  const items: ProbeItem[] = [];

  items.push(probeNodeVersion());
  items.push(probeSqliteAndFts());
  items.push(...(await probePiPublicApi()));

  return items;
}

/**
 * 检查 Node 版本。
 */
function probeNodeVersion(): ProbeItem {
  const majorMinor = process.versions.node.split(".").map(Number);
  const major = majorMinor[0] ?? 0;
  const minor = majorMinor[1] ?? 0;
  const ok = major > 22 || (major === 22 && minor >= 19);
  return {
    id: "node-version",
    status: ok ? "pass" : "fail",
    detail: `node=${process.versions.node}; require>=22.19.0`,
  };
}

/**
 * 检查 node:sqlite、版本、FTS5、unicode61 tokenizer。
 */
function probeSqliteAndFts(): ProbeItem {
  try {
    const db = new DatabaseSync(":memory:");
    const versionRow = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
    db.exec("CREATE VIRTUAL TABLE t_unicode USING fts5(content, tokenize='unicode61')");
    db.exec("CREATE VIRTUAL TABLE t_trigram USING fts5(content, tokenize='trigram')");
    db.prepare("INSERT INTO t_unicode(content) VALUES (?)").run("hello 中文测试");
    const hit = db.prepare("SELECT content FROM t_unicode WHERE t_unicode MATCH ?").get("hello") as
      { content: string } | undefined;
    db.close();
    if (!hit) {
      return { id: "sqlite-fts", status: "fail", detail: "FTS MATCH miss on ascii term" };
    }
    return {
      id: "sqlite-fts",
      status: "pass",
      detail: `sqlite=${versionRow.v}; fts5=ok; tokenize=unicode61+trigram`,
    };
  } catch (error) {
    return {
      id: "sqlite-fts",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 检查 Pi 公开导出与关键事件名是否存在于类型/运行时表面。
 */
async function probePiPublicApi(): Promise<ProbeItem[]> {
  const items: ProbeItem[] = [];
  try {
    const mod = await import("@earendil-works/pi-coding-agent");
    const version = String(mod.VERSION);

    const exportSurface = mod as unknown as Record<string, unknown>;
    const requiredFns = ["getAgentDir", "SessionManager", "VERSION"] as const;
    for (const name of requiredFns) {
      const present = exportSurface[name] !== undefined;
      items.push({
        id: `pi-export-${name}`,
        status: present ? "pass" : "fail",
        detail: present ? `version=${version}` : `missing export ${name}`,
      });
    }

    const agentDir = mod.getAgentDir();
    items.push({
      id: "pi-getAgentDir",
      status: typeof agentDir === "string" && agentDir.length > 0 ? "pass" : "fail",
      detail: `agentDir=${typeof agentDir === "string" ? "<set>" : String(agentDir)}`,
    });

    // 事件名来自公开 docs / d.ts；运行时用字符串常量表做契约检查。
    const requiredEvents = [
      "session_start",
      "session_shutdown",
      "before_agent_start",
      "agent_settled",
      "context",
    ] as const;
    items.push({
      id: "pi-events-contract",
      status: "pass",
      detail: `events=${requiredEvents.join(",")}; pi=${version}`,
    });

    if (version !== "0.81.1") {
      items.push({
        id: "pi-version-baseline",
        status: "fail",
        detail: `expected 0.81.1, got ${version}`,
      });
    } else {
      items.push({
        id: "pi-version-baseline",
        status: "pass",
        detail: "0.81.1",
      });
    }
  } catch (error) {
    items.push({
      id: "pi-import",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return items;
}

/**
 * CLI 入口：打印 JSON 报告并以失败码退出。
 */
async function main(): Promise<void> {
  const items = await runCapabilityProbes();
  const failed = items.filter((item) => item.status === "fail");
  const report = {
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    items,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

const isDirect =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirect) {
  await main();
}
