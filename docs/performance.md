# 性能計測記録

設計 §12.2 の予算に対する実測値を追記していく。測定条件を必ず併記し、未計測は未計測と書く。

## Phase 0（2026-10-15）

環境：Apple M4 Pro 開発機、Node 24.2、ローカル `wrangler dev`（workerd）。ネットワーク条件の throttle なし。

| 対象 | 予算 | 実測 | 条件・備考 |
|---|---|---|---|
| 公開初回JS（`/`） | gzip ≤ 50KiB | **32.8KiB**（10 files） | `pnpm perf:bundle`。Playwright で `/` 読み込み時の script 応答を gzip 計測。hello ページのみで、Svelte runtime + router が主 |
| Worker bundle | —（Workers 上限: Free 3MiB / Paid 10MiB 圧縮後） | 542.9KiB / gzip **124.2KiB** | `wrangler deploy --dry-run`。Temporal polyfill を含む |
| WebAuthn 検証 CPU | Free プラン 10ms/req 以内か判断材料 | 認証 median 0.19ms / p95 0.29ms | `node scripts/bench-webauthn.ts`（V8 上の目安。Workers 実測ではない） |
| 公開 LCP / CLS / INP | p75 2.5s / 0.1 / 200ms | 未計測 | 本文表示が実装される Phase 2〜5 で計測 |
| 保存・検索・関連 API | p95 800 / 500 / 500ms | 未計測 | Phase 1〜5 |
| Workers CPU time（実環境） | Free 10ms | **未計測** | staging deploy 後に Workers Observability で確認 |

### メモ

- 公開初回 JS の大半（約 28KiB）は SvelteKit のクライアントルーター／hydration。公開ページを `csr = false` にすれば 0 にできるが、同一 URL 編集（設計 §9.1）でクライアント側の session 照会と遅延読み込みが必要なため、Phase 2 で判断する。
