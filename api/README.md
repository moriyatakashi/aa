# api
Azure Functionsバックエンド (`ab-board-api`)。`src/`配下の各アプリから叩かれるAPIをまとめている。

- `function_app.py` — エンドポイント本体
- `host.json` / `requirements.txt` — Azure Functions設定・依存パッケージ

## デプロイ
`.github/workflows/azure-functions-deploy.yml` により、`api/**`への変更が`main`にpushされると自動デプロイされる。

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
    "TEMP_PASSCODE": "localdev"
  }
}
```
`TEMP_PASSCODE` を設定しておくと、実際のGoogleログインなしで `credential: "manual:<パスコード>"` を使って動作確認できる([function_app.py](function_app.py)の`_authorize`参照)。

別ターミナルでAzuriteを起動したままにする。
```
azurite --silent --location <任意の作業ディレクトリ>
```

テーブルはコードが自動作成しないため、初回のみ作成しておく。
```
python -c "
from azure.data.tables import TableServiceClient
svc = TableServiceClient.from_connection_string('UseDevelopmentStorage=true')
for name in ['Checks', 'Visits', 'Scores', 'BaLog']:
    svc.create_table_if_not_exists(name)
"
```

依存パッケージをインストールしてFunctionsホストを起動する。
```
pip install -r api/requirements.txt
cd api && func start
```
`http://localhost:7071/api/checks` などにリクエストが通れば起動確認完了。

`src/`の各アプリと繋いで確認したい場合は、[`cm/config.js`](../src/cm/config.js)の`AA_API_BASE`が本番URLに直書きされているため、一時的に`http://localhost:7071/api`へ書き換える必要がある。
