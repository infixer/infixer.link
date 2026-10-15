# 実装状況

設計：[`docs/design.md`](design.md)。各 Phase は stacked PR（`phase-N` は `phase-(N-1)` の上）で進める。

| Phase | 状態 | ブランチ |
|---|---|---|
| 0 基盤と性能・互換性の実証 | **完了（ローカル）** | `phase-0` |
| 1 データと本人認証 | **実装完了（ローカル）。staging 検証待ち** | `phase-1`（`phase-0` の上） |
| 2 日記を毎日書ける最小版 | **実装完了（ローカル）。実機 IME 未検証** | `phase-2`（`phase-1` の上） |
| 3 Cosense 風のリンクと操作感 | **実装完了（ローカル）。実機 IME と補完の干渉は未検証** | `phase-3`（`phase-2` の上） |
| 4 画像アップロードと高速配信 | **実装完了（ローカル）。R2 のカスタムドメインと実機の写真選択は未検証** | `phase-4`（`phase-3` の上） |
| 5 検索・一覧・公開表示の性能 | **実装完了（ローカル）。本番 D1 での時間と実機の IME は未検証。一覧のカードと YouTube の埋め込みを追加** | `phase-5`（`phase-4` の上） |
| 6 オフラインと競合解決の完成 | **実装完了（ローカル）。実機と Service Worker の更新の流れは未検証** | `phase-6`（`phase-5` の上） |
| 7 CLI と可搬性 | **実装完了（ローカル）。本番での CLI の利用は未検証** | `phase-7`（`phase-6` の上） |
| 8〜10 | 未着手 | — |

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

## Phase 5（2026-10-16）

### 成果物

- **日本語検索**（ADR 0013、`src/lib/server/pages/search.ts`）
  - 3 文字以上の語は FTS5 trigram、1〜2 文字は LIKE（エスケープあり）。語は AND。FTS の検索構文は使えない（すべてフレーズにする）。
  - 並び順：名前（別名を含む）の完全一致 → 前方一致 → タイトルにすべての語 → 本文だけ。同じ順位は更新の新しい順。
  - 抜粋とハイライト（`{ text, hit }[]`。`<mark>` で描く）。100 文字・5 語まで、offset は 200 まで。
- **API**：`GET /api/public/v1/search?q&limit&offset`（公開、`no-cache`）。DTO は `@infixer-link/contracts` の `SearchDto`。
- **画面**：`/search`（ヘッダーに「検索」）
  - JavaScript なしでもフォームで検索できる（SSR）。
  - JavaScript があれば入力しながら検索する：200ms の debounce、古い要求の中止、古い応答で上書きしない（`src/lib/search/live.ts`）、IME の変換中は検索しない、URL を `?q=` に合わせる。
  - 矢印キーで結果に移動し、Enter で開く。Escape で入力欄に戻る。`noindex`。
- **マイグレーション 0005**：検索索引を安定した rowid で入れ替える。保存 1 回の rows read が 10,006 → 8（10,000 ページ）。既存データの移行も確認した。
- **公開表示**
  - 画像の CLS を修正（Phase 4 の CSS が縦横の予約を打ち消していた。0.224 → 0.000）。
  - ページで最初の画像は `eager` + `fetchpriority=high`、他は `lazy`。
  - 公開 HTML には ETag を付けない（CSP の nonce が応答ごとに変わるため。ADR 0013）。一覧はカーソル方式のまま（ページあたり 31 行しか読まない）。
- **計測**：`pnpm --filter web perf:data`（合成データ 2,000 / 10,000 ページで、検索・一覧・関連ページ・ページの load・保存のコストを計測）。`pnpm --filter web db:seed --synthetic 2000` でローカルにも同じデータを入れられる。結果は `docs/performance.md`。

### テスト結果（ローカル、2026-10-16）

| コマンド | 結果 |
|---|---|
| `pnpm --filter './packages/**' test` | time 7 / content 30 / contracts 5 passed |
| `pnpm --filter web test:unit` | 35 passed（入力中の検索 4 件を追加：debounce、古い応答の破棄、中止した要求のエラーを出さない、取り消し） |
| `pnpm --filter web test:workers` | 92 passed（search 15 件を追加：1・2・3 文字、AND と混在、名前・別名の順位、英数字の大小、長文の抜粋、更新・削除・復元の反映、FTS 構文と LIKE のワイルドカードを文字として扱う、ページングの重複・欠落なし、パラメータの上限） |
| `pnpm --filter web perf:data` | 2 passed（2,000 / 10,000 ページ。数値は `docs/performance.md`） |
| `pnpm --filter web test:e2e` | 96 passed / 54 skipped（search.e2e：JavaScript なし、入力中の検索、古い応答で上書きしない、キーボード操作、IME の変換中は検索しない（Chromium の CDP）、スマホ幅のヘッダー。vitals.e2e：画像ページの CLS。bundle-budget に `/search` を追加）。3 回実行し 2 回は全件 pass。1 回は vitals.e2e のページ作成がローカル D1 の内部エラー（`Failed to get session commit token: internal error`）で 500 になった。アプリのエラーではなく、再実行では再現しなかった |
| check / lint | 0 errors |
| テストの有効性 | 古い応答の破棄（中止と順番の確認）と IME の確認を一時的に外すと、E2E 2 件と unit 2 件が失敗することを確かめ、元に戻した |

