# 実装状況

設計：[`docs/design.md`](design.md)。各 Phase は stacked PR（`phase-N` は `phase-(N-1)` の上）で進める。

| Phase | 状態 | ブランチ |
|---|---|---|
| 0 基盤と性能・互換性の実証 | **完了（ローカル）** | `phase-0` |
| 1 データと本人認証 | **実装完了（ローカル）。staging 検証待ち** | `phase-1`（`phase-0` の上） |
| 2 日記を毎日書ける最小版 | **実装完了（ローカル）。実機 IME 未検証** | `phase-2`（`phase-1` の上） |
| 3 Cosense 風のリンクと操作感 | **実装完了（ローカル）。実機 IME と補完の干渉は未検証** | `phase-3`（`phase-2` の上） |
| 4 画像アップロードと高速配信 | **実装完了（ローカル）。R2 のカスタムドメインと実機の写真選択は未検証** | `phase-4`（`phase-3` の上） |
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

## Phase 2（2026-10-15）

### 成果物

- **同一 URL での編集**：`/p/{id}/{slug}` は、本人ならそのまま編集できる（編集ボタンや「完了」はない）。見た目が同じ CodeMirror 6 のエディタに 1 フレームで入れ替えるので、画面がちらつかない。削除・復元でも URL は変わらない（ADR 0008）
- **新規作成**：本人にだけヘッダーに「新規」を出す。押すと無題のページを作り、タイトルにカーソルが入った状態で開く
- **日記**：`/today`（日本時間で日付を決めて `/daily/{date}` へ 302）、`/daily/{date}`（未作成なら空の表示、本人には作成ボタン、前日・翌日リンク）、`POST /api/owner/v1/daily/{date}`（取得または作成。並行して呼ばれても 1 件だけ作る）
- **自動保存**：`autosave.ts` の状態機械（端末保存 200ms、サーバー保存は 800ms / 最大 5 秒、送信は 1 本ずつ、再送時は同じ mutationId）、IndexedDB の下書き、保存状態の表示（読み上げは結果だけ）
- **例外時の扱い**
  - オフライン：自動で再送する
  - 認証切れ：下書きを残し、別タブでログインしてから再送できる
  - 競合：2 つの版を並べて選ばせる
  - 端末の容量不足：下書きをダウンロードできる
  - 保存を拒否された（タイトル重複など）：内容を直すと再送する
- **削除済みページ**：410 画面にも、本人にだけ「元に戻す」を表示する
- **パスキー管理**：WebAuthn Signal API で、削除したパスキーをパスキー管理側に伝える（対応している環境のみ）
- **E2E の構成**：セットアップ用プロジェクトで owner を 1 回だけ登録し、ログイン状態を他のテストで使い回す

### テスト結果（ローカル、2026-10-15）

| コマンド | 結果 |
|---|---|
| `pnpm --filter './packages/**' test` | time 7 / content 7 / contracts 5 passed |
| `pnpm --filter web test:unit` | 21 passed（autosave 16、returnTo、import 境界） |
| `pnpm --filter web test:workers` | 57 passed（daily 5 件を追加） |
| `pnpm --filter web test:e2e` | 44 passed / 20 skipped（Chromium 限定のシナリオは WebKit でスキップ）。編集系を `--repeat-each=3` で回して全件 pass |
| check / lint | 0 errors |

### 未検証

- **実機の日本語 IME**（macOS・iPhone・Android）：変換・確定・再変換・Undo・複数行の貼り付け。自動テストの文字入力は composition を通らない
- iPhone Safari のキーボード表示とスクロール、アプリ切り替え後の復帰（visibilitychange）
- スクリーンリーダーでの保存状態の読み上げ
- staging での保存 API の p95・CPU 時間（staging 未作成）
- Signal API が実際に効くか（対応ブラウザの実機）

## Phase 3（2026-10-15）

### 成果物

- **記法**：Cosense のリンクと Markdown の装飾の併用（ADR 0009）。`packages/content/src/parse.ts` で行と行内要素を解析し、元テキスト上の位置も返す。
- **閲覧画面**：`Rendered.svelte` で SSR 描画する。リンク名は 1 回のクエリでページに解決し、未作成のページはリンクの色を変えて `/t/{name}` に向ける。
- **エディタの見たまま表示**（`live.ts`）
  - 見た目：カーソルのない行は閲覧画面と同じ。リンクはクリックで移動、カードは widget で表示する。
  - 補完：`[` と `#` でタイトルを補完する（IME の変換中は出さない）。
  - 入力：Enter で箇条書きを続け、Tab でインデントする。
- **リンクカード**（ADR 0010）：URL だけの行をカードにする。メタデータは本人の操作のときだけ取得して D1 にキャッシュし、公開ページはキャッシュを読むだけ。
- **関連ページ**：このページへのリンク、同じリンク先を持つページ（別名は 1 つにまとめる。5 グループ × 10 件まで）、リンク先。
- **API**：`GET /api/public/v1/pages/{id}/related`、`GET /api/owner/v1/titles`、`POST /api/owner/v1/names/resolve`、`POST /api/owner/v1/link-previews`
- **画面**：`/t/{name}`（未作成ページの案内と、本人による作成、そのページへのリンク一覧）
- **その他**：公開ページに OGP のメタ情報を追加。`docs/compatibility.md` を新設。
- **見た目とダークモード**（ADR 0011）：infixer.net に合わせた配色、暗いヘッダー、ライト / ダーク / システムの切り替え（ちらつきなし）、カーソルの視認性。CSP で CodeMirror の基本スタイルがブロックされていた問題を修正。

