import json

import azure.functions as func
import pytest
import requests

import function_app as fa


def make_request(method, route, route_params=None, headers=None, json_body=None, params=None):
    body = json.dumps(json_body).encode() if json_body is not None else b""
    return func.HttpRequest(
        method=method,
        url=f"http://localhost/api/{route}",
        headers=headers or {},
        params=params or {},
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


def test_authorize_accepts_manual_passcode(monkeypatch):
    monkeypatch.setattr(fa, "RBA_MANUAL_PASSCODE", "escape-hatch")
    assert fa._authorize({"credential": "manual:escape-hatch"}) is None


def test_authorize_manual_passcode_wrong_value_falls_back_to_google(monkeypatch, google_auth_invalid):
    monkeypatch.setattr(fa, "RBA_MANUAL_PASSCODE", "escape-hatch")
    resp = fa._authorize({"credential": "manual:wrong"})
    assert resp.status_code == 401


def test_authorize_rejects_when_google_unreachable(google_auth_unreachable):
    # tokeninfoへの疎通自体が例外を投げても、クラッシュせず401を返すこと(フェイルクローズ)
    resp = fa._authorize({"credential": "token"})
    assert resp.status_code == 401


# ---- visits ---------------------------------------------------------------

def test_visits_get_is_public_no_auth(tables):
    # ba-35残課題(2): 閲覧はログイン不要(2026-07-20)。書き込みは引き続き認証必須。
    req = make_request("GET", "visits")
    resp = fa.visits(req)
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == []


def test_visits_list_returns_saved_entries(tables, google_auth_ok):
    post_req = make_request("POST", "visits", json_body={"credential": "token", "place": "大阪城"})
    fa.visits(post_req)

    list_req = make_request("GET", "visits")
    resp = fa.visits(list_req)
    assert resp.status_code == 200
    items = json.loads(resp.get_body())
    assert len(items) == 1
    assert items[0]["place"] == "大阪城"


def test_visits_post_requires_auth(tables):
    req = make_request("POST", "visits", json_body={"place": "大阪城"})
    resp = fa.visits(req)
    assert resp.status_code == 401


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


# ---- points (ba-165: 加点軸の拡張) ------------------------------------------

def test_points_get_is_public_no_auth(tables):
    req = make_request("GET", "points")
    resp = fa.points(req)
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == []


def test_points_list_returns_saved_entries(tables, google_auth_ok):
    post_req = make_request("POST", "points", json_body={"credential": "token", "axis": "部屋片付け", "points": 5})
    fa.points(post_req)

    list_req = make_request("GET", "points")
    resp = fa.points(list_req)
    assert resp.status_code == 200
    items = json.loads(resp.get_body())
    assert len(items) == 1
    assert items[0]["axis"] == "部屋片付け"
    assert items[0]["points"] == 5


def test_points_post_requires_auth(tables):
    req = make_request("POST", "points", json_body={"axis": "部屋片付け", "points": 5})
    resp = fa.points(req)
    assert resp.status_code == 401


def test_points_post_requires_axis(google_auth_ok, tables):
    req = make_request("POST", "points", json_body={"credential": "token", "axis": "  ", "points": 5})
    resp = fa.points(req)
    assert resp.status_code == 400


def test_points_post_rejects_non_integer_points(google_auth_ok, tables):
    req = make_request("POST", "points", json_body={"credential": "token", "axis": "運動", "points": "たくさん"})
    resp = fa.points(req)
    assert resp.status_code == 400


def test_points_post_creates_entity(google_auth_ok, tables):
    req = make_request("POST", "points", json_body={"credential": "token", "axis": "新規市", "points": 3, "note": "神戸"})
    resp = fa.points(req)
    assert resp.status_code == 201
    body = json.loads(resp.get_body())
    assert body["axis"] == "新規市"
    assert body["points"] == 3
    assert body["note"] == "神戸"


# ---- scores (list) ----------------------------------------------------------

def test_scores_get_is_public_no_auth(tables):
    # ba-35残課題(2): 閲覧はログイン不要(2026-07-20)。書き込みは引き続き認証必須。
    req = make_request("GET", "scores")
    resp = fa.scores(req)
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == []


def test_scores_list_returns_saved_entries(tables, google_auth_ok):
    put_req = make_request(
        "PUT", "scores/2026-07-19", route_params={"date": "2026-07-19"},
        json_body={"credential": "token", "score": 80, "note": "good"},
    )
    fa.scores_item(put_req)

    list_req = make_request("GET", "scores")
    resp = fa.scores(list_req)
    assert resp.status_code == 200
    items = json.loads(resp.get_body())
    assert items == [{"date": "2026-07-19", "score": 80, "note": "good", "createdAt": items[0]["createdAt"]}]


# ---- scores/{date} ---------------------------------------------------------

def test_scores_item_get_is_public_no_auth(tables):
    req = make_request("GET", "scores/2026-07-19", route_params={"date": "2026-07-19"})
    resp = fa.scores_item(req)
    assert resp.status_code == 200


def test_scores_item_put_requires_auth(tables):
    req = make_request(
        "PUT", "scores/2026-07-19", route_params={"date": "2026-07-19"},
        json_body={"score": 80},
    )
    resp = fa.scores_item(req)
    assert resp.status_code == 401


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
    # ba-30(4): upsertなので既定の200(checksと統一、以前は常に201だった)
    assert resp.status_code == 200
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


def test_ba_post_claude_lane_cannot_write_approval(monkeypatch, tables):
    # ba-77: 承認キュー。claudeレーンが自分の提案を自分で承認できてしまうと意味が無いため禁止する。
    monkeypatch.setenv("BA_CLAUDE_KEY_PC", "pc-secret")
    req = make_request(
        "POST", "ba",
        json_body={"claude_key": "pc-secret", "type": "approval", "ref": "x", "approvesId": "y"},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 400


def test_ba_post_human_lane_can_write_approval(google_auth_ok, tables):
    # ba-77: takashi本人(実ログイン)だけがapprovalを書ける。
    req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "approval", "ref": "x", "approvesId": "y"},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 201
    body = json.loads(resp.get_body())
    assert body["by"] == "takashi"
    assert body["approvesId"] == "y"


def test_ba_post_human_lane_can_write_correction(google_auth_ok, tables):
    # correction: タイトルは追記オンリーで固定されがちなので、既存のcorrection型
    # (thread-logic.jsのdisplayTitle解決で「最新が勝つ」)を人間レーンにも開放した。
    req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "correction", "ref": "x", "title": "新しいタイトル"},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 201
    body = json.loads(resp.get_body())
    assert body["by"] == "takashi"
    assert body["title"] == "新しいタイトル"


