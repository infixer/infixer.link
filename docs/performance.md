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

## Phase 1（2026-10-15）

同条件（Apple M4 Pro 開発機、ローカル workerd）。

| 対象 | 予算 | 実測 | 条件・備考 |
|---|---|---|---|
| 公開初回JS（`/`） | gzip ≤ 50KiB | **36.5KiB**（13 files） | 一覧表示を追加。WebAuthn（`navigator.credentials`）を含む chunk は公開ページで読み込まれないことをテストで確認 |
| Worker bundle | Free 3MiB / Paid 10MiB（圧縮後） | 1543.7KiB / gzip **297.8KiB** | Hono・SimpleWebAuthn server・valibot・Temporal polyfill を含む |
| 保存 API p95 | 800ms | 未計測 | 日本からの staging で 50 回以上計測する（staging 未作成） |
| Workers CPU time | Free 10ms | 未計測 | 同上 |

## Phase 2（2026-10-15）

同じ条件（Apple M4 Pro 開発機、ローカル workerd、Chromium、CPU throttle なし）。

| 対象 | 予算 | 実測 | 条件・備考 |
|---|---|---|---|
| 公開初回JS（`/`） | gzip ≤ 50KiB | **39.0KiB**（16 files） | session の問い合わせと「今日」リンクを追加。CodeMirror と WebAuthn は含まない |
| 編集時JS（エディタを開いたページの合計） | gzip ≤ 250KiB | **131.3KiB** | CodeMirror（state / view / commands）、idb、エディタ UI を含む |
| 入力から描画（10,499 文字のページ） | p95 ≤ 50ms | **p50 1.4ms / p95 14.8ms**（138 入力） | `beforeinput` から次の `requestAnimationFrame` まで。Playwright の `keyboard.type` は IME の composition を通らない。実機とスロットリングありは未計測 |
| Worker bundle | Free 3MiB / Paid 10MiB（圧縮後） | 1552.6KiB / gzip **299.4KiB** | |
| 保存 API p95 / LCP / CPU time | — | 未計測 | staging 作成後に計測 |

## Phase 3（2026-10-15）

| 対象 | 予算 | 実測 | 備考 |
|---|---|---|---|
| 公開初回JS（`/`） | gzip ≤ 50KiB | **40.0KiB** | |
| 編集時JS | gzip ≤ 250KiB | **151.2KiB** | 見たまま表示、autocomplete、language、パーサーを含む |
| 入力から描画（10,499 文字） | p95 ≤ 50ms | **p95 15.2ms** | 見たまま表示の decoration を毎回すべて作り直した状態で計測。表示範囲だけに絞る最適化はしていない |

### メモ

- 公開初回 JS の大半（約 28KiB）は SvelteKit のクライアントルーター／hydration。公開ページを `csr = false` にすれば 0 にできるが、同一 URL 編集（設計 §9.1）でクライアント側の session 照会と遅延読み込みが必要なため、Phase 2 で判断する。
