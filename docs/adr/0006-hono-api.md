# ADR 0006: JSON API は Hono で実装する

- 日付：2026-10-15
- 状態：採用（ユーザー指示）
- 変更する設計：§1.2「APIフレームワークを重ねない」、§2「別Hono APIを加えない」

## 決定

`/api/*` の JSON API（public / auth / owner）を **Hono** で実装する。Worker は 1 つのまま、SvelteKit の catch-all ルート `src/routes/api/[...path]/+server.ts` の `fallback` から Hono アプリ（`src/lib/server/api/app.ts`）に委譲する。ページ（SSR）は引き続き SvelteKit。

| 項目 | 内容 |
|---|---|
| ルーティング | `createApi({ db, config, now })` が `basePath('/api')` の Hono アプリを返す |
| バリデーション | `@hono/standard-validator` に `@infixer-link/contracts` の valibot スキーマ（Standard Schema）をそのまま渡す。非 JSON は 415、スキーマ不一致は 422 |
| エラー | `ApiError` → `{ code, message, requestId, retryable }`（設計 §8） |
| ミドルウェア | requestId、bodyLimit（512KiB）、Host/Origin 検査、セッション解決、CSRF、IP 単位レート制限 |
| 型付きクライアント | `export type ApiApp` を Phase 7 の CLI で `hono/client` に使う |

## 理由

- ユーザーの指示。
- 依存を注入して作るため、workerd 内のテストから `app.request()` で HTTP レベル（Cookie・ヘッダー・ステータス）まで検証できる。
- `hc<ApiApp>` で Web と CLI が同じ型の API クライアントを持てる。

## 代案

- **別 Worker に Hono を分離**：デプロイ単位とルーティング（同一 origin）・binding 共有が増えるため不採用。
- **adapter が生成する Worker エントリをラップ**：adapter-cloudflare の生成物に依存し壊れやすいため不採用。

## 影響

- 依存追加：`hono`、`@hono/standard-validator`、`@standard-schema/spec`。Worker bundle の増加は Phase 1 の計測で記録（`docs/performance.md`）。
- SvelteKit の `+page.server.ts` は API を HTTP 経由で呼ばず、同じサービス層（`src/lib/server/pages`・`auth`）を直接呼ぶ。