def test_ba_post_human_lane_can_write_react(google_auth_ok, tables):
    # react: 3レーンそれぞれが自分の反応を残せる、判断根拠にしない軽い種別。
    req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "react", "ref": "x", "value": True},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 201
    body = json.loads(resp.get_body())
    assert body["by"] == "takashi"
    assert body["value"] is True


def test_ba_post_claude_pc_lane_can_write_react(monkeypatch, tables):
    monkeypatch.setenv("BA_CLAUDE_KEY_PC", "pc-secret")
    req = make_request(
        "POST", "ba",
        json_body={"claude_key": "pc-secret", "type": "react", "ref": "x", "value": True},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 201
    assert json.loads(resp.get_body())["by"] == "claude-pc"


# ---- link (ba-162: 関連付け) ---------------------------------------------

def test_ba_post_human_lane_can_write_link(google_auth_ok, tables):
    req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "link", "ref": "x", "relSeq": 42},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 201
    body = json.loads(resp.get_body())
    assert body["by"] == "takashi"
    assert body["relSeq"] == 42
    assert body["value"] is True  # 省略時はtrue補完


def test_ba_post_claude_pc_lane_can_write_link(monkeypatch, tables):
    monkeypatch.setenv("BA_CLAUDE_KEY_PC", "pc-secret")
    req = make_request(
        "POST", "ba",
        json_body={"claude_key": "pc-secret", "type": "link", "ref": "x", "relSeq": 1},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 201
    assert json.loads(resp.get_body())["by"] == "claude-pc"


def test_ba_link_accepts_explicit_false_value_as_retraction(google_auth_ok, tables):
    req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "link", "ref": "x", "relSeq": 1, "value": False},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 201
    assert json.loads(resp.get_body())["value"] is False


