# ADR 0002: 保存の原子性は D1 trigger + json_each を第一候補として継続

- 日付：2026-10-15
- 状態：採用（ローカル workerd で実証。本番 D1 は未検証）
- 検証：`apps/web/tests/workers/d1-capabilities.test.ts`

## 背景

設計 §7.3 は「条件付き UPDATE 一文 + AFTER trigger で履歴・changes・名前・リンク・FTS を原子的に更新する」案を第一候補とし、Phase 0/1 で D1 上の実証を求めている。

## 実証結果（miniflare / workerd のローカル D1）

| 確認項目 | 結果 |
|---|---|
| INSERT trigger で revisions / changes / page_names / page_links（`json_each`）/ FTS を生成 | OK |
| 条件付き UPDATE 成功時に派生データが一括更新される | OK |
| `links_json` が変わらない UPDATE ではリンク行を再挿入しない（`AFTER UPDATE OF links_json ... WHEN NEW IS NOT OLD`） | OK（rowid 不変で確認） |
| 古い `baseRevision` の UPDATE は 0 行・派生データ不変 | OK |
| trigger 内の名前衝突（`RAISE(ABORT, 'name_conflict')`）で本文も含め全体が rollback | OK |
| `mutation_id` の UNIQUE 違反で UPDATE 全体が rollback | OK |
| `D1.batch()` の後続文失敗で先行文も rollback | OK |
| FTS5 `tokenize='trigram'` で日本語 3 文字以上の部分一致、英数大小無視、更新反映 | OK |
| FTS5 trigram で 1〜2 文字の検索 | **ヒットしない**（設計どおり LIKE fallback が必要） |

## 重要な発見：`meta.changes` を成功判定に使わない

D1 の `meta.changes` は **trigger が書いた行も含む**（成功した UPDATE 1 行に対し 11 を返した）。0 行 UPDATE の検出には使えるが、「1 行更新された」の判定には使えない。

→ **更新 API は `UPDATE ... RETURNING revision` の結果行数で成功／不成功を判定する**。Phase 1 の repository 実装でこの方式を必須とする。

## 決定

- Phase 1 の migration は trigger 方式で実装する。
- 名前衝突は trigger 内の `RAISE(ABORT, ...)` で表し、API 層で 409 に変換する。
- 成功判定は `RETURNING`。`meta.changes` は使わない。

## 未検証・リスク

- **本番 D1（リモート）で同一の挙動か未検証**。staging 作成後、同じテストシナリオを staging に対して実行する（Phase 1 完了条件に含める）。
- trigger 内の FTS 更新は本文全体を再索引する。10,000 ページ規模の rows written は Phase 5 で計測する。
