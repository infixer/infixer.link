# CLI（`infixer`）の使い方

判断の記録：[ADR 0016](../../docs/adr/0016-cli-and-tokens.md)。Node.js 22.18 以上が必要です。

## 1. トークンを発行する

1. ブラウザで `/owner/settings` を開き、「CLI トークン」で名前・スコープ・有効期間を選んで「発行する」を押す（パスキーでの確認を求められることがあります）。
2. 表示されたトークン（`ifx_…`）をコピーする。**この画面を閉じると二度と表示されません。**
3. 次のどちらかで CLI に渡す。
   - `pbpaste | infixer auth login`（`~/.config/infixer/config.json` に mode 0600 で保存）
   - 環境変数 `INFIXER_TOKEN`（CI やスクリプト用）

| スコープ | できること |
|---|---|
| read | `get`・`today`・`auth status` |
| write | `append`・`put`・`create`・`import`・`today --create` |
| backup | `export`・`backup` |

`search` は公開 API なのでトークンは不要です。

## 2. 使う

```sh
# リポジトリから（インストールせずに）
alias infixer="node --disable-warning=ExperimentalWarning $PWD/apps/cli/src/main.ts"

infixer append today '読書メモ'          # 今日の日記に追記（なければ作成）
echo '長いメモ' | infixer append today   # 標準入力から
infixer get today > today.link.txt
infixer put today --file today.link.txt --base-revision 12
infixer search 'アンチ・オイディプス' --json
infixer backup ~/Backups/infixer          # ~/Backups/infixer/infixer-backup-<日時>/ に画像込みで書き出す
```

ローカル開発のサーバーに対しては `INFIXER_URL=http://localhost:5173` を付けます。

## 3. 終了コード

| コード | 意味 | 対処 |
|---|---|---|
| 0 | 成功 | |
| 2 | 使い方の誤り | `infixer --help` |
| 3 | 見つからない | id・タイトルを確認。今日の日記は `today --create` |
| 4 | 競合（他の場所で先に更新された） | `get` で最新を確認してから、もう一度実行する。CLI は自動で追記し直さない |
| 5 | 認証（トークンが無効・期限切れ・スコープ不足） | 設定画面で発行し直す |
| 6 | 通信 | 接続を確認する。追記は同じ mutationId で再送しているので、二重には入らない |

## 4. トークンをなくした・漏れたとき

設定画面の「CLI トークン」で「失効」を押す。パスキーの recovery を行った場合は、すべてのトークンが自動で失効します。

## 5. 書き出しから戻す（空のサイトへ）

```sh
INFIXER_URL=https://staging.infixer.link infixer import ~/Backups/infixer/infixer-backup-…/
```

- 書き込む前にファイルのハッシュをすべて照合します。1 つでも違えば何もしません。
- 既にあるページは上書きしません。何度実行しても結果は同じです。
- 過去の版の履歴と作成・更新時刻は戻りません。
- 本番への復元は Phase 8 の手順（staging で演習してから）で行います。
