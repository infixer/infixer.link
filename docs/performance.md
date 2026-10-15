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

## Phase 4（2026-10-15）

| 対象 | 予算 | 実測 | 備考 |
|---|---|---|---|
| 公開初回JS | gzip ≤ 50KiB | **41.1KiB** | |
| 編集時JS | gzip ≤ 250KiB | **155.0KiB** | アップロード管理を含む |
| 入力から描画（10,499 文字） | p95 ≤ 50ms | **p95 16.4ms** | |
| Worker bundle | Free 3MiB | gzip **314.0KiB** | |
| CLS（画像入り） | ≤ 0.1 | 未計測 | `width` / `height` 属性で縦横比を予約している。実測は Phase 5 |

## Phase 5（2026-10-16）

同じ開発機（Apple M4 Pro、ローカル workerd + ローカル D1）。**Cloudflare 上の値ではない**。rows read / written は D1 の `meta` の値（D1 の課金の単位）。

### 合成データ（`pnpm --filter web perf:data`、`tests/perf/data.perf.ts`）

決定的な合成データ（`scripts/synthetic.ts`）：日記 40%、本文は平均約 650 文字（3% は 9,000 文字前後）、1 ページに 2〜6 リンク、30% のページにハブのタグ `#読書`、出現頻度の決まった目印の語。各操作を 30 回計測（ウォームアップ 1 回の後）。

| 規模 | 投入時間 | rows written / ページ |
|---|---|---|
| 2,000 ページ | 0.7 秒 | 28.9 |
| 10,000 ページ | 4.8 秒 | 28.9 |

**検索（上位 20 件。予算 p95 500ms）**

| 検索語 | 2,000：p95 ms / rows read | 10,000：p95 ms / rows read | 10,000 の件数 |
|---|---|---|---|
| 1 文字（LIKE）`本` | 8 / 4,008 | 33 / 23,789 | 20 |
| 2 文字（LIKE）`読書` | 8 / 3,742 | 40 / 19,119 | 20 |
| 3 文字（FTS）`オイデ` | 1 / 77 | 1 / 242 | 20 |
| 長い語（FTS、約 0.5% のページ） | 1 / 77 | 1 / 242 | 20 |
| 1 件だけの語（FTS） | 1 / 7 | 1 / 7 | 1 |
| 英字・大小無視（FTS）`cloudflare` | 3 / 952 | 11 / 5,127 | 20 |
| 英数 2 文字（LIKE）`d1` | 7 / 3,790 | 32 / 18,699 | 20 |
| 複数語（FTS + LIKE）`Cloudflare 設定` | 2 / 952 | 13 / 5,127 | 20 |
| ヒットなし（FTS） | 1 / 4 | 1 / 4 | 0 |
| ヒットなし（LIKE）`鬱` | 4 / 2,004 | 18 / 10,004 | 0 |
| 日付の前方一致 `2021-03` | 2 / 909 | 2 / 844 | 20 |

**一覧・ページ・関連（予算：関連 p95 500ms）**

| 対象 | 2,000：p95 ms / rows read | 10,000：p95 ms / rows read |
|---|---|---|
| 一覧の先頭 30 件 | 1 / 31 | 1 / 31 |
| 一覧の 21 ページ目（カーソル） | 1 / 32 | 1 / 32 |
| 関連ページ（`#読書` を含むページ。接続集中） | 2 / 5,420 | 8 / 27,673 |
| 公開ページの load 相当（`#読書` を含むページ。5 文） | 2 / 5,435 | 10 / 27,700 |
| 公開ページの load 相当（最長のページ。5 文） | 2 / 401 | 1 / 311 |
| 補完（本人用、2 文字） | 1 / 2,006 | 1 / 10,001 |

**保存 1 回（UPDATE と trigger）**

| | rows written | rows read |
|---|---|---|
| 0005 の前（`DELETE FROM pages_fts WHERE page_id = ?`） | 10 | **10,006**（10,000 ページ） |
| 0005 の後（rowid で入れ替え） | 10 | **8** |

### 公開表示（Playwright、Chromium、`tests/e2e/vitals.e2e.ts`・`bundle-budget.e2e.ts`）

| 対象 | 予算 | 実測 | 備考 |
|---|---|---|---|
| 公開初回 JS（`/`） | gzip ≤ 50KiB | **41.3KiB** | |
| 公開初回 JS（`/search`） | gzip ≤ 50KiB | **43.1KiB** | 入力中の検索を含む |
| CLS（画像 2 枚のページ、390×844） | ≤ 0.1 | 修正前 **0.224** → 修正後 **0.000** | 画像の応答を 800ms 遅らせた最悪のケース。ADR 0013 |
| LCP（同じページ） | p75 2.5 秒 | 824〜848ms | ローカル・スロットリングなし。画像を 800ms 遅らせているので、ほぼその時間 |
| 編集時 JS | gzip ≤ 250KiB | 155.5KiB | 変化なし |
| 入力から描画（10,499 文字） | p95 ≤ 50ms | p95 15.2〜15.8ms | 変化なし |

### 一覧のカード表示（ADR 0014、同日に追加）

| 対象 | 2,000：p95 ms / rows read | 10,000：p95 ms / rows read | 備考 |
|---|---|---|---|
| 一覧の先頭 30 件 | 2 / 95 | 1 / 95 | 行の一覧のときは 31 行。サムネイルの候補の解決（`json_each`・`assets`・`link_previews`）が増えた |
| 一覧の 21 ページ目（カーソル） | 2 / 96 | 2 / 96 | |
| 公開初回 JS（`/`） | | 41.5KiB | 予算 50KiB |

合成データには画像やカードがない（候補は空）ので、候補がある場合の rows read は 1 候補あたり数行増える見込み（未計測）。

### 分かったこと・未達の理由

- 予算（時間）はローカルではすべて満たす。**本番 D1 での時間は未計測**（staging 未作成）。cold / warm の比較、モバイル回線相当での LCP も staging と実機が必要。
- **1〜2 文字の検索は全ページを読む**（10,000 ページで 1 回 1〜2.4 万行）。trigram の性質上、索引では探せない。
- **関連ページはハブの大きさに比例して読む**。`#読書` が 3,000 ページにあると、そのタグを含むページを開くたびに約 2.8 万行を読む。時間は問題ないが、rows read が閲覧数に比例する。対策は ADR 0013 の「残るリスク」。
- 検索の rows read は、名前の `LIKE '%…%'` をやめたことで、FTS で見つかる検索なら 10,000 前後 → 4〜242 行になった。

### メモ

- 公開初回 JS の大半（約 28KiB）は SvelteKit のクライアントルーター／hydration。公開ページを `csr = false` にすれば 0 にできるが、同一 URL 編集（設計 §9.1）でクライアント側の session 照会と遅延読み込みが必要なため、Phase 2 で判断する。
