# ADR 0007: 本人認証の実装方針（Phase 1）

- 日付：2026-10-15
- 状態：採用（ローカル workerd + Chromium 仮想認証器で検証。実ブラウザ・staging は未検証）

## 決定

### 原子性：`tx_guard` による条件付き batch

D1 には BEGIN/COMMIT がなく、`batch()` は SQL エラー時にだけ rollback する（ADR 0002）。条件付き UPDATE が 0 行でもエラーにならないため、以下を使う。

```sql
UPDATE auth_challenges SET consumed_at = ?1 WHERE id = ?2 AND consumed_at IS NULL AND expires_at > ?1;
INSERT INTO tx_guard (ok) VALUES (changes() = 1);   -- 0 行なら CHECK (ok = 1) 違反で batch 全体を rollback
...
DELETE FROM tx_guard;
```

これで次の操作を一括で確定する。

- 「challenge 消費 + 初回 credential 登録 + setup 完了 + session 発行」
- 「challenge 消費 + counter 更新 + session 発行」
- 「passkey 失効 + 最後の 1 本チェック + 関連 session 失効」

並行する再送は片方だけが成功する（テストで確認）。

### テスト専用の認証経路を作らない

設計 §17 Phase 1 の「test 専用認証 adapter が production で有効にならないこと」は、**adapter 自体を作らない**ことで満たす。

- Workers 統合テスト：ソフトウェア認証器（`tests/helpers/soft-authenticator.ts`）で実際の WebAuthn 検証を通す。
- E2E：Chromium の CDP 仮想認証器で実ブラウザの ceremony を通す。
- `src/lib/boundaries.test.ts` が、アプリコードから `tests/` を import していないことを検査する。

### Cookie

| 環境 | session | ceremony |
|---|---|---|
| HTTPS（staging / production） | `__Host-link_session`（Secure, HttpOnly, SameSite=Lax, Path=/） | `__Host-link_ceremony`（Strict, 5 分） |
| `http://localhost`（開発・E2E） | `link_session`（Secure なし） | `link_ceremony` |

`APP_ORIGINS` がすべて https のときだけ `__Host-` を使う（`makeAuthConfig`）。https 以外を許すのは localhost だけ。

### 設定（環境ごとに固定。Host header から作らない）

- `RP_ID`、`APP_ORIGINS`（カンマ区切り）を wrangler `vars` に置く。origin は RP ID の配下でなければ起動時にエラーにする。
- production：`infixer.link` / `https://infixer.link`。staging：`staging.infixer.link` / `https://staging.infixer.link`。

### その他

- **ceremony のブラウザ紐付け**：options 発行時に乱数 secret を HttpOnly cookie に入れ、DB には hash を保存する。verify では cookie を必須にし、別ブラウザに challenge を持ち出せない。
- **レート制限**：D1 の固定窓（10 分）。キーは IP 単位（setup 10 回、auth 30 回）。owner 全体のロックはしない。
- **CSRF**：owner API と認証済みの auth 操作は、Origin が `APP_ORIGINS` に含まれることと `x-csrf-token`（session ごとの乱数）を必須にする。
- **Bearer**：Phase 7 まで `Authorization` ヘッダー付きのリクエストは 401（cookie との混在を拒否）。
- **再認証**：パスキーの追加・削除と他 session の一括失効には、5 分以内の再認証を要求する。通常の保存では要求しない。

## 未対応・後続 Phase

- 期限切れの `auth_challenges` / `auth_rate_limits` の掃除は Phase 8 の Cron で行う。
- 実機（iPhone / Android / macOS）のパスキー、同期パスキー（counter 0）、cross-device 認証は staging で確認する。