def test_ba_link_rejects_missing_relseq(google_auth_ok, tables):
    req = make_request("POST", "ba", json_body={"credential": "token", "type": "link", "ref": "x"})
    assert fa.ba_log(req).status_code == 400


def test_ba_link_rejects_non_integer_relseq(google_auth_ok, tables):
    req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "link", "ref": "x", "relSeq": "ba-1"},
    )
    assert fa.ba_log(req).status_code == 400


def test_ba_link_rejects_non_positive_relseq(google_auth_ok, tables):
    req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "link", "ref": "x", "relSeq": 0},
    )
    assert fa.ba_log(req).status_code == 400


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


def test_ba_seq_counter_transient_error_is_not_swallowed(google_auth_ok, tables, monkeypatch):
    # 実例(2026-07-20): カウンタ読み取りの一時的な失敗を握りつぶして0扱いにした結果、
    # 既存の最新seqと衝突する採番(重複)が発生した。ResourceNotFoundError(未初期化)
    # 以外の例外は伝播し、リクエスト自体を失敗させるべきで、黙って0に巻き戻しては
    # いけない。
    table = fa._table_client("BaLog")
    real_get_entity = table.get_entity

    def flaky_get_entity(partition_key, row_key):
        if partition_key == fa.BA_SEQ_PARTITION:
            raise TimeoutError("simulated transient table storage error")
        return real_get_entity(partition_key, row_key)

    monkeypatch.setattr(table, "get_entity", flaky_get_entity)

    req = make_request("POST", "ba", json_body={"credential": "token", "type": "new", "title": "t"})
    with pytest.raises(TimeoutError):
        fa.ba_log(req)


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


# ---- ba difficulty (ba-53) --------------------------------------------------

def test_ba_new_defaults_difficulty_to_normal(google_auth_ok, tables):
    req = make_request("POST", "ba", json_body={"credential": "token", "type": "new", "title": "t"})
    entry = json.loads(fa.ba_log(req).get_body())
    assert entry["difficulty"] == "normal"


def test_ba_new_accepts_valid_difficulty(google_auth_ok, tables):
    req = make_request("POST", "ba", json_body={"credential": "token", "type": "new", "title": "t", "difficulty": "high"})
    entry = json.loads(fa.ba_log(req).get_body())
    assert entry["difficulty"] == "high"


def test_ba_new_rejects_invalid_difficulty(google_auth_ok, tables):
    req = make_request("POST", "ba", json_body={"credential": "token", "type": "new", "title": "t", "difficulty": "extreme"})
    resp = fa.ba_log(req)
    assert resp.status_code == 400


def test_ba_note_ignores_difficulty_validation(google_auth_ok, tables):
    # difficultyのバリデーションはtype=="new"のときだけ。note等では素通りする。
    new_req = make_request("POST", "ba", json_body={"credential": "token", "type": "new", "title": "t"})
    thread_id = json.loads(fa.ba_log(new_req).get_body())["id"]
    note_req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "note", "ref": thread_id, "body": "b", "difficulty": "not-a-real-level"},
    )
    assert fa.ba_log(note_req).status_code == 201


# ---- scoring-rules (ba-159: イカサマ対策/基準ずらし記録) ---------------------

def test_scoring_rules_get_seeds_current_points_when_empty(tables):
    resp = fa.scoring_rules(make_request("GET", "scoring-rules"))
    assert resp.status_code == 200
    items = json.loads(resp.get_body())
    assert len(items) == 1
    assert items[0]["effectiveFrom"] == "2026-01-01"
    assert items[0]["difficultyPoints"] == {"low": 2, "normal": 5, "high": 10}


def test_scoring_rules_post_requires_auth(tables):
    resp = fa.scoring_rules(make_request("POST", "scoring-rules", json_body={"difficultyPoints": {"low": 1, "normal": 2, "high": 3}}))
    assert resp.status_code == 401


def test_scoring_rules_post_rejects_wrong_keys(google_auth_ok, tables):
    resp = fa.scoring_rules(make_request(
        "POST", "scoring-rules",
        json_body={"credential": "token", "difficultyPoints": {"low": 1, "normal": 2}},
    ))
    assert resp.status_code == 400


