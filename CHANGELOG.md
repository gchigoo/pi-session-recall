# Changelog

## 1.0.2

- Bilingual README (English + 中文)
- Add `repository` / `homepage` / `bugs` for npm package page

## 1.0.1

- Fix root ID collision: full-path sha256 IDs + legacy `user-*` 12hex migration
- Fix `index --root` deletion reconcile to only touch scanned roots
- Fix project/eligibility filters applied before FTS candidate LIMIT
- Search only returns chunks from `sessions.status = 'active'`
- Redact bare credential names (`API_KEY`, `TOKEN`, …) and mid-name forms (`AWS_SECRET_ACCESS_KEY`)
- Harden POSIX data-home `0700` and DB/WAL/SHM `0600` permissions
- Index a session file from a single in-memory snapshot (avoid multi-read drift)
- CI matrix: Ubuntu (Node 22/24), macOS (Node 22), Windows (Node 22)

## 1.0.0

- Local-first Pi session index：手动召回、可选自动召回（默认关闭）
- `/recall` + `session_recall`；trust rule + envelope context 注入
- Reconcile / rebuild lease / projection gate / purge 边界
- 质量门：eval corpus、100k warm search、package lifecycle smoke
- 不包含远程 `npm publish`
