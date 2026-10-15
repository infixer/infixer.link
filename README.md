# infixer.link

自分だけが編集し、誰でも読める日記と Wiki。
SvelteKit + TypeScript on Cloudflare Workers、D1（本文）、R2（画像）。

- 設計：[`docs/design.md`](docs/design.md)
- 実装状況：[`docs/implementation-status.md`](docs/implementation-status.md)
- 開発ルール：[`AGENTS.md`](AGENTS.md)

## 必要なもの

- Node.js 24（`.nvmrc`）
- pnpm 10

## セットアップ

```sh
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars   # 必要になったら値を入れる（コミットしない）
pnpm --filter web exec playwright install chromium webkit
```

## 開発

```sh
pnpm dev                       # http://localhost:5173
pnpm --filter web build        # production build
pnpm --filter web preview      # build 結果を wrangler dev（workerd）で配信 :4173
```

ローカルの D1 / R2 は Wrangler が `apps/web/.wrangler/` に作る（Git 対象外）。

## テスト

```sh
pnpm --filter @infixer-link/time test   # Temporal ラッパー
pnpm --filter web test            # unit + Workers 統合（D1 / R2 / WebAuthn）
pnpm --filter web test:e2e        # Playwright（Chromium / WebKit / iPhone viewport）
pnpm --filter web perf:bundle     # 公開初回 JS の予算チェック
pnpm --filter web check && pnpm --filter web lint
```
