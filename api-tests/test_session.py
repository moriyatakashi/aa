import json

import function_app as fa

from test_function_app import make_request


def enable_session_secret(monkeypatch, secret="test-session-secret"):
    monkeypatch.setattr(fa, "SESSION_SECRET", secret)


# ---- POST /session (発行) --------------------------------------------------

def test_session_create_disabled_without_secret(tables, google_auth_ok):
    # SESSION_SECRET未設定(デフォルト)なら、Google認証が正しくても機能自体が無効
    req = make_request("POST", "session", json_body={"credential": "token"})
    resp = fa.session(req)
    assert resp.status_code == 503


def test_session_create_rejects_invalid_google_token(tables, google_auth_invalid, monkeypatch):
    enable_session_secret(monkeypatch)
    req = make_request("POST", "session", json_body={"credential": "bogus"})
    resp = fa.session(req)
    assert resp.status_code == 401


def test_session_create_rejects_other_email(tables, google_auth_wrong_email, monkeypatch):
    enable_session_secret(monkeypatch)
    req = make_request("POST", "session", json_body={"credential": "token"})
    resp = fa.session(req)
    assert resp.status_code == 401


def test_session_create_cannot_chain_from_existing_session_token(tables, google_auth_invalid, monkeypatch):
    # session:トークン自体を"credential"として渡しても、Google検証に回されて拒否される
    # (無期限トークンを無期限トークンで延々自己更新できてしまう事故を避けるため)。
    enable_session_secret(monkeypatch)
    req = make_request("POST", "session", json_body={"credential": "session:abc.def"})
    resp = fa.session(req)
    assert resp.status_code == 401


def test_session_create_returns_usable_token(tables, google_auth_ok, monkeypatch):
    enable_session_secret(monkeypatch)
    req = make_request("POST", "session", json_body={"credential": "token"})
    resp = fa.session(req)
    assert resp.status_code == 201
    body = json.loads(resp.get_body())
    assert body["sessionToken"].startswith("session:")

    # 発行されたトークンは以降_authorizeを通す
    assert fa._authorize({"credential": body["sessionToken"]}) is None


def test_session_token_with_tampered_signature_rejected(tables, google_auth_ok, monkeypatch):
    enable_session_secret(monkeypatch)
    req = make_request("POST", "session", json_body={"credential": "token"})
    body = json.loads(fa.session(req).get_body())
    session_id, _, _sig = body["sessionToken"][len("session:"):].rpartition(".")
    tampered = f"session:{session_id}.deadbeef"
    resp = fa._authorize({"credential": tampered})
    assert resp.status_code == 401


def test_session_token_rejected_when_secret_later_unset(tables, google_auth_ok, monkeypatch):
    enable_session_secret(monkeypatch)
    req = make_request("POST", "session", json_body={"credential": "token"})
    token = json.loads(fa.session(req).get_body())["sessionToken"]

    # SESSION_SECRETが空に戻ると、session:トークンはGoogle検証経路に落ちる。
    # session:トークンの文字列はGoogleの発行するIDトークンではないので、実際のGoogle
    # tokeninfoに投げれば拒否される(=誤ってフォールバックせず安全側に倒れる)ことを、
    # ここではtokeninfoが拒否を返すスタブに切り替えて確認する。
    monkeypatch.setattr(fa, "SESSION_SECRET", "")

    class _RejectResponse:
        status_code = 400

        def json(self):
            return {}

    monkeypatch.setattr(fa.requests, "get", lambda *a, **k: _RejectResponse())
    resp = fa._authorize({"credential": token})
    assert resp.status_code == 401


# ---- DELETE /session (ログアウト) ------------------------------------------

def test_session_logout_revokes_token(tables, google_auth_ok, monkeypatch):
    enable_session_secret(monkeypatch)
    create_req = make_request("POST", "session", json_body={"credential": "token"})
    token = json.loads(fa.session(create_req).get_body())["sessionToken"]
    assert fa._authorize({"credential": token}) is None

    logout_req = make_request("DELETE", "session", json_body={"credential": token})
    logout_resp = fa.session(logout_req)
    assert logout_resp.status_code == 204

    # 失効後は同じトークンでもう通らない
    resp = fa._authorize({"credential": token})
    assert resp.status_code == 401


def test_session_logout_rejects_malformed_credential(tables, monkeypatch):
    enable_session_secret(monkeypatch)
    req = make_request("DELETE", "session", json_body={"credential": "not-a-session-token"})
    resp = fa.session(req)
    assert resp.status_code == 401


def test_session_logout_disabled_without_secret(tables):
    req = make_request("DELETE", "session", json_body={"credential": "session:x.y"})
    resp = fa.session(req)
    assert resp.status_code == 503