### テスト結果（ローカル、2026-10-15）

| コマンド | 結果 |
|---|---|
| `pnpm --filter './packages/**' test` | time 7 / content 30（記法の fixture、XSS につながる入力、病的な入力での速度） / contracts 5 passed |
| `pnpm --filter web test:unit` | 21 passed |
| `pnpm --filter web test:workers` | 69 passed（graph 6、previews 6 を追加） |
| `pnpm --filter web test:e2e` | 65 passed / 32 skipped（links.e2e：描画・XSS・見たまま表示・リンク移動・未作成ページの作成・補完・箇条書きの継続・カード・関連ページ。theme.e2e：OS の設定に従う・切り替えの保存・カーソルの位置と色・CSP エラーがないこと） |
| check / lint | 0 errors |

### 未検証

- **実機の日本語 IME と補完の干渉**：変換中に `[` を打つ、確定の Enter で補完が確定しないか、など。自動テストは composition を通らない。
- iPhone で、カーソルのない行のリンクをタップして移動できるか
- 実際の外部サイトに対するリンクカードの取得成功率（staging から）
- Cosense の実データでの表示（Phase 10）

## Phase 4（2026-10-15）

### 成果物

- **画像のアップロード**（ADR 0012）
  - 入れ方：貼り付け、ドラッグ＆ドロップ、「画像」ボタン（スマホでは写真の選択）
  - 流れ：Worker 経由で PENDING に送り、ファイルの中身で形式と縦横を検証してから、MEDIA の `originals/{sha256}.{ext}` に不変のオブジェクトとして置く
  - 再送：送信も確定も冪等で、IndexedDB から再開できる
- **公開の保留**：送信が終わっていない画像を含む版は公開しない（自動保存の状態 `uploading`）。失敗した画像は「再送信」か「画像を外す」を選べる。
- **表示**
  - 閲覧画面とエディタの両方で `<img width height loading=lazy>` で表示する
  - アップロード中は手元のプレビューを出す
  - ページで最初に出てくる画像を `og:image` にする
- **リンクカードの画像**：`og:image` を検証して R2 に取り込み、カードの右側に表示する（外部の画像を直接は表示しない）
- **拒否するもの**：SVG、HEIC / AVIF（案内つき）、中身が画像でないもの、10MiB / 4000 万画素を超えるもの
- **配信**：本番は R2 のカスタムドメイン（`MEDIA_BASE_URL`。CSP の `img-src` に自動で追加する）、ローカルは `/media`
- **runbook**：`ops/runbooks/media.md`

### テスト結果（ローカル、2026-10-15）

| コマンド | 結果 |
|---|---|
| `pnpm --filter web test:unit` | 28 passed（画像判定 5、自動保存の保留 2 を追加） |
| `pnpm --filter web test:workers` | 77 passed（アップロード 6、カード画像 2 を追加。PENDING には外部から到達できないこと、ストリームで送られた本文が上限を超えたら 413 になること、重複排除を含む） |
| `pnpm --filter web test:e2e` | 72 passed / 46 skipped（images.e2e：選択・貼り付け・保留・再送信・画像を外す・リロード後の再開・HEIC の拒否・カード画像。`--repeat-each=2` で全件 pass） |
| check / lint | 0 errors |

### 未検証

- R2 のカスタムドメイン（`media.infixer.link`）からの配信と CDN のキャッシュ（staging 未作成）
- **iPhone で写真を選んだときに渡される形式**（HEIC か JPEG か）と、大きな写真のアップロード時間
- 実際の外部サイトでのカード画像の取り込み
- pending と、どこからも参照されない画像の削除（GC）は Phase 8

## 次：Phase 5 への引き継ぎ

- 日本語の検索（FTS5 trigram と、1〜2 文字の LIKE による補完）、2,000 / 10,000 ページの合成データでの計測。
- 一覧のカーソルページングはもうある。ETag も公開 API にはあるので、HTML の扱いを決める。

## 旧：Phase 4 への引き継ぎ（Phase 3 時点）

- R2 への画像アップロードと `[asset:UUID]` の表示。今は `[画像]` という文字を出している。
- リンクカードの画像：`link_previews.image_url` を R2 に取り込んでから表示する（ADR 0010）。

## 旧：Phase 3 への引き継ぎ（Phase 2 時点）

- link-text-v1 の parser と SSR renderer（今は本文をそのまま表示）、リンク・タグの補完、alias、関連ページ。
- エディタに装飾と補完を加えるときは、IME の composition 中に補完を確定しない。
- 本文中の未作成ページへのリンクから新しいページを作る導線が必要（今は API と日記からしか作れない）。

## 旧：Phase 2 への引き継ぎ（Phase 1 時点）

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
