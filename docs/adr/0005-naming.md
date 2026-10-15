# ADR 0005: 名称を infixer.link に統一（Garden を使わない）

- 日付：2026-10-15
- 状態：採用（ユーザー決定）

## 決定

仮称「Personal Garden」と識別子の `garden` をやめ、ドメインと同じ **infixer.link** 系に統一する。

| 対象 | 名前 |
|---|---|
| 表示名・WebAuthn rpName | `infixer.link` |
| ルート package / Worker 名 | `infixer-link` |
| 共有 package scope | `@infixer-link/*`（例 `@infixer-link/time`） |
| D1 / R2 | `infixer-link-<env>`、`infixer-link-{media,pending,backup}-<env>` |
| 本文フォーマット | `link-text-v1`、ファイル拡張子 `*.link.txt` |
| session cookie | `__Host-link_session` |
| CLI コマンド | `infixer`（`link` は Unix の既存コマンドと衝突するため） |
| CLI 同期 state | `.infixer/state` |

## 影響

- Cloudflare 上のリソースは未作成のため移行作業は不要。
- 参考資料の garden.ooo（baku89）への言及は外部サイト名なのでそのまま残す。
