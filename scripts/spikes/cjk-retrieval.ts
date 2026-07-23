import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL, fileURLToPath } from "node:url";
import { cjkBigrams, queryTerms } from "../../src/core/retrieval/cjk-terms.js";

/**
 * CJK / tokenizer / rank spike（roadmap §5.5）。
 * 比较 unicode61 原文列、trigram、以及原文 + CJK bigram 混合方案。
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reportDir = path.join(root, "docs", "spikes");
const reportPath = path.join(reportDir, "cjk-retrieval-report.md");

interface CorpusDoc {
  id: string;
  text: string;
}

interface QueryCase {
  id: string;
  query: string;
  relevantIds: string[];
}

interface StrategyResult {
  name: string;
  recallAt5: number;
  hits: Array<{ queryId: string; got: string[]; ok: boolean }>;
  notes: string;
}

const corpus: CorpusDoc[] = [
  { id: "d1", text: "用户登录认证流程说明" },
  { id: "d2", text: "中文短词检索测试：认证" },
  { id: "d3", text: "mixed EN/中文 authentication 认证 gateway" },
  { id: "d4", text: "filename path src/auth/session_manager.ts" },
  { id: "d5", text: "kebab-case foo-bar and snake_case foo_bar symbols" },
  { id: "d6", text: "Redis 缓存失效策略讨论" },
  { id: "d7", text: "无关内容：天气预报与购物清单" },
  { id: "d8", text: "code symbol Object.prototype.hasOwnProperty.call" },
  { id: "d9", text: "项目B 新问题 beta 不相关" },
  { id: "d10", text: "session recall 手动搜索 当前项目" },
];

const queries: QueryCase[] = [
  { id: "q-cjk-2", query: "认证", relevantIds: ["d1", "d2", "d3"] },
  { id: "q-cjk-4", query: "登录认证", relevantIds: ["d1"] },
  { id: "q-mixed", query: "authentication 认证", relevantIds: ["d3"] },
  { id: "q-file", query: "session_manager.ts", relevantIds: ["d4"] },
  { id: "q-snake", query: "foo_bar", relevantIds: ["d5"] },
  { id: "q-kebab", query: "foo-bar", relevantIds: ["d5"] },
  { id: "q-en", query: "Redis", relevantIds: ["d6"] },
  { id: "q-code", query: "hasOwnProperty", relevantIds: ["d8"] },
];

/**
 * 转义 FTS5 词项并加引号。
 */
function quoteTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/**
 * 运行一种 FTS 策略。
 */
function runStrategy(name: "unicode61" | "trigram" | "unicode61+cjk-bigram"): StrategyResult {
  const db = new DatabaseSync(":memory:");
  if (name === "unicode61") {
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, content, tokenize='unicode61')");
    const insert = db.prepare("INSERT INTO docs(id, content) VALUES (?, ?)");
    for (const doc of corpus) {
      insert.run(doc.id, doc.text);
    }
  } else if (name === "trigram") {
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, content, tokenize='trigram')");
    const insert = db.prepare("INSERT INTO docs(id, content) VALUES (?, ?)");
    for (const doc of corpus) {
      insert.run(doc.id, doc.text);
    }
  } else {
    db.exec(
      "CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, content, cjk, tokenize='unicode61')",
    );
    const insert = db.prepare("INSERT INTO docs(id, content, cjk) VALUES (?, ?, ?)");
    for (const doc of corpus) {
      insert.run(doc.id, doc.text, cjkBigrams(doc.text).join(" "));
    }
  }

  const hits: StrategyResult["hits"] = [];
  let success = 0;
  for (const query of queries) {
    const terms = queryTerms(query.query);
    let got: string[] = [];
    try {
      if (name === "unicode61+cjk-bigram") {
        const match = terms
          .map((term) => `content:${quoteTerm(term)} OR cjk:${quoteTerm(term)}`)
          .join(" OR ");
        const rows = db
          .prepare(`SELECT id FROM docs WHERE docs MATCH ? ORDER BY bm25(docs) LIMIT 5`)
          .all(match) as Array<{ id: string }>;
        got = rows.map((row) => row.id);
      } else if (name === "trigram") {
        // trigram 对短串更敏感，直接用原始 query 引号匹配
        const rows = db
          .prepare(`SELECT id FROM docs WHERE docs MATCH ? ORDER BY bm25(docs) LIMIT 5`)
          .all(quoteTerm(query.query)) as Array<{ id: string }>;
        got = rows.map((row) => row.id);
      } else {
        const match = terms.map((term) => quoteTerm(term)).join(" OR ");
        const rows = db
          .prepare(`SELECT id FROM docs WHERE docs MATCH ? ORDER BY bm25(docs) LIMIT 5`)
          .all(match) as Array<{ id: string }>;
        got = rows.map((row) => row.id);
      }
    } catch {
      got = [];
    }

    const ok = query.relevantIds.some((id) => got.includes(id));
    if (ok) {
      success += 1;
    }
    hits.push({ queryId: query.id, got, ok });
  }

  db.close();
  return {
    name,
    recallAt5: success / queries.length,
    hits,
    notes:
      name === "unicode61"
        ? "baseline; weak on 2-char CJK without whitespace"
        : name === "trigram"
          ? "substring-friendly; watch index size and symbol noise"
          : "preset: weighted content + CJK bigram terms",
  };
}

/**
 * 主入口。
 */
function main(): void {
  const strategies = [
    runStrategy("unicode61"),
    runStrategy("trigram"),
    runStrategy("unicode61+cjk-bigram"),
  ];

  const preset = strategies.find((item) => item.name === "unicode61+cjk-bigram")!;
  const unicode = strategies.find((item) => item.name === "unicode61")!;
  const recommendation =
    preset.recallAt5 >= unicode.recallAt5
      ? "Freeze FTS projection as weighted content + cjk bigram terms column."
      : "Revisit trigram; unicode61 alone is insufficient for 2-char CJK.";

  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, renderReport(strategies, recommendation), "utf8");

  const cjk2 = preset.hits.find((item) => item.queryId === "q-cjk-2");
  const ok = (cjk2?.ok ?? false) && preset.recallAt5 >= 0.75;

  console.log(
    JSON.stringify(
      {
        ok,
        reportPath,
        recommendation,
        strategies: strategies.map((item) => ({
          name: item.name,
          recallAt5: item.recallAt5,
          hits: item.hits,
        })),
      },
      null,
      2,
    ),
  );

  if (!ok) {
    process.exitCode = 1;
  }
}

/**
 * 渲染 markdown 报告。
 */
function renderReport(strategies: StrategyResult[], recommendation: string): string {
  const lines = [
    "# CJK Retrieval Spike Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Corpus",
    "",
    `docs=${corpus.length}, queries=${queries.length}`,
    "",
    "Pinyin is out of v1 scope.",
    "",
    "## Results",
    "",
  ];

  for (const strategy of strategies) {
    lines.push(`### ${strategy.name}`, "");
    lines.push(`Recall@5 (any-relevant): **${strategy.recallAt5.toFixed(3)}**`);
    lines.push(`Notes: ${strategy.notes}`, "");
    lines.push("| query | ok | got |");
    lines.push("|---|---|---|");
    for (const hit of strategy.hits) {
      lines.push(`| ${hit.queryId} | ${hit.ok ? "yes" : "no"} | ${hit.got.join(", ")} |`);
    }
    lines.push("");
  }

  lines.push("## Recommendation", "", recommendation, "");
  return `${lines.join("\n")}\n`;
}

const isDirect =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirect) {
  main();
}
