# api
Azure Functionsバックエンド (`ab-board-api`)。`src/`配下の各アプリから叩かれるAPIをまとめている。

- `function_app.py` — エンドポイント本体
- `host.json` / `requirements.txt` — Azure Functions設定・依存パッケージ

## デプロイ
`.github/workflows/azure-functions-deploy.yml` により、`api/**`への変更が`main`にpushされると自動デプロイされる。

### 永続セッション機能(ba-XX)を本番で有効化する手順
コードをデプロイしただけでは`SESSION_SECRET`が未設定のため機能は無効のまま(既存のGoogleログインだけが動く、安全側)。有効化するには、Azure Function App (`ab-board-api`) 側で以下を**手動で**行う必要がある(このコマンド実行環境からは実施できない)。

1. Azure Portal または `az functionapp config appsettings set` で、アプリケーション設定に`SESSION_SECRET`を追加する。値はランダムな長い文字列にする(例: `python -c "import secrets; print(secrets.token_urlsafe(32))"`の出力)。他の人に共有しない。
2. 本番のTable Storageに`Sessions`テーブルを作成する(他のテーブルと同様、コードは自動作成しない)。
3. `/api/session`にPOSTしてトークンが発行されること、`_authorize`が通ること、DELETEでログアウトできることを一度確認する。

`SESSION_SECRET`を削除・変更すると、発行済みの永続セッショントークンは全て一括で失効する(緊急時の全端末ログアウト手段としても使える)。

### last-updated用GitHubトークンを設定する(ba-69、任意)
`src/common/last-updated.js`(各ページの「更新: ...」表示)は`/api/last-updated`を経由してGitHub commits APIを叩く。`GITHUB_TOKEN`が未設定でも動作する(未認証のままGitHub APIを叩く、60req/時/IP)が、設定すると認証済み扱いになり5000req/時まで引き上げられる。

GitHubトークンはコード上どこにも埋め込まれておらず、Azure Function Appのアプリケーション設定としてのみ保持する(クライアント側JSには一切渡らない)。**このトークンの発行・設定はTakashi本人が行う必要がある**(GitHubの新規トークン発行はWeb UI経由のみで、Claude Codeの実行環境からは代行できない)。

1. GitHubの Settings → Developer settings → Fine-grained personal access tokens で新規トークンを発行する。
   - Repository access: `moriyatakashi/aa` のみに限定
   - Permissions: `Contents` → `Read-only` のみ(それ以外は付けない)
   - 有効期限は任意(切れたら`GITHUB_TOKEN`未設定時の動作=未認証60req/時にフォールバックするだけで、last-updated機能自体は壊れない)
2. Azure Portal(`ab-board-api` → 構成 → アプリケーション設定)で`GITHUB_TOKEN`を追加し、発行したトークンの値を設定する。または`az functionapp config appsettings set -g rg-ab -n ab-board-api --settings GITHUB_TOKEN=<値>`をTakashi本人の端末で実行する。
3. `/api/last-updated?path=src/k1`にGETし、200と`{"date": "..."}`が返ることを確認する(トークン設定前後どちらでも同じレスポンス形式になるため、レート制限に達していない限り違いは見た目上分からない)。

## テスト
[`api-tests/`](../api-tests/README.md) を参照。テストはTable Storage/Google認証をフェイクに差し替えるので、下記のローカル起動は不要。

## ローカルで実サーバーとして起動する
初回のみ、以下をグローバルインストール。
```
npm i -g azure-functions-core-tools@4
npm i -g azurite
```

`api/local.settings.json`（gitignore対象、各自作成）を用意する。
```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "python",
    "TABLE_CONNECTION_STRING": "UseDevelopmentStorage=true",
    "GOOGLE_CLIENT_ID": "local-dev-dummy-client-id",
    "ALLOWED_EMAIL": "dev@example.com",
    "TEMP_PASSCODE": "localdev",
    "SESSION_SECRET": "local-dev-dummy-session-secret"
  }
}
```
`TEMP_PASSCODE` を設定しておくと、実際のGoogleログインなしで `credential: "manual:<パスコード>"` を使って動作確認できる([function_app.py](function_app.py)の`_authorize`参照)。

`SESSION_SECRET` は永続セッション機能(`POST/DELETE /api/session`)の署名鍵。**未設定の場合はこの機能自体が無効化され(`/api/session`は503)、既存のGoogle IDトークン直接検証フローだけが動く**(安全側デフォルト)。設定する場合はランダムな長い文字列にする(例: `python -c "import secrets; print(secrets.token_urlsafe(32))"`)。値を変更・削除すると、発行済みの永続セッショントークンは全て一括で失効する。

別ターミナルでAzuriteを起動したままにする。
```
azurite --silent --location <任意の作業ディレクトリ>
```

テーブルはコードが自動作成しないため、初回のみ作成しておく。
```
python -c "
from azure.data.tables import TableServiceClient
svc = TableServiceClient.from_connection_string('UseDevelopmentStorage=true')
for name in ['Visits', 'Scores', 'BaLog', 'Sessions']:
    svc.create_table_if_not_exists(name)
"
```
(`Sessions`は永続セッション機能用。`SESSION_SECRET`を設定しない場合は使われないが、作成しておいて問題はない。)

依存パッケージをインストールしてFunctionsホストを起動する。
```
pip install -r api/requirements.txt
cd api && func start
```
`http://localhost:7071/api/scores` などにリクエストが通れば起動確認完了。

`src/`の各アプリと繋いで確認したい場合は、[`common/config.js`](../src/common/config.js)の`AA_API_BASE`が本番URLに直書きされているため、一時的に`http://localhost:7071/api`へ書き換える必要がある。
