# Runbook: 画像（R2）の設定

ADR 0012 の構成を staging / production に用意する手順。**どの手順もユーザーの承認を得てから実行する。**

## バケット

| バインディング | 用途 | 公開 |
|---|---|---|
| `MEDIA` | 検証済みの原本 `originals/{sha256}.{ext}` | カスタムドメインで公開 |
| `PENDING` | アップロード直後で、まだ検証していないもの | **公開しない**（ドメインを接続しない、r2.dev も無効のまま） |
| `BACKUP` | Phase 8 で使う | 公開しない |

```sh
cd apps/web
pnpm exec wrangler r2 bucket create infixer-link-media-<env>
pnpm exec wrangler r2 bucket create infixer-link-pending-<env>
pnpm exec wrangler r2 bucket create infixer-link-backup-<env>
```

## 公開ドメイン（MEDIA のみ）

1. Cloudflare のダッシュボードで、R2 の `infixer-link-media-<env>` を開き、Settings → Custom Domains に `media.infixer.link`（staging は `media-staging.infixer.link` など）を追加する。
2. キャッシュ：オブジェクトに `cache-control: public, max-age=31536000, immutable` が付いているので、CDN で長くキャッシュされる。キーに内容のハッシュが入っているので、上書きされることはない。
3. `wrangler.jsonc` の環境ごとの `vars.MEDIA_BASE_URL` に `https://media.infixer.link` を設定する（`/media` のままにしない）。

## 確認

- `https://media.infixer.link/originals/<存在しないハッシュ>.png` が 404 になること。
- PENDING バケットに外部から到達できないこと（カスタムドメインと r2.dev が無効になっていること）。
- 本人のエディタで画像を貼り付けて、公開ページに表示されること。CSP の違反がコンソールに出ないこと。

## 費用

R2 のストレージと操作回数で課金される（無料枠あり）。画像のサイズ別配信（Images Transformations）は、有効にするまで課金されない。
