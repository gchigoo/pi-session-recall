# pi-session-recall

本地优先的 Pi package：只读索引 Pi session，手动搜索，可选自动召回（`v1.0.0`，默认关闭）。

## 要求

- Node.js `>=22.19.0`
- Pi `@earendil-works/pi-coding-agent` `0.81.1`
- OS：Windows / Linux / macOS；Session：Pi JSONL v3

## 安装

```bash
pi install /absolute/path/to/pi-session-recall
# 或开发加载
pi -e ./extensions/index.ts
```

安装本身不扫描历史。Package 具备本机权限——只安装可信源码。

## 快速开始

```bash
# Companion CLI
npm run cli -- setup --root ~/.pi/agent/sessions
npm run cli -- index
npm run cli -- search "认证" --scope project --json

# 在 Pi TUI
/recall setup
/recall search 认证
/recall search --all shared keyword
/recall config auto on   # 可选；确认后临时注入相关历史
```

Agent tool：`session_recall({ query, limit? })` — 仅当前 project。

自动召回：`before_agent_start` 检索 + 固定 trust rule；`context` 注入 versioned envelope（不写 JSONL，≤4/≤600）。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `PI_SESSION_RECALL_HOME` | `~/.pi/agent/pi-session-recall` | data-home |
| `autoRecall` | `false` | `/recall config auto on\|off` |
| 手动/tool limit | 5（max 20/10） | runtime_config |

## 安全与隐私

- 不修改 Pi 原始 JSONL
- 索引为明文本地副本；known secret 脱敏/拒绝；未知 secret 可能残留
- tool 输出不含 path；thinking/tool 内容不索引
- 跨项目 fork 不泄漏；partial rebuild 时自动召回关闭
- 默认日志不含 query/正文/绝对路径

## 清理边界

| 操作 | 删除 | 保留 |
|---|---|---|
| `purge-index` | chunks/FTS/cursors | data-home、Pi JSONL |
| `purge-data` | 整个扩展 data-home | Pi JSONL（需重启进程后再 setup） |
| 移除 package | 扩展注册 | data-home（除非另跑 purge-data）、Pi JSONL |

## 开发与质量门

```bash
npm install
npm run check
npm run test:integration
npm run test:security
npm run eval:recall
npm run bench:recall
npm run test:package
npm run pack:dry
# 或
npm run release:gate
```

Changelog：[`CHANGELOG.md`](CHANGELOG.md)。

本仓库不授权远程 `npm publish`，除非 owner 另行明确授权。