### 未検証

- **本番 D1 での検索・関連ページ・保存の時間と rows read**（staging 未作成）。ローカルの値は参考値。
- 公開ページの cold / warm の比較、モバイル回線相当での LCP、実機での INP。
- **実機の日本語 IME での入力中の検索**（CDP のエミュレーションでは確認済み）。iPhone で検索欄にフォーカスしたときの表示。
- 1〜2 文字の検索と関連ページの rows read が、公開での閲覧数に比例して増えること（ADR 0013 の「残るリスク」。Phase 8 の監視とあわせて判断する）。

### 追加：一覧のカード表示と YouTube の埋め込み（2026-10-16、ユーザーの依頼。ADR 0014）

- **一覧**：Cosense のような正方形のカードのグリッド（スマホ 2 列・PC 4 列）。ページで最初の画像（アップロード画像、リンクカードの画像、YouTube のサムネイル）を出し、なければ最初の数行を出す。
- **保存**：本文から画像の候補を計算して `pages.thumbs_json` に保存する（マイグレーション 0006）。画像は一覧を読むときに解決する。既存のローカルデータは `pnpm --filter web db:backfill-thumbnails`。
- **YouTube**：URL だけの行は 16:9 の枠にサムネイルと再生ボタンを出し、押すと `youtube-nocookie.com` のプレイヤーに置き換える（公開ページとエディタ）。タイトルは oEmbed、サムネイルは i.ytimg.com から R2 に取り込む。CSP に `frame-src https://www.youtube-nocookie.com` を追加した。
- **テスト**
  - packages：content 37 passed（YouTube の URL の判定・開始位置・偽物の拒否、サムネイルの候補、本文の先頭の文字）
  - `test:workers`：100 passed（cards 8 件を追加：文字だけのカード、最初の画像、画像のない候補を飛ばす、カードの画像、編集・復元での更新、oEmbed とサムネイル、oEmbed が失敗したとき、動画は HTML を取得しない）
  - `test:e2e`：106 passed / 56 skipped（cards.e2e：カードの画像と文字、スマホで 2 列・正方形・横スクロールなし、押すまでプレイヤーを読み込まない、CSP エラーなし、JavaScript なしではリンク、エディタでの再生）。`frame-src` を外すと再生のテストが失敗することを確かめ、元に戻した
  - 全体の E2E を 3 回実行し、1 回はローカル D1 の内部エラー（上記と同じ `Failed to get session commit token`）で 1 件が失敗した。miniflare の D1 エミュレーターが内部のストレージから bookmark を取れなかったときのエラーで、SQL の後に起きている。アプリのエラーではない
  - check / lint は 0 errors
- **未検証**：実際の YouTube（oEmbed・サムネイル・プレイヤー）への接続、iPhone での再生と全画面表示。

## Phase 6（2026-10-16）

### 成果物（ADR 0015）

- **Service Worker**（本人の端末だけ）
  - 保存するもの：アプリの殻と、開いた公開ページ（HTML と `__data.json`、最新 200 件）
  - オフラインで、保存していないページを開くと「この端末にまだ保存されていない」と表示する
  - `/api`・`/owner`・`/media`・リダイレクト・`no-store` は扱わない
  - 新しい版は「更新する」を押すまで適用せず、下書きを保存してから再読み込みする
- **オフラインでの編集**
  - 本人の端末なら、オフラインでも保存済みのページをそのまま編集できる。下書きは IndexedDB に保存し、接続が戻ると送信する
  - 「新規」と「今日の日記をこの端末で書く」でページを作れる。作ったページは接続が戻ると、同じ id で作成する
