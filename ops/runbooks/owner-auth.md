# Runbook: 本人（owner）のパスキー初期設定・追加・復旧

前提：Cloudflare アカウントの管理権限（`wrangler d1 execute` が実行できること）。これが運用者だけの経路になる。

## 初回セットアップ

1. マイグレーションを適用する。
   ```sh
   cd apps/web
   pnpm exec wrangler d1 migrations apply DB --remote --env <staging|production>
   ```
2. セットアップコードを発行する（10 分有効・1 回限り。DB には hash だけが残る）。
   ```sh
   node scripts/owner-grant.ts --remote --env <staging|production>
   ```
3. ブラウザで `https://<host>/owner/setup` を開き、コードを貼り付けてパスキーを登録する。
4. 完了すると `/owner/settings` に移動する。予備のパスキー（別の端末やセキュリティキー）もここで追加しておく。

コードが期限切れになったり途中で中断したりしたら、手順 2 からやり直す。セットアップが完了したあとは、`setup` 用のコードを発行しても登録できない（再開放しない）。

ローカルでは `--remote --env` を付けずに実行し、`http://localhost:5173/owner/setup` を使う。

## ログイン

ブックマークした `/owner/login` を開く。公開ページにはログインへの導線を出さない。

## パスキーの追加・削除

`/owner/settings` から操作する。追加と削除の前に、パスキーでの再確認が入る。最後の 1 本は削除できない。

## 全パスキーを紛失したとき（recovery）

1. 復旧コードを発行する。
   ```sh
   node scripts/owner-grant.ts --purpose recovery --remote --env production
   ```
2. `/owner/setup` で新しいパスキーを登録する。
3. 登録が確定した時点で、**既存のパスキー・全 session・CLI トークンがすべて失効**する。公開されている本文は変わらない。

## 確認用 SQL（読み取りのみ）

```sh
pnpm exec wrangler d1 execute DB --remote --env production \
  --command "SELECT name, created_at, last_used_at, revoked_at FROM passkeys"
```

秘密情報（コード、cookie、session トークン）をログ・チャット・Git に貼らないこと。