def test_scoring_rules_post_rejects_non_integer_values(google_auth_ok, tables):
    resp = fa.scoring_rules(make_request(
        "POST", "scoring-rules",
        json_body={"credential": "token", "difficultyPoints": {"low": 1, "normal": 2, "high": "たくさん"}},
    ))
    assert resp.status_code == 400


def test_scoring_rules_post_rejects_malformed_effective_from(google_auth_ok, tables):
    resp = fa.scoring_rules(make_request(
        "POST", "scoring-rules",
        json_body={"credential": "token", "difficultyPoints": {"low": 1, "normal": 2, "high": 3}, "effectiveFrom": "bogus"},
    ))
    assert resp.status_code == 400


def test_scoring_rules_post_adds_new_version(google_auth_ok, tables):
    resp = fa.scoring_rules(make_request(
        "POST", "scoring-rules",
        json_body={
            "credential": "token",
            "difficultyPoints": {"low": 4, "normal": 8, "high": 16},
            "effectiveFrom": "2026-08-01",
            "note": "テストで倍増",
        },
    ))
    assert resp.status_code == 201

    list_resp = fa.scoring_rules(make_request("GET", "scoring-rules"))
    items = json.loads(list_resp.get_body())
    assert [i["effectiveFrom"] for i in items] == ["2026-01-01", "2026-08-01"]
    assert items[1]["difficultyPoints"] == {"low": 4, "normal": 8, "high": 16}
    assert items[1]["note"] == "テストで倍増"


# ---- weekly-scores (ba-53) ---------------------------------------------------

def _close_thread(tables_dict, difficulty, closed_at_iso):
    """difficultyありのスレッドを作り、指定日時にcloseするテスト用ヘルパー。"""
    ba_table = fa._table_client("BaLog")
    thread_id = f"thread-{difficulty}-{closed_at_iso}"
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id, "By": "takashi", "Ref": "", "Type": "new",
        "Data": json.dumps({"title": "t", "difficulty": difficulty}), "CreatedAt": closed_at_iso, "Seq": 1,
    })
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id + "-close", "By": "takashi", "Ref": thread_id,
        "Type": "status", "Data": json.dumps({"status": "closed"}), "CreatedAt": closed_at_iso,
    })


def test_weekly_scores_list_is_public_and_empty_initially(tables):
    resp = fa.weekly_scores(make_request("GET", "weekly-scores"))
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == []


def test_weekly_scores_item_rejects_malformed_week_key(tables):
    resp = fa.weekly_scores_item(make_request("GET", "weekly-scores/bogus", route_params={"week_key": "bogus"}))
    assert resp.status_code == 400


def test_weekly_scores_item_computes_on_demand_when_not_saved(tables):
    # 2026-W29はISOで2026-07-13(月)〜2026-07-19(日)。範囲内に80点の毎日スコアと
    # normal難易度のクローズ1件を仕込む。
    scores_table = tables.setdefault("Scores", fa._table_client("Scores"))
    scores_table.upsert_entity({
        "PartitionKey": "score", "RowKey": "2026-07-15", "Score": 80, "Note": "", "CreatedAt": "2026-07-15T00:00:00+00:00",
    })
    _close_thread(tables, "normal", "2026-07-15T03:00:00+00:00")

    resp = fa.weekly_scores_item(
        make_request("GET", "weekly-scores/2026-W29", route_params={"week_key": "2026-W29"})
    )
    assert resp.status_code == 200
    body = json.loads(resp.get_body())
    assert body["weekStart"] == "2026-07-13"
    assert body["dailyScoreSum"] == 80
    assert body["closeCount"] == 1
    assert body["closeValue"] == 5
    assert body["weekScore"] == 85
    assert body["calculatedAt"] is None  # 未保存はその場計算のみ


