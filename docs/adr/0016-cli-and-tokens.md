# ADR 0016: CLI（`infixer`）・API トークン・持ち出し形式

- 日付：2026-10-16
- 状態：採用（ローカルの wrangler dev と workerd で検証。本番での利用は未検証）
- 関係する設計：§9.6（CLI）、§13.1・13.2（CLI v1・持ち出し形式）、§15（一貫した export）、§17 Phase 7

## 決定

### API トークン

| 項目 | 内容 |
|---|---|
| 発行 | 設定画面から。cookie のセッション＋CSRF に加えて、**5 分以内のパスキー再認証**が必要。トークンは発行直後に一度だけ表示し、DB には SHA-256 だけを保存する |
| 形式 | `ifx_` ＋ 256 bit のランダム値（base64url） |
| スコープ | `read`（取得・検索・補完）、`write`（作成・更新・削除・画像・日記の作成）、`backup`（`/export/*`）。必ず 1 つ以上を選ぶ |
| 期限 | 必ず期限付き（1〜365 日、既定 90 日）。失効は設定画面から。パスキーの recovery ではすべて失効する（Phase 1 から） |
| トークンでできないこと | パスキー・セッション・トークンの管理（`/passkeys`・`/sessions`・`/tokens` は 403）。`/api/auth/*` もトークンを受け付けない |
| 最終使用時刻 | `api_tokens.last_used_at`（マイグレーション 0007）。書き込みを減らすため、更新は 1 時間に 1 回まで |

### Bearer の扱い（`ownerAuth`）

- `/api/owner/v1/*` は、cookie のセッション（Origin・CSRF を検査）か、Bearer トークンのどちらかで受け付ける。
- Bearer のときは cookie を使わないので CSRF の検査はしない。Origin ヘッダーがなくてもよいが、Host は許可したオリジンに限る。認証そのものは必ずトークンで行う。
- **cookie と Bearer を同時に送ると 400**（どちらの権限で動いているか曖昧になるため）。
- 必要なスコープはルートから決める（`bearerScope`）。GET と `POST /names/resolve` は `read`、`/export/*` は `backup`、それ以外の書き込みは `write`。

### CLI（`apps/cli`、コマンド名 `infixer`）

- Node.js 22.18 以上で、TypeScript をそのまま実行する（型の除去。リポジトリの `scripts/*.ts` と同じ）。ビルドの手順はない。依存は `@infixer-link/contracts`（型だけ）。
- コマンド：`get`・`search`・`today [--create]`・`append`・`put --base-revision`・`create`・`export [--with-assets]`・`backup`・`import`・`auth login|status|logout`。すべてに `--json` がある。
- 終了コード：0 成功、1 エラー、2 使い方、3 見つからない、4 競合、5 認証、6 通信。
- トークンの置き場所：環境変数 `INFIXER_TOKEN`、または `$XDG_CONFIG_HOME/infixer/config.json`（mode 0600）。`auth login` は標準入力から読む（シェルの履歴に残らないように、引数では受け取らない）。OS の資格情報ストアは使っていない。
- https だけを受け付ける（localhost は除く）。トークンはサイトのオリジンにしか送らず、画像のダウンロード（別オリジンの R2）には付けない。エラー表示にトークンや本文を含めない。
- **追記**（`append`）：最新の版を読み、`baseRevision` 付きで更新する。通信が切れたら同じ本文、つまり同じ mutationId で再送する（サーバーは一度だけ反映する）。その間に他の場所で更新されていたら、**自動で追記し直さず**、終了コード 4 で止まる。`today` がなければ作成する（`append` のときだけ）。
- `get` は、パイプのときは本文をそのまま出力する（`get` → 編集 → `put` で 1 バイトも変わらない）。
- 「今日」はサーバーが `SITE_TIME_ZONE` で決める（`/api/owner/v1/daily/today`）。CLI を動かす PC のタイムゾーンには依存しない。

### 持ち出し形式（`export` / `backup`）

```text
manifest.json          format "infixer-link-export", schemaVersion 1, 時刻, サイト, highWater, 件数, 全ファイルの SHA-256
pages/{id}.link.txt    本文（link-text-v1。保存されているそのもの）
metadata/{id}.json     id, title, format, revision, dailyDate, createdAt, updatedAt, aliases
assets-manifest.json   画像の一覧（ダウンロードしたかどうかも）
assets/{id}.{ext}      --with-assets（backup では既定）。SHA-256 を照合してから書く
```

- **ある時点で固定**：`GET /export/start` が返す `highWater`（changes の位置）を全ページに使う。書き出しの途中で編集・削除・作成があっても、その時点の版だけからなる（設計 §15）。その時点で削除されていたページは含めない。
- Worker は 1 リクエストで全体をまとめない。ページは 100 件、画像は 500 件ずつ取得し、CLI 側で保存する。
- ファイル名にタイトルを使わない（id と固定の名前だけ。英数字・`-`・拡張子以外を拒否し、出力先の外に出るパスも拒否する）。既存のファイルは上書きせず、空でないディレクトリには書き出さない。
- 画像は任意（`export --with-assets` / `backup`）。PC に全部を自動で同期することはしない。

### 復元（`import`）

- export を**空のサイト**に戻す。ページ id と画像 id を保ったまま作り直し、別名は改名をたどって復元する（どの名前でも同じページに解決される）。リンク・日記の日付・画像の参照も戻る。
- まず manifest のハッシュをすべて照合し、1 つでも違えば何もしない。
- 既にある id は上書きしない（同じ内容なら「同じ内容」、違えば一覧で報告して終了コード 4）。何度実行しても結果は同じ。
- 履歴（過去の版）と作成・更新時刻は戻らない（export に含めていない）。Phase 8 の復元演習ではこれを前提にする。

## 代案

| 代案 | 採用しなかった理由 |
|---|---|
| `hono/client` の型付きクライアント（設計 §8 の予定） | `ApiApp` の型を使うと、CLI の型チェックに Workers・D1・SvelteKit の型が入り込む。DTO は `@infixer-link/contracts` で共有できている |
| CLI をビルドして配布 | 今は本人だけが使う。Node のサポート中の LTS で TS をそのまま実行できる |
| OS のキーチェーンに保存 | 依存が増える。環境変数と 0600 のファイルで始め、必要になったら足す |
| Worker で ZIP を作る | 設計 §13.1 のとおり、大量のデータを 1 リクエストで作らない |
| 追記の競合で自動的に読み直して再追加 | 設計 §13.1 のとおり。同じ追記が二重に入る危険がある |

## 未検証・残るリスク

- 本番（`https://infixer.link`、R2 のカスタムドメインからの画像のダウンロード）での CLI。
- Windows での実行（パスと改行は扱っているが、試していない）。
- 1 万ページ規模の export / import の時間（`/export/pages` は 1 回 100 件）。
