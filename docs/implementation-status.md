# 実装状況

設計：[`docs/design.md`](design.md)。各 Phase は stacked PR（`phase-N` は `phase-(N-1)` の上）で進める。

| Phase | 状態 | ブランチ |
|---|---|---|
| 0 基盤と性能・互換性の実証 | **完了（ローカル）** | `phase-0` |
| 1 データと本人認証 | **実装完了（ローカル）。staging 検証待ち** | `phase-1`（`phase-0` の上） |
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

## Phase 1（2026-10-15）

### 成果物

- **マイグレーション**
  - `0001_pages.sql`：pages / page_names / page_revisions / page_links / page_assets / changes / pages_fts（trigram）/ settings と trigger
  - `0002_auth.sql`：owner / passkeys / setup_grants / auth_challenges / sessions / api_tokens / auth_rate_limits / tx_guard
- **共有パッケージ**
  - `@infixer-link/contracts`：valibot スキーマ、DTO、エラーコード、上限値
  - `@infixer-link/content`：name key（NFC + trim）と、リンク・タグ・asset の抽出（最小版。Phase 3 で parser に置き換え）
- **API（Hono、ADR 0006）**：`/api/public/v1/{pages,pages/:id,resolve}`、`/api/auth/v1/{session,setup/*,authentication/*,registration/*,logout}`、`/api/owner/v1/{pages CRUD,restore,revisions,passkeys,sessions}`
- **ページ保存**：条件付き INSERT/UPDATE + `RETURNING`、mutationId と request hash による冪等な再送、409（revision / name / daily / mutation）、soft delete・restore
- **本人認証**：operator が発行する setup / recovery コード、パスキー登録・ログイン・再認証・追加・削除、opaque session、CSRF、Origin / Host 検査、IP 単位のレート制限（ADR 0007）
- **画面**：`/`（一覧）、`/p/{id}/{slug}`（閲覧・削除済みは 410）、`/owner/login`、`/owner/setup`、`/owner/settings`
- **スクリプト**：`owner:grant`（コード発行）、`db:seed`（サンプル）、`db:migrate`、`e2e:server`
- **ドキュメント**：runbook `ops/runbooks/owner-auth.md`、ADR 0006・0007

### テスト結果（ローカル、2026-10-15）

| コマンド | 結果 |
|---|---|
| `pnpm --filter './packages/**' test` | time 6 / content 7 / contracts 5 passed |
| `pnpm --filter web test:unit` | 5 passed（returnTo、import 境界） |
| `pnpm --filter web test:workers` | 52 passed（pages 19、auth 20、config 3、R2 2、WebAuthn 7、Temporal 1） |
| `pnpm --filter web test:e2e` | 18 passed / 12 skipped（オーナー操作の E2E は Chromium 仮想認証器のみ。WebKit ではスキップ） |
| check / lint | 0 errors |
| GitHub Actions（PR #2） | 全ステップ成功 |
| 防御を外したときのテスト検出 | tx_guard と CSRF 検査を一時的に無効化すると 3 件失敗することを確認し、元に戻した |

### 未検証

- **staging での動作**：HTTPS 実ドメインでのパスキー登録 → ログイン → 再認証（Phase 1 の完了条件）、本番 D1 での trigger / FTS / `changes()` guard、CPU 時間、保存 API の p95
- 実機（iPhone Safari / Android Chrome / macOS Safari）のパスキーと同期パスキー
- 期限切れ challenge / rate-limit 行の掃除（Phase 8 の Cron で対応予定）

## 次：Phase 2 への引き継ぎ

- `/today` と同一 URL での編集。本人の session 確認は `/api/auth/v1/session`（no-store）を使う。CodeMirror は遅延読み込みにする。
- 保存には `PUT /api/owner/v1/pages/:id`（baseRevision + mutationId）を使う。409 の `details.currentRevision` を競合 UI に渡す。
- 日記は `POST /api/owner/v1/daily/{date}` を追加する（`pages.daily_date` UNIQUE。`daily_conflict` の扱いに注意）。
- staging 作成後に、Phase 1 の完了条件（実機パスキー）を確認する。

## 旧：Phase 1 への引き継ぎ（Phase 0 時点）

- `migrations/` に本番 schema（設計 §7.1・§9.7）。ADR 0002 の trigger 方式と `RETURNING` 判定を使う。
- `tests/helpers/soft-authenticator.ts` を認証 API の統合テストで再利用する。
- 認証 adapter のテスト用差し替えが production で有効にならない仕組みとテスト。
- `wrangler.jsonc` に `env.staging`（RP ID `staging.infixer.link`）を追加。staging 作成はユーザー承認後。
- Phase 1 完了条件の「staging でパスキー登録→ログイン→再認証」には staging 環境が必要。
