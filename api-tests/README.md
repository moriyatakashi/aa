# api-tests
[`api/`](../api/README.md)（Azure Functionsバックエンド）に対するpytestユニットテスト。ファイル名の`1_`は「グループ1」を表す通し番号([`e2e/`](../e2e/README.md)がグループ2、あちらは`2-`とハイフン区切り)。pytestのテストファイルは他ファイルから`import`されるため、ハイフンではなくアンダースコア区切り(有効なPythonモジュール名)にしている。

- `test_1_1_function_app.py` — APIエンドポイントのテスト本体
- `test_1_2_session.py` — セッション交換(`/api/session`)のテスト。`test_1_1_function_app`から`make_request`をimport
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
