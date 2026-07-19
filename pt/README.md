# pt
[`ap/`](../ap/README.md)（Azure Functionsバックエンド）に対するpytestユニットテスト。

- `test_function_app.py` — テスト本体
- `conftest.py` — テーブルストレージ・Google認証をフェイク/スタブに差し替えるフィクスチャ

## 実行
```
pytest pt/
```
CIでは `.github/workflows/test.yml` の `test-python` ジョブで実行される。