- **outbox**：開いていないページの未送信の下書きと画像を、アプリを開いたとき・接続が戻ったとき・タブが表示されたとき・手動で送る。競合・拒否されたものは消さずに一覧（`/offline`）に残す。Web Locks でエディタとの二重送信を防ぐ
- **三者比較**：`packages/sync`（行単位の diff3）と `ConflictResolver.svelte`
  - 重なりがなければ「まとめて保存」の 1 回で保存する
  - 重なりがあれば、ブロックごとにこの端末・サーバー・両方から選ぶ
  - 本人が押すまで保存しない
- **同じ日の日記の衝突**：オフラインで書いた日記が別の端末の日記とぶつかったら、その日記の末尾に追加できる。サーバーは `daily_conflict` に既存のページの id を付ける
- **API**：`GET /api/owner/v1/pages/{id}/revisions/{revision}`（三者比較の元版）
- **その他**
  - 容量：`persist()` を求め、使用量が 90% を超えたら知らせる
  - 下書きと画像を JSON で一括ダウンロードできる
  - ログアウト時に、未送信のものを残すか、ダウンロードしてから削除するかを選べる
  - `paths.relative: false`

### テスト結果（ローカル、2026-10-16）

| コマンド | 結果 |
|---|---|
| `pnpm --filter './packages/**' test` | content 37 / contracts 5 / time 7 / **sync 11**（差分、非重複の自動マージ、重なり、同じ変更、挿入の重なり、削除と編集、空の元版、1 万行の速度） passed |
| `pnpm --filter web test:unit` | 51 passed（自動保存 5 件：元版の保存、競合の元版、オフライン作成、日記の衝突、マージ結果の保存。outbox 11 件：古い順、mutationId の再利用、作成、競合を残す、日記の衝突、通信・認証で停止、開いているページを飛ばす、画像を先に送る、拒否された画像、送信中の追記を残す、変更のない下書き） |
| `pnpm --filter web test:workers` | 103 passed（版の内容 1 件、日記の衝突で既存の id を返す・オフライン作成の再送 2 件） |
| `pnpm --filter web test:e2e` | 115 passed / 74 skipped。offline.e2e（Chromium）10 件：保存済みのページをオフラインで編集して復帰後に公開、未保存のページの表示、非重複の一括マージ、重なりのブロックごとの選択（選ぶまでサーバーは変わらない）、オフラインの「新規」、オフラインの日記と別の端末の日記の衝突、開いていないページの下書きを裏で送信、Service Worker が `/api`・`/owner` を保存しないこと、ログアウト時の選択。`--repeat-each=3` でも全件 pass |
| check / lint | 0 errors（Service Worker は `tsconfig.service-worker.json` で型チェック） |
| テストの有効性 | ブロックごとの選択を無視するようにすると E2E が失敗することを確かめ、元に戻した。Service Worker の `/api` の除外だけを外しても E2E は失敗しない（ナビゲーション以外は扱わない、`no-store` は保存しない、という別の層でも防いでいるため） |

### 開発中に見つけて直したこと

- `/offline` を別の URL で返すと、相対パスの JS が読み込めずに表示が壊れた → `paths.relative: false`
- オフラインで同じ秒に 2 つ作った「無題」のページがサーバーで名前の衝突になった → 無題のタイトルに id の先頭 4 文字を付け、衝突のメッセージを日本語にした
- 再読み込みの直後に、裏の同期とエディタが同じ下書きを別の mutationId で送り、偽の競合になった（既存の画像の E2E で発見）→ エディタは下書きを読む前にページのロックを待つ

### 未検証

- 実機（iPhone Safari・Android Chrome）でのオフライン編集、アプリの切り替え後の復帰、ホーム画面に追加したとき
- Service Worker の更新の流れ（バナー → 下書きの保存 → 再読み込み）
- Web Locks のないブラウザでの動作、ブラウザによる保存領域の削除（eviction）

## Phase 7（2026-10-16）

### 成果物（ADR 0016、runbook `ops/runbooks/cli.md`）

- **API トークン**
  - 発行：設定画面から。5 分以内のパスキー再認証が必要で、トークンは一度だけ表示する。DB にはハッシュだけを保存する
  - スコープは read / write / backup。期限は 1〜365 日（必ず期限付き）。失効でき、最終使用時刻を記録する（マイグレーション 0007）
- **Bearer 認証**
  - `/api/owner/v1/*` で、cookie の代わりに使える。CSRF の検査はしない。Host は許可したオリジンに限る
  - スコープはルートごとに検査する
  - cookie と同時に送ると 400。パスキー・セッション・トークンの管理には使えない
- **API**
  - `GET /api/owner/v1/daily/{date|today}`。今日は、サーバーが `SITE_TIME_ZONE` で決める
  - `GET /export/start`・`/export/pages`（changes の位置で固定し、ページング）・`/export/assets`
  - `GET`・`POST`・`DELETE /tokens`
