# ADR 0001: Phase 0 の採用スタックとバージョン

- 日付：2026-10-15
- 状態：採用

## 決定

| 項目 | 採用 | 理由・備考 |
|---|---|---|
| パッケージ管理 | pnpm 10 workspace（`apps/*`, `packages/*`） | 設計 §16。monorepo管理フレームワークは入れない |
| Node.js | 24（`.nvmrc`） | ローカル環境と一致。CLI（Phase 7）も同じLTS系 |
| SvelteKit | `@sveltejs/kit` 3.1 / `svelte` 5.57 / Vite 8 | `sv create`（sv 1.1.1）で生成 |
| Adapter | `@sveltejs/adapter-cloudflare` 8.0（Workers + Static Assets） | |
| TypeScript | 6.0 系 | Kit 3 と svelte-check 4 の peer が `^6`。TS 7 は未対応のため不採用 |
| Wrangler | 4.151 | `compatibility_date: 2026-10-15`、flag は `nodejs_als` のみ |
| テスト | Vitest 4.1 / `@cloudflare/vitest-plugin` 1.4 / Playwright 1.6x | 下記参照 |
| 日付 | `@js-temporal/polyfill` 0.5.1 を `@infixer-link/time` に集約 | 下記参照 |
| WebAuthn | `@simplewebauthn/server` 14.0（Phase 0 は devDependency で検証のみ） | ADR 0003 |

正確なバージョンは `pnpm-lock.yaml` で固定する。

## Phase 0 で判明したこと

1. **`@cloudflare/vitest-pool-workers` は deprecated**。`@cloudflare/vitest-plugin` に改名された（`cloudflareTest()` プラグイン、`env` は `cloudflare:workers` から import）。Vitest 5 系ではなく 4.1 系を採用（Kit scaffold と plugin の両方が対応）。
2. **SvelteKit 3 + adapter-cloudflare 8 では `event.platform.env` が無い**。bindings は `import { env } from 'cloudflare:workers'` で読む。`App.Platform` の宣言は削除した。
3. **workerd（compatibility_date 2026-10-15）と Node 24 にネイティブ Temporal は無い**。サーバーでは polyfill が常に使われる（`/api/health` の `temporal: "polyfill"` で確認可能）。`@infixer-link/time` はネイティブがあればそれを使う。TypeScript 6 の lib が global `Temporal` 型を持つため、型は polyfill 側に統一している。
4. **`wrangler types` が生成する `worker-configuration.d.ts` は build 出力（`.svelte-kit/cloudflare/_worker.js`）の有無で内容が変わる**（存在すれば `mainModule` 型を追加）。コミットすると、clean checkout の CI で `wrangler types --check` が失敗した。→ このファイルは Git 管理せず、`prepare`（install 時）と `check` で毎回生成する。`build` から `--check` を外した。svelte-check が生成 JS を検査しないよう `checkJs: false` と `exclude` を設定。
5. production の `workers_dev` / `preview_urls` は `false`（設計 §9.8）。

## 代案

- Vitest 5：`@cloudflare/vitest-plugin` は対応済みだが、scaffold の構成と合わせ 4.1 を採用。Phase 1 以降で必要になれば更新する。
- `temporal-polyfill`（別実装、小さい）：設計で `@js-temporal/polyfill` が指定されているため不採用。公開画面にクライアント側 Temporal を配信する必要が出た時点でサイズを比較する。
