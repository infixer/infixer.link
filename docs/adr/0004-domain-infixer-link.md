# ADR 0004: ドメインは infixer.link（apex）

- 日付：2026-10-15
- 状態：採用（ユーザー決定）

## 決定

| 用途 | ホスト | WebAuthn RP ID / origin |
|---|---|---|
| 本体（公開・同一URL編集） | `infixer.link` | `infixer.link` / `https://infixer.link` |
| 画像配信（公開 R2） | `media.infixer.link` | — |
| staging | `staging.infixer.link` | `staging.infixer.link` / `https://staging.infixer.link`（別 D1 / R2） |

設計書中の `example.net` / `media.example.net` はそれぞれ上記に読み替える。

## 影響

- パスキーは RP ID に紐づく。production RP ID `infixer.link` のパスキーはサブドメインでも利用可能になり得るが、staging は別 RP ID・別 DB として扱い、本番 credential を共有しない。
- 将来 infixer.net 等へ移る場合は設計 §9.5 の移行手順（旧 origin で認証中に新 origin の登録）が必要。
- Cloudflare 上の DNS・custom domain・R2 bucket の作成は、ユーザーの都度承認の後に行う。
