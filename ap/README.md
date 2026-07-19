# ap
Azure Functionsバックエンド (`ab-board-api`)。`src/`配下の各アプリから叩かれるAPIをまとめている。

- `function_app.py` — エンドポイント本体
- `host.json` / `requirements.txt` — Azure Functions設定・依存パッケージ

## デプロイ
`.github/workflows/azure-functions-deploy.yml` により、`ap/**`への変更が`main`にpushされると自動デプロイされる。

## テスト
[`pt/`](../pt/README.md) を参照。
