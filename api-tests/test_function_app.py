import json

import azure.functions as func

import function_app as fa


def make_request(method, route, route_params=None, headers=None, json_body=None):
    body = json.dumps(json_body).encode() if json_body is not None else b""
    return func.HttpRequest(
        method=method,
        url=f"http://localhost/api/{route}",
        headers=headers or {},
        route_params=route_params or {},
        body=body,
    )


# ---- _authorize --------------------------------------------------------

def test_authorize_rejects_missing_credential():
    resp = fa._authorize({})
    assert resp.status_code == 401


def test_authorize_rejects_invalid_google_token(google_auth_invalid):
    resp = fa._authorize({"credential": "bogus"})
    assert resp.status_code == 401


def test_authorize_rejects_other_email(google_auth_wrong_email):
    # 有効なGoogleトークンでも本人以外は、無効トークンと区別できないよう401にする
    resp = fa._authorize({"credential": "token"})
    assert resp.status_code == 401


def test_authorize_accepts_allowed_email(google_auth_ok):
    assert fa._authorize({"credential": "token"}) is None


def test_authorize_accepts_temp_passcode(monkeypatch):
    monkeypatch.setattr(fa, "TEMP_PASSCODE", "escape-hatch")
    assert fa._authorize({"credential": "manual:escape-hatch"}) is None


def test_authorize_temp_passcode_wrong_value_falls_back_to_google(monkeypatch, google_auth_invalid):
    monkeypatch.setattr(fa, "TEMP_PASSCODE", "escape-hatch")
    resp = fa._authorize({"credential": "manual:wrong"})
    assert resp.status_code == 401


def test_authorize_rejects_when_google_unreachable(google_auth_unreachable):
    # tokeninfoへの疎通自体が例外を投げても、クラッシュせず401を返すこと(フェイルクローズ)
    resp = fa._authorize({"credential": "token"})
    assert resp.status_code == 401


# ---- checks (list) --------------------------------------------------------

def test_checks_list_requires_auth_on_get(tables):
    req = make_request("GET", "checks")
    resp = fa.checks(req)
    assert resp.status_code == 401


def test_checks_list_returns_saved_entries(tables, google_auth_ok):
    put_req = make_request(
        "PUT", "checks/2026-07-19", route_params={"date": "2026-07-19"},
        json_body={"credential": "token", "crossedMidnight": True},
    )
    fa.checks_item(put_req)

    list_req = make_request("GET", "checks", headers={"X-Checks-Credential": "token"})
    resp = fa.checks(list_req)
    assert resp.status_code == 200
    items = json.loads(resp.get_body())
    assert items == [{"date": "2026-07-19", "crossedMidnight": True, "ateMeal": False, "reviewDate": "", "updatedAt": items[0]["updatedAt"]}]


# ---- checks/{date} -------------------------------------------------------

def test_checks_item_requires_auth_on_get(tables):
    req = make_request("GET", "checks/2026-07-19", route_params={"date": "2026-07-19"})
    resp = fa.checks_item(req)
    assert resp.status_code == 401


def test_checks_item_put_then_get_round_trip(tables, google_auth_ok):
    put_req = make_request(
        "PUT", "checks/2026-07-19", route_params={"date": "2026-07-19"},
        json_body={"credential": "token", "crossedMidnight": True, "ateMeal": False},
    )
    put_resp = fa.checks_item(put_req)
    assert put_resp.status_code == 200
    saved = json.loads(put_resp.get_body())
    assert saved["crossedMidnight"] is True
    assert saved["ateMeal"] is False

    get_req = make_request(
        "GET", "checks/2026-07-19", route_params={"date": "2026-07-19"},
        headers={"X-Checks-Credential": "token"},
    )
    get_resp = fa.checks_item(get_req)
    assert json.loads(get_resp.get_body())["crossedMidnight"] is True


# ---- visits ---------------------------------------------------------------

def test_visits_list_requires_auth_on_get(tables):
    req = make_request("GET", "visits")
    resp = fa.visits(req)
    assert resp.status_code == 401


def test_visits_list_returns_saved_entries(tables, google_auth_ok):
    post_req = make_request("POST", "visits", json_body={"credential": "token", "place": "大阪城"})
    fa.visits(post_req)

    list_req = make_request("GET", "visits", headers={"X-Visits-Credential": "token"})
    resp = fa.visits(list_req)
    assert resp.status_code == 200
    items = json.loads(resp.get_body())
    assert len(items) == 1
    assert items[0]["place"] == "大阪城"


def test_visits_post_requires_place(google_auth_ok, tables):
    req = make_request("POST", "visits", json_body={"credential": "token", "place": "  "})
    resp = fa.visits(req)
    assert resp.status_code == 400


def test_visits_post_creates_entity(google_auth_ok, tables):
    req = make_request("POST", "visits", json_body={"credential": "token", "place": "大阪城", "lat": 34.68, "lng": 135.53})
    resp = fa.visits(req)
    assert resp.status_code == 201
    body = json.loads(resp.get_body())
    assert body["place"] == "大阪城"
    assert body["lat"] == 34.68


