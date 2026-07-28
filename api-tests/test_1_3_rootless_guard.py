import json
import function_app as fa
import azure.functions as func


def make_request(method, route, json_body=None):
    body = json.dumps(json_body).encode() if json_body is not None else b""
    return func.HttpRequest(method=method, url=f"http://localhost/api/{route}",
                            headers={}, params={}, route_params={}, body=body)


def _new_root(pc_key="pc-secret"):
    return json.loads(fa.ba_log(make_request(
        "POST", "ba",
        json_body={"claude_key": pc_key, "type": "new", "title": "t", "body": "b"},
    )).get_body())


def test_status_with_valid_ref_succeeds(monkeypatch, tables):
    monkeypatch.setenv("BA_CLAUDE_KEY_PC", "pc-secret")
    root = _new_root()
    resp = fa.ba_log(make_request("POST", "ba", json_body={
        "claude_key": "pc-secret", "type": "status", "status": "closed", "ref": root["id"],
    }))
    assert resp.status_code == 201


def test_status_with_unknown_ref_rejected(monkeypatch, tables):
    # 実インシデントの壊れref(接尾辞欠落)。rootが無いので400で弾く。
    monkeypatch.setenv("BA_CLAUDE_KEY_PC", "pc-secret")
    resp = fa.ba_log(make_request("POST", "ba", json_body={
        "claude_key": "pc-secret", "type": "status", "status": "closed", "ref": "20260723T183007",
    }))
    assert resp.status_code == 400


def test_status_without_ref_rejected(monkeypatch, tables):
    monkeypatch.setenv("BA_CLAUDE_KEY_PC", "pc-secret")
    resp = fa.ba_log(make_request("POST", "ba", json_body={
        "claude_key": "pc-secret", "type": "status", "status": "closed",
    }))
    assert resp.status_code == 400


def test_gist_with_valid_ref_succeeds(monkeypatch, tables):
    monkeypatch.setenv("BA_CLAUDE_KEY_PC", "pc-secret")
    root = _new_root()
    resp = fa.ba_log(make_request("POST", "ba", json_body={
        "claude_key": "pc-secret", "type": "gist", "text": "結論はこう", "ref": root["id"],
    }))
    assert resp.status_code == 201


def test_gist_with_unknown_ref_rejected(monkeypatch, tables):
    monkeypatch.setenv("BA_CLAUDE_KEY_PC", "pc-secret")
    resp = fa.ba_log(make_request("POST", "ba", json_body={
        "claude_key": "pc-secret", "type": "gist", "text": "結論はこう", "ref": "20260723T183007",
    }))
    assert resp.status_code == 400


def test_gist_without_ref_rejected(monkeypatch, tables):
    monkeypatch.setenv("BA_CLAUDE_KEY_PC", "pc-secret")
    resp = fa.ba_log(make_request("POST", "ba", json_body={
        "claude_key": "pc-secret", "type": "gist", "text": "結論はこう",
    }))
    assert resp.status_code == 400
