# ADR 0003: SimpleWebAuthn を Workers で使う

- 日付：2026-10-15
- 状態：採用（ローカル workerd で実証。実ブラウザ・staging は未検証）
- 検証：`apps/web/tests/workers/webauthn.test.ts`、`apps/web/tests/helpers/soft-authenticator.ts`

## 実証結果

`@simplewebauthn/server` 14.0.3 は **追加の compatibility flag なし**（`nodejs_als` のみ）で workerd 上で動作した。

テスト用のソフトウェア認証器（ES256、attestation `none`、CBOR/COSE を自前生成）で以下を確認：

| ケース | 結果 |
|---|---|
| discoverable credential 用の認証 options が credential ID を列挙しない | OK |
| 登録 → 認証の検証成功、`userVerified: true`、counter 更新 | OK |
| 誤った origin | 拒否 |
| 誤った RP ID hash | 拒否 |
| UV フラグなし（`requireUserVerification: true`） | 拒否 |
| 署名改ざん | 拒否 |
| 別 challenge への署名 | 拒否 |

## CPU 時間の目安

`node scripts/bench-webauthn.ts`（Node 24.2 / V8、Apple M4 Pro 開発機、2026-10-15）：

- `verifyRegistrationResponse`：median 0.09ms、p95 0.93ms
- `verifyAuthenticationResponse`：median 0.19ms、p95 0.29ms、初回 1.15ms

Workers Free の 10ms/リクエスト上限に対し、**検証処理自体は余裕がある見込み**。ただし以下は未計測：

- Workers 実環境の CPU 計上（Web Crypto の扱い、cold start 時のモジュール初期化）
- SSR・D1 処理と合わせたリクエスト全体の CPU 時間

→ staging deploy 後に Workers Observability の CPU time で実測し、Free / Paid の判断を `docs/performance.md` に記録する。

## 決定

- RP ID / origin は環境ごとに固定値（production `infixer.link` / `https://infixer.link`、staging `staging.infixer.link`）。Host header から生成しない。
- テスト用ソフトウェア認証器は `tests/` 配下に置き、アプリコードから import しない（Phase 1 で lint 規則か import 境界テストを追加）。