# ---- scores (list) ----------------------------------------------------------

def test_scores_list_requires_auth_on_get(tables):
    req = make_request("GET", "scores")
    resp = fa.scores(req)
    assert resp.status_code == 401


def test_scores_list_returns_saved_entries(tables, google_auth_ok):
    put_req = make_request(
        "PUT", "scores/2026-07-19", route_params={"date": "2026-07-19"},
        json_body={"credential": "token", "score": 80, "note": "good"},
    )
    fa.scores_item(put_req)

    list_req = make_request("GET", "scores", headers={"X-Scores-Credential": "token"})
    resp = fa.scores(list_req)
    assert resp.status_code == 200
    items = json.loads(resp.get_body())
    assert items == [{"date": "2026-07-19", "score": 80, "note": "good", "createdAt": items[0]["createdAt"]}]


# ---- scores/{date} ---------------------------------------------------------

def test_scores_item_rejects_out_of_range_score(google_auth_ok, tables):
    req = make_request(
        "PUT", "scores/2026-07-19", route_params={"date": "2026-07-19"},
        json_body={"credential": "token", "score": 150},
    )
    resp = fa.scores_item(req)
    assert resp.status_code == 400


def test_scores_item_rejects_bool_as_score(google_auth_ok, tables):
    # isinstance(True, int) is True in Python; boolはscoreとして無効にすべき
    req = make_request(
        "PUT", "scores/2026-07-19", route_params={"date": "2026-07-19"},
        json_body={"credential": "token", "score": True},
    )
    resp = fa.scores_item(req)
    assert resp.status_code == 400


def test_scores_item_accepts_valid_score(google_auth_ok, tables):
    req = make_request(
        "PUT", "scores/2026-07-19", route_params={"date": "2026-07-19"},
        json_body={"credential": "token", "score": 80, "note": "good"},
    )
    resp = fa.scores_item(req)
    assert resp.status_code == 201
    assert json.loads(resp.get_body())["score"] == 80


# ---- ba (GET: public / POST: lane-restricted) ------------------------------

def test_ba_get_is_public_no_auth(tables):
    req = make_request("GET", "ba")
    resp = fa.ba_log(req)
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == []


def test_ba_post_human_lane_requires_credential(tables):
    req = make_request("POST", "ba", json_body={"type": "new", "title": "t", "body": "b"})
    resp = fa.ba_log(req)
    assert resp.status_code == 401


def test_ba_post_human_lane_rejects_verified_on_device(google_auth_ok, tables):
    req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "verified_on_device"},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 400


def test_ba_post_claude_pc_lane_via_key(monkeypatch, tables):
    monkeypatch.setenv("BA_CLAUDE_KEY_PC", "pc-secret")
    req = make_request(
        "POST", "ba",
        json_body={"claude_key": "pc-secret", "type": "new", "title": "t", "body": "b"},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 201
    assert json.loads(resp.get_body())["by"] == "claude-pc"


def test_ba_post_claude_mobile_cannot_write_verified_on_device(monkeypatch, tables):
    monkeypatch.setenv("BA_CLAUDE_KEY_MOBILE", "mobile-secret")
    req = make_request(
        "POST", "ba",
        json_body={"claude_key": "mobile-secret", "type": "verified_on_device"},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 400


def test_ba_post_dry_run_does_not_persist(google_auth_ok, tables):
    req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "note", "ref": "x", "dry_run": True},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 200
    assert json.loads(resp.get_body())["dry_run"] is True
    assert tables["BaLog"].rows == {}


def test_ba_post_new_increments_seq(google_auth_ok, tables):
    for _ in range(3):
        req = make_request("POST", "ba", json_body={"credential": "token", "type": "new", "title": "t"})
        resp = fa.ba_log(req)
        assert resp.status_code == 201
    seqs = sorted(e["Seq"] for e in tables["BaLog"].rows.values() if "Seq" in e)
    assert seqs == [1, 2, 3]


def test_ba_seq_counter_entity_not_exposed_in_get(google_auth_ok, tables):
    req = make_request("POST", "ba", json_body={"credential": "token", "type": "new", "title": "t"})
    fa.ba_log(req)

    resp = fa.ba_log(make_request("GET", "ba"))
    items = json.loads(resp.get_body())
    assert len(items) == 1
    assert items[0]["type"] == "new"


def test_ba_post_note_uses_ref_as_partition(google_auth_ok, tables):
    new_req = make_request("POST", "ba", json_body={"credential": "token", "type": "new", "title": "t"})
    new_entry = json.loads(fa.ba_log(new_req).get_body())
    thread_id = new_entry["id"]

    note_req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "note", "ref": thread_id, "body": "追記"},
    )
    note_resp = fa.ba_log(note_req)
    assert note_resp.status_code == 201
    note_entry = json.loads(note_resp.get_body())
    assert note_entry["threadId"] == thread_id
