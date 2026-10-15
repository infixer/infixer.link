# ADR 0008: 同一 URL 編集・自動保存・下書きの実装（Phase 2）

- 日付：2026-10-15
- 状態：採用（ローカルの Chromium / WebKit で E2E 検証。実機の IME は未検証）

## 決定

### 同一 URL での編集

- 公開ページ（SSR）は変えない。クライアントでは `/api/auth/v1/session` を 1 回だけ問い合わせる（no-store。匿名なら DB を参照しない。ヘッダーとページで共有する）。
- **編集モードと「完了」は設けない**（ユーザーの要望で、2026-10-15 に変更）。
  - 本人なら `PageEditor.svelte`（CodeMirror 6）を `import()` し、同じ grid セルの下に重ねて mount する。
  - 準備ができたら、表示用の本文とエディタを 1 フレームで入れ替える。
  - タイトルは h1、本文は `.line` と同じフォント・行の高さ・余白にそろえ、位置ずれが 1px 以内であることを E2E で確認している。
  - クリックやタップは、そのまま本文に入る。
- エディタは SSR のときの内容から始め、最新版はバックグラウンドで取りに行く。手元に未保存の変更がなければ、その最新版を取り込む（`Autosave.adoptServer`）。
- 匿名閲覧者には CodeMirror も WebAuthn のコードも配信しない（E2E で確認）。
- **新規作成**：本人にだけヘッダーに「新規」を出す。押すと `無題 YYYY-MM-DD HH:MM:SS` という名前でページを作り、タイトルが選択された状態で開く。リンクから作る導線は Phase 3。
- 保存・削除・復元で URL（pathname / query / hash）を変えない。削除後は同じ URL に「削除されました」と「元に戻す」を表示する。リロード後の 410 ページにも、本人にだけ「元に戻す」を出す。
- 日記：`/today` はサーバーの `SITE_TIME_ZONE` で日付を決めて `/daily/{date}` へ 302 で転送する（no-store、GET では作成しない）。本人が「この日の日記を書く」を押すと `POST /api/owner/v1/daily/{date}` で作成し、ページの URL へ移動してエディタを開く（SvelteKit の shallow state `edit: true`）。

### 自動保存（`src/lib/editor/autosave.ts`）

- 純粋な状態機械。タイマー・保存先・通信を差し替えて単体テストできる。
- 端末保存は 200ms の debounce。サーバー保存は入力が止まって 800ms 後、入力が続いても最大 5 秒ごと。送信中のリクエストはページごとに 1 本だけ。
- 再送では同じ mutationId を使い、サーバー側で一度しか反映されない（Phase 1 の replay）。
- `conflict` / `auth-required` では自動送信を止める。`invalid` / `too-large` は内容を直すと送信を再開する。
- サーバーが成功を返したあとにだけ IndexedDB の下書きを消す。応答が失われた送信済みの下書きは、`restore()` が「同期済み」と判定する。

### 下書き（IndexedDB）

- DB 名 `infixer-link`、ストア `drafts`（keyPath `pageId`）。保持するのは `{ title, source, baseRevision, pending: { mutationId, title, source }, savedAt }`。
- エディタを開くと、サーバーの最新版と下書きを `restore()` で突き合わせる。
  - 下書きが同じ版から作られていれば、そのまま再開する。
  - 古い版から作られていて内容が違えば、競合として扱う（自動では上書きしない）。

### 競合 UI（Phase 2 の最小版）

- 「この端末の内容」と「サーバーの最新版」を並べて表示する。選べるのは次の 2 つ。
  - 「この端末の内容で上書き」：利用者が明示的に選んだときだけ、最新の revision を base にして保存する。
  - 「サーバーの版を使う」：この端末の内容は `.link.txt` としてダウンロードしてから破棄する。
- 共通の元版との 3 者比較と差分表示は Phase 6 で行う。

### CSP と CodeMirror

- CodeMirror が実行時に差し込むスタイルに nonce を渡すため、`<meta name="csp-nonce" content="%sveltekit.nonce%">` を置き、`EditorView.cspNonce` に渡す。
- `app.html` のインラインの `style` 属性はやめ、CSS のクラスに置き換えた（CSP の `style-src 'self'` に合わせるため）。

### パスキー管理と Signal API

設定画面では、パスキーを削除したあとと画面を開いたときに WebAuthn Signal API を呼ぶ（`unknownCredential` / `allAcceptedCredentials`）。対応している OS やブラウザでは、削除したパスキーが一覧から隠れるか、削除される。未対応の環境では何も起きない。

## 未対応・後続 Phase

- Service Worker・outbox・未送信画像は Phase 6。
- 構文の装飾とリンク補完は Phase 3。
- macOS / iOS / Android の実機 IME（変換・確定・再変換・Undo）は未検証。自動テストの CJK 入力は insertText 相当で、composition は通らない。