- **CLI（`apps/cli`、`infixer`）**
  - コマンド：get / search / today / append / put / create / export / backup / import / auth
  - `--json`、終了コード 0〜6
  - TypeScript を Node でそのまま実行する（ビルドなし）
- **持ち出し形式**
  - `manifest.json`（ハッシュ付き）、`pages/`、`metadata/`、`assets-manifest.json`、`assets/`（任意）
  - ファイル名は id だけ。出力先の外に出るパスは拒否し、上書きしない
- **復元（`import`）**：空のサイトに、id・別名・リンク・日記の日付・画像を戻す。ハッシュの照合をしてから書き込み、何度実行しても同じ結果になる
- **CI**：CLI の lint とテストを追加

### テスト結果（ローカル、2026-10-16）

| コマンド | 結果 |
|---|---|
| `pnpm --filter './packages/**' test` | content 37 / contracts 5 / time 7 / sync 11 passed |
| `pnpm --filter @infixer-link/cli test` | 10 passed（URL の検査、追記の改行、通信の再送で同じ mutationId、競合で終了コード 4（再追加しない）、認証・通信の終了コード（トークンを表示しない）、today の作成は指定したときだけ、タイトルの解決はトークンなし、ファイル名の検査（path traversal）、上書きしない・空でない出力先を拒否、画像のハッシュの照合と別オリジンへトークンを送らない） |
| `pnpm --filter web test:unit` | 51 passed |
| `pnpm --filter web test:workers` | 118 passed（tokens 13 件：発行の再認証、一度だけ表示・ハッシュの保存、入力の検査、トークンで管理できない、cookie なし・Origin なし・CSRF なしで使える、read だけの制限、無効・期限切れ・失効、cookie との混在と他のホスト、最終使用時刻、recovery での失効、today、export の固定とページング、削除と別名、画像の一覧。cli-roundtrip 2 件：export → 空のサイトへ import でページ・日記・別名・リンク・画像が一致、再実行で変化なし、改ざんの検出） |
| `pnpm --filter web test:e2e` | 116 passed / 76 skipped。cli.e2e：設定画面でトークンを発行 → CLI だけで今日の日記に追記・標準入力から作成・検索・`put` の競合で終了コード 4・画像込みの export（manifest）・同じ出力先を拒否 → 画面で失効すると終了コード 5。全体を 2 回実行し、どちらも全件 pass |
| check / lint | 0 errors（web と cli） |

### 開発中に見つけて直したこと

- `get` の出力の末尾に改行を足していたため、`get` → `put` で本文が変わった → パイプのときは本文をそのまま出力する
- 新しい CLI の E2E がパスキーでログインし直していたため、同じ仮想の資格情報を使う別のログインのテストと署名カウンターがぶつかり、サーバーが（正しく）拒否した → 共有の本人セッションを使う
- YouTube の再生の E2E が、ページの hydration 前にクリックすることがあった → 通信が落ち着くまで待つ

### 未検証

- 本番の URL と R2 のカスタムドメインに対する CLI（staging 未作成）
- Windows での実行、1 万ページ規模の export / import の時間

## 次：Phase 8 への引き継ぎ

- 運用・復旧・v1 公開の準備：staging / prod の作成（**要承認**）、日次バックアップ（BACKUP バケット）、期限切れの challenge・rate limit・pending と使われない画像の掃除（Cron）、監視
- 復元の演習：`infixer backup` → 空の staging に `infixer import` → 件数・本文のハッシュ・画像のハッシュ・リンク・検索を確認する（cli-roundtrip のテストと同じ手順）
- Phase 1〜6 の未検証のこと（実機のパスキー・IME・オフライン、本番 D1 の性能）を staging で確かめる

## 旧：Phase 7 への引き継ぎ（Phase 6 時点）

- CLI（`infixer`）と持ち出し。`api_tokens`（Bearer）の発行と、`hono/client` の型付きクライアント
- outbox と三者比較の `@infixer-link/sync` を、CLI の `infixer push` の競合処理でも使える
- `GET /api/owner/v1/pages/{id}/revisions/{revision}` は CLI の `--base-revision` にも使える

## 旧：Phase 6 への引き継ぎ（Phase 5 時点）

- Service Worker・outbox・競合の 3 者比較（設計 §17 Phase 6）。
- 検索結果はオフラインでは使えない（API のみ）。オフラインで何を出すかは Phase 6 で決める。
- 画像の CSS は `width` / `height` 属性で領域を予約している。オフラインの未送信画像（属性なし）でも崩れないか確認する。

## 旧：Phase 5 への引き継ぎ（Phase 4 時点）

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
