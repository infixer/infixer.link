# 実装状況

設計：[`docs/design.md`](design.md)。各 Phase は stacked PR（`phase-N` は `phase-(N-1)` の上）で進める。

| Phase | 状態 | ブランチ |
|---|---|---|
| 0 基盤と性能・互換性の実証 | **完了（ローカル）** | `phase-0` |
| 1 データと本人認証 | 未着手 | — |
| 2〜10 | 未着手 | — |

## Phase 0（2026-10-15）

### 成果物

- pnpm workspace：`apps/web`（SvelteKit 3 + TypeScript + 生CSS + adapter-cloudflare 8）、`packages/time`（Temporal ラッパー）
- `apps/web/wrangler.jsonc`：D1 `DB`、R2 `MEDIA` / `PENDING` / `BACKUP`（ローカル用プレースホルダー）、`workers_dev` / `preview_urls` 無効
- SSR ページ `/`（JST の今日を Temporal で表示、JS 無効でも表示）
- `GET /api/health`（D1 疎通、Temporal 実装種別、`no-store`）
- 互換性テスト：D1 trigger / json_each / FTS5 trigram、R2、SimpleWebAuthn（ソフトウェア認証器）、workerd 上の Temporal
- E2E（Chromium / WebKit / iPhone 15 viewport）と公開 JS 予算テスト
- GitHub Actions CI（`.github/workflows/ci.yml`）
- ADR 0001〜0004、`docs/performance.md`

### テスト結果（ローカル、2026-10-15）

| コマンド | 結果 |
|---|---|
| `pnpm --filter @infixer-link/time test` | 6 passed |
| `pnpm --filter web test:workers` | 22 passed（D1 12、R2 2、WebAuthn 7、Temporal 1） |
| `pnpm --filter web test:e2e` | 12 passed（3 projects × 4） |
| `pnpm --filter web check` / `lint` | 0 errors |
| `pnpm --filter web build` | 成功 |
| GitHub Actions（PR #1） | 全ステップ成功（type check → lint → unit → workers → E2E） |

### 判明した設計への影響（詳細は ADR）

- D1 の `meta.changes` は trigger の書き込みを含む → 更新成功判定は `RETURNING` で行う（ADR 0002）。
- FTS5 trigram は 1〜2 文字に効かない → LIKE fallback 必須（設計どおり）。
- workerd にネイティブ Temporal は無い → サーバーは polyfill（ADR 0001）。
- SvelteKit 3 では bindings を `cloudflare:workers` の `env` から読む（ADR 0001）。

### 未検証

- **Cloudflare 上での動作全般**（staging 未作成。ユーザー承認待ち）
  - 本番 D1 での trigger / FTS5 trigram の挙動
  - Workers 実環境の CPU time（Free プラン 10ms で足りるか）
  - HTTPS 実ドメインでの実ブラウザのパスキー登録・認証
- 実機（iPhone Safari / Android Chrome）での表示

### staging 準備手順（未実行・要承認）

```sh
cd apps/web
pnpm exec wrangler login
pnpm exec wrangler d1 create infixer-link-staging
pnpm exec wrangler r2 bucket create infixer-link-media-staging
pnpm exec wrangler r2 bucket create infixer-link-pending-staging
pnpm exec wrangler r2 bucket create infixer-link-backup-staging
# 返された database_id を wrangler.jsonc の env.staging に記入し、
# staging.infixer.link を custom domain として設定してから deploy
```

## 次：Phase 1 への引き継ぎ

- `migrations/` に本番 schema（設計 §7.1・§9.7）。ADR 0002 の trigger 方式と `RETURNING` 判定を使う。
- `tests/helpers/soft-authenticator.ts` を認証 API の統合テストで再利用する。
- 認証 adapter のテスト用差し替えが production で有効にならない仕組みとテスト。
- `wrangler.jsonc` に `env.staging`（RP ID `staging.infixer.link`）を追加。staging 作成はユーザー承認後。
- Phase 1 完了条件の「staging でパスキー登録→ログイン→再認証」には staging 環境が必要。
