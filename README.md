# pi-session-recall

[English](README.md) | [中文](README.zh-CN.md)

Local-first Pi package: read-only indexing of Pi sessions, manual search, and optional auto-recall (`v1.0.2`, off by default).

Repository: [github.com/gchigoo/pi-session-recall](https://github.com/gchigoo/pi-session-recall)

## Requirements

- Node.js `>=22.19.0`
- Pi `@earendil-works/pi-coding-agent` `0.81.1`
- OS: Windows / Linux / macOS; Sessions: Pi JSONL v3

## Install

```bash
# From npm
npm i -g pi-session-recall
# or local path for Pi
pi install /absolute/path/to/pi-session-recall
# Dev load
pi -e ./extensions/index.ts
```

Install does not scan history. The package has local machine access — only install from trusted sources.

## Quick start

```bash
# Companion CLI
pi-session-recall setup --root ~/.pi/agent/sessions
pi-session-recall index
pi-session-recall search "authentication" --scope project --json

# In Pi TUI
/recall setup
/recall search authentication
/recall search --all shared keyword
/recall config auto on   # optional; after confirm, injects relevant history temporarily
```

Agent tool: `session_recall({ query, limit? })` — current project only.

Auto-recall: `before_agent_start` retrieval + fixed trust rule; `context` injects a versioned envelope (not written to JSONL, ≤4 records / ≤600 tokens).

## Configuration

| Item                     | Default                         | Notes                         |
| ------------------------ | ------------------------------- | ----------------------------- |
| `PI_SESSION_RECALL_HOME` | `~/.pi/agent/pi-session-recall` | data-home                     |
| `autoRecall`             | `false`                         | `/recall config auto on\|off` |
| Manual / tool limit      | 5 (max 20 / 10)                 | runtime_config                |

## Security and privacy

- Does not modify original Pi JSONL
- Index is a local plaintext copy; known secrets are redacted or rejected; unknown secrets may remain
- POSIX: data-home `0700`, `index.sqlite` / `-wal` / `-shm` `0600`; Windows uses default ACLs (no extra chmod)
- Tool output contains no paths; thinking / tool content is not indexed
- Cross-project forks do not leak; auto-recall turns off during partial rebuild
- Default logs omit query text, body text, and absolute paths

## Cleanup boundaries

| Action         | Deletes                    | Keeps                                         |
| -------------- | -------------------------- | --------------------------------------------- |
| `purge-index`  | chunks / FTS / cursors     | data-home, Pi JSONL                           |
| `purge-data`   | entire extension data-home | Pi JSONL (restart process before setup again) |
| Remove package | extension registration     | data-home (unless `purge-data`), Pi JSONL     |

## Development and quality gates

```bash
npm install
npm run check
npm run test:integration
npm run test:security
npm run eval:recall
npm run bench:recall
npm run test:package
npm run pack:dry
# or
npm run release:gate
```

Changelog: [`CHANGELOG.md`](CHANGELOG.md).
