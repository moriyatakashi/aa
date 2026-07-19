# api-tests
[`api/`](../api/README.md)（Azure Functionsバックエンド）に対するpytestユニットテスト。

- `test_function_app.py` — テスト本体
- `conftest.py` — テーブルストレージ・Google認証をフェイク/スタブに差し替えるフィクスチャ

## 実行
初回のみ依存パッケージをインストール。
```
pip install -r api-tests/requirements.txt
```
```
pytest api-tests/
```
Table StorageやGoogle認証への実接続は不要(`conftest.py`のフィクスチャがフェイク/スタブに差し替える)。CIでは `.github/workflows/test.yml` の `test-python` ジョブで実行される。
