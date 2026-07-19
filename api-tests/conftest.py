import os
import re
import sys
from pathlib import Path

# function_app.pyは環境変数をモジュール読み込み時に参照するため、importより前に設定する。
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

os.environ.setdefault("TABLE_CONNECTION_STRING", "UseDevelopmentStorage=true")
os.environ.setdefault("GOOGLE_CLIENT_ID", "test-client-id")
os.environ.setdefault("ALLOWED_EMAIL", "owner@example.com")

import pytest
import function_app as fa  # noqa: E402


class FakeTable:
    """azure.data.tables.TableClientの、テストで使う分だけの最小フェイク。"""

    def __init__(self):
        self.rows = {}

    def list_entities(self):
        return list(self.rows.values())

    def get_entity(self, partition_key, row_key):
        return self.rows[(partition_key, row_key)]

    def upsert_entity(self, entity):
        self.rows[(entity["PartitionKey"], entity["RowKey"])] = dict(entity)

    def query_entities(self, filter_str):
        # 本アプリで使われる "Type eq 'new'" 形式だけをサポートする単純パーサ。
        m = re.match(r"(\w+) eq '([^']*)'", filter_str)
        if not m:
            return list(self.rows.values())
        field, value = m.groups()
        return [e for e in self.rows.values() if e.get(field) == value]


@pytest.fixture
def tables(monkeypatch):
    """table_name -> FakeTable。GET/POSTをまたいで状態を共有するため、テストごとに1つ。"""
    store = {}

    def _table_client(table_name):
        return store.setdefault(table_name, FakeTable())

    monkeypatch.setattr(fa, "_table_client", _table_client)
    return store


class FakeGoogleResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


@pytest.fixture
def google_auth_ok(monkeypatch):
    """ALLOWED_EMAIL本人としてログイン検証を常に通すスタブ。"""
    def _get(url, params=None, timeout=None):
        return FakeGoogleResponse(200, {
            "aud": fa.GOOGLE_CLIENT_ID,
            "email_verified": "true",
            "email": fa.ALLOWED_EMAIL,
        })
    monkeypatch.setattr(fa.requests, "get", _get)


@pytest.fixture
def google_auth_wrong_email(monkeypatch):
    """有効なGoogleトークンだが、ALLOWED_EMAIL以外のアカウントのスタブ(403想定)。"""
    def _get(url, params=None, timeout=None):
        return FakeGoogleResponse(200, {
            "aud": fa.GOOGLE_CLIENT_ID,
            "email_verified": "true",
            "email": "someone-else@example.com",
        })
    monkeypatch.setattr(fa.requests, "get", _get)


@pytest.fixture
def google_auth_invalid(monkeypatch):
    """Google側がトークンを拒否するスタブ(401想定)。"""
    def _get(url, params=None, timeout=None):
        return FakeGoogleResponse(400, {})
    monkeypatch.setattr(fa.requests, "get", _get)