def test_weekly_scores_item_uses_rule_active_at_the_time_not_current(google_auth_ok, tables):
    # ba-159の核心: 2026-W29(2026-07-13〜19)でclose、その"後"に配点を変更しても、
    # recalculateしていないこの週のオンデマンド計算は当時のルール(normal=5)のまま
    # であるべき(2026-07-26発見の退行を再現→修正確認する回帰テスト)。
    _close_thread(tables, "normal", "2026-07-15T03:00:00+00:00")

    rule_resp = fa.scoring_rules(make_request(
        "POST", "scoring-rules",
        json_body={
            "credential": "token",
            "difficultyPoints": {"low": 1, "normal": 999, "high": 1},
            "effectiveFrom": "2026-08-01",
        },
    ))
    assert rule_resp.status_code == 201

    resp = fa.weekly_scores_item(
        make_request("GET", "weekly-scores/2026-W29", route_params={"week_key": "2026-W29"})
    )
    body = json.loads(resp.get_body())
    assert body["closeValue"] == 5, "新ルール(2026-08-01発効)は過去の週に遡って適用されてはいけない"
    assert body["weekScore"] == 5
    # 「当時の基準だとこう」= 今の最新ルールで見た場合の値は、新ルールを反映する
    assert body["closeValueAsOfLatest"] == 999
    assert body["weekScoreAsOfLatest"] == 999


def test_weekly_scores_item_defaults_missing_difficulty_to_normal(tables):
    # difficultyフィールド追加前の過去スレッド(difficultyキーなし)を想定。
    ba_table = tables.setdefault("BaLog", fa._table_client("BaLog"))
    thread_id = "legacy-thread"
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id, "By": "takashi", "Ref": "", "Type": "new",
        "Data": json.dumps({"title": "t"}), "CreatedAt": "2026-07-15T00:00:00+00:00", "Seq": 1,
    })
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id + "-close", "By": "takashi", "Ref": thread_id,
        "Type": "status", "Data": json.dumps({"status": "closed"}), "CreatedAt": "2026-07-15T03:00:00+00:00",
    })

    resp = fa.weekly_scores_item(
        make_request("GET", "weekly-scores/2026-W29", route_params={"week_key": "2026-W29"})
    )
    body = json.loads(resp.get_body())
    assert body["breakdownByDifficulty"] == {"low": 0, "normal": 1, "high": 0}
    assert body["closeValue"] == 5


def _add_point_event(tables_dict, axis, points_value, created_at_iso):
    """ba-165: PointEventsに1件足すテスト用ヘルパー。"""
    point_table = tables_dict.setdefault("PointEvents", fa._table_client("PointEvents"))
    point_table.upsert_entity({
        "PartitionKey": "point", "RowKey": f"pe-{axis}-{created_at_iso}",
        "Axis": axis, "Points": points_value, "Note": "", "CreatedAt": created_at_iso,
    })


def test_weekly_scores_item_includes_point_event_sum(tables):
    # 2026-W29範囲内(2026-07-13〜19)にPointEventsを2件仕込み、weekScoreに乗ることを確認する。
    _add_point_event(tables, "部屋片付け", 5, "2026-07-14T00:00:00+00:00")
    _add_point_event(tables, "新規市", 3, "2026-07-16T00:00:00+00:00")

    resp = fa.weekly_scores_item(
        make_request("GET", "weekly-scores/2026-W29", route_params={"week_key": "2026-W29"})
    )
    body = json.loads(resp.get_body())
    assert body["pointEventSum"] == 8
    assert body["weekScore"] == 8  # dailyScoreSum/closeValueは0のみ、pointEventSum分だけ乗る


def test_weekly_scores_recalculate_requires_auth(tables):
    resp = fa.weekly_scores_recalculate(make_request("POST", "weekly-scores/recalculate", json_body={"weekKey": "2026-W29"}))
    assert resp.status_code == 401


def test_weekly_scores_recalculate_persists_and_shows_in_list(google_auth_ok, tables):
    _close_thread(tables, "high", "2026-07-15T03:00:00+00:00")

    resp = fa.weekly_scores_recalculate(
        make_request("POST", "weekly-scores/recalculate", json_body={"credential": "token", "weekKey": "2026-W29"})
    )
    assert resp.status_code == 201
    body = json.loads(resp.get_body())
    assert body["closeValue"] == 10
    assert body["calculatedAt"] is not None

    list_resp = fa.weekly_scores(make_request("GET", "weekly-scores"))
    items = json.loads(list_resp.get_body())
    assert len(items) == 1
    assert items[0]["weekKey"] == "2026-W29"

    # 保存済みの週はGET detailがキャッシュ(保存値)を返す(calculatedAtが埋まっている)。
    item_resp = fa.weekly_scores_item(
        make_request("GET", "weekly-scores/2026-W29", route_params={"week_key": "2026-W29"})
    )
    assert json.loads(item_resp.get_body())["calculatedAt"] is not None


