# AGENTS.md

個人用公開 Wiki・デイリー **infixer.link**。名称に「garden」は使わない（ADR 0005）。

## 必読

1. [`docs/design.md`](docs/design.md)：設計と Phase 計画（正本）
2. [`docs/implementation-status.md`](docs/implementation-status.md)：現在の Phase・未検証事項
3. [`docs/adr/`](docs/adr/)：設計からの変更・実証結果

## 進め方

- 指定された Phase だけを実装する。完了したら status を更新し、報告して確認を待つ。
- ブランチは Phase ごと（`phase-N`）。stacked PR で `phase-(N-1)` に積む。
- 設計を変える場合は理由・代案・影響を ADR に残す。黙って方針（クラウド正本、公開範囲、同一URL編集、パスキー認証）を変えない。
- テストを追加し、実行結果を記録する。未実行・未検証は未検証と書く。

## 制約

- リポジトリは **公開**。secret・token・`.dev.vars`・Cloudflare の resource ID 以外の秘密をコミットしない。
- Cloudflare の resource 作成、deploy、課金が発生する設定は、その都度ユーザーの承認を得る。
- 本番 RP ID / origin は `infixer.link` / `https://infixer.link`、staging は `staging.infixer.link`（ADR 0004）。Host header から生成しない。
- フロントは SvelteKit + TypeScript + 生CSS（Tailwind・UI キット不可）。日付は `@infixer-link/time` 経由の Temporal。
- bindings は `import { env } from 'cloudflare:workers'` で読む（SvelteKit 3 / adapter-cloudflare 8）。
- `/api/*` は Hono（`src/lib/server/api/app.ts`、ADR 0006）。ページの load は HTTP を経由せず、サービス層（`src/lib/server/pages`・`auth`）を直接呼ぶ。
- 複数行の原子的な確定は `tx_guard` パターン（ADR 0007）。テスト専用の認証バイパスは作らない。
- D1 の更新成功判定は `RETURNING` で行い、`meta.changes` を使わない（ADR 0002）。
- browser 用コードから `$lib/server`・secret・D1 を import しない。`tests/helpers` をアプリから import しない。

## コマンド

```sh
pnpm install
pnpm dev                          # vite dev（apps/web）
pnpm --filter web test            # unit + workers 統合テスト
pnpm --filter web test:e2e        # build + wrangler dev + Playwright
pnpm --filter web check && pnpm --filter web lint
pnpm --filter './packages/**' test
pnpm --filter web db:migrate      # ローカル D1 にマイグレーション
pnpm --filter web db:seed         # サンプルページ
pnpm --filter web owner:grant     # セットアップコード発行（ops/runbooks/owner-auth.md）
```