# ---- last-updated (ba-69: last-updated.js用のGitHub APIプロキシ) -------

class FakeGithubCommitsResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


@pytest.fixture(autouse=False)
def _clear_last_updated_cache():
    fa._last_updated_cache.clear()
    yield
    fa._last_updated_cache.clear()


def test_last_updated_rejects_missing_path(_clear_last_updated_cache):
    resp = fa.last_updated(make_request("GET", "last-updated"))
    assert resp.status_code == 400


def test_last_updated_rejects_suspicious_path(_clear_last_updated_cache):
    resp = fa.last_updated(make_request("GET", "last-updated", params={"path": "../../etc/passwd"}))
    assert resp.status_code == 400


def test_last_updated_returns_commit_date(monkeypatch, _clear_last_updated_cache):
    def _get(url, params=None, headers=None, timeout=None):
        assert "src/k1" == params["path"]
        return FakeGithubCommitsResponse(200, [{"commit": {"committer": {"date": "2026-07-23T11:22:57Z"}}}])
    monkeypatch.setattr(fa.requests, "get", _get)

    resp = fa.last_updated(make_request("GET", "last-updated", params={"path": "src/k1"}))
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == {"date": "2026-07-23T11:22:57Z"}


def test_last_updated_sends_auth_header_when_token_configured(monkeypatch, _clear_last_updated_cache):
    monkeypatch.setattr(fa, "GITHUB_TOKEN", "test-pat")
    seen = {}

    def _get(url, params=None, headers=None, timeout=None):
        seen["headers"] = headers
        return FakeGithubCommitsResponse(200, [{"commit": {"committer": {"date": "2026-07-23T11:22:57Z"}}}])
    monkeypatch.setattr(fa.requests, "get", _get)

    fa.last_updated(make_request("GET", "last-updated", params={"path": "src/k1"}))
    assert seen["headers"]["Authorization"] == "Bearer test-pat"


def test_last_updated_omits_auth_header_when_token_not_configured(monkeypatch, _clear_last_updated_cache):
    monkeypatch.setattr(fa, "GITHUB_TOKEN", "")
    seen = {}

    def _get(url, params=None, headers=None, timeout=None):
        seen["headers"] = headers
        return FakeGithubCommitsResponse(200, [{"commit": {"committer": {"date": "2026-07-23T11:22:57Z"}}}])
    monkeypatch.setattr(fa.requests, "get", _get)

    fa.last_updated(make_request("GET", "last-updated", params={"path": "src/k1"}))
    assert "Authorization" not in seen["headers"]


def test_last_updated_returns_null_date_when_no_commits(monkeypatch, _clear_last_updated_cache):
    monkeypatch.setattr(fa.requests, "get", lambda *a, **k: FakeGithubCommitsResponse(200, []))
    resp = fa.last_updated(make_request("GET", "last-updated", params={"path": "src/unknown"}))
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == {"date": None}


def test_last_updated_fails_open_on_github_error(monkeypatch, _clear_last_updated_cache):
    monkeypatch.setattr(fa.requests, "get", lambda *a, **k: FakeGithubCommitsResponse(403, {"message": "rate limited"}))
    resp = fa.last_updated(make_request("GET", "last-updated", params={"path": "src/k1"}))
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == {"date": None}


def test_last_updated_fails_open_on_network_error(monkeypatch, _clear_last_updated_cache):
    def _get(*a, **k):
        raise requests.exceptions.ConnectionError("simulated network failure")
    monkeypatch.setattr(fa.requests, "get", _get)
    resp = fa.last_updated(make_request("GET", "last-updated", params={"path": "src/k1"}))
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == {"date": None}


def test_last_updated_uses_cache_on_second_call(monkeypatch, _clear_last_updated_cache):
    calls = {"n": 0}

    def _get(url, params=None, headers=None, timeout=None):
        calls["n"] += 1
        return FakeGithubCommitsResponse(200, [{"commit": {"committer": {"date": "2026-07-23T11:22:57Z"}}}])
    monkeypatch.setattr(fa.requests, "get", _get)

    fa.last_updated(make_request("GET", "last-updated", params={"path": "src/k1"}))
    fa.last_updated(make_request("GET", "last-updated", params={"path": "src/k1"}))
    assert calls["n"] == 1
