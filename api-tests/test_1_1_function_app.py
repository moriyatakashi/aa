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


# ---- visits: ba-165②(初登録の自動加点、県>市>町) ------------------------------

def test_visits_first_pref_awards_high_point_event(google_auth_ok, tables):
    req = make_request("POST", "visits", json_body={
        "credential": "token", "place": "梅田", "pref": "大阪府", "city": "大阪市",
    })
    resp = fa.visits(req)
    body = json.loads(resp.get_body())
    assert body["autoPointGranularity"] == "pref"

    points = json.loads(fa.points(make_request("GET", "points")).get_body())
    assert len(points) == 1
    assert points[0]["points"] == 10  # high
    assert points[0]["catalogId"] == "visit_new"


def test_visits_repeat_pref_new_city_awards_normal_point_event(google_auth_ok, tables):
    fa.visits(make_request("POST", "visits", json_body={
        "credential": "token", "place": "梅田", "pref": "大阪府", "city": "大阪市",
    }))
    resp = fa.visits(make_request("POST", "visits", json_body={
        "credential": "token", "place": "東大阪", "pref": "大阪府", "city": "東大阪市",
    }))
    body = json.loads(resp.get_body())
    assert body["autoPointGranularity"] == "city"  # 県は既訪問なので市判定に落ちる

    points = json.loads(fa.points(make_request("GET", "points")).get_body())
    assert len(points) == 2
    assert points[1]["points"] == 5  # normal


def test_visits_repeat_pref_and_city_awards_low_point_event_for_new_town(google_auth_ok, tables):
    fa.visits(make_request("POST", "visits", json_body={
        "credential": "token", "place": "梅田", "pref": "大阪府", "city": "大阪市", "town": "梅田",
    }))
    resp = fa.visits(make_request("POST", "visits", json_body={
        "credential": "token", "place": "難波", "pref": "大阪府", "city": "大阪市", "town": "難波",
    }))
    body = json.loads(resp.get_body())
    assert body["autoPointGranularity"] == "town"

    points = json.loads(fa.points(make_request("GET", "points")).get_body())
    assert points[1]["points"] == 2  # low


def test_visits_fully_repeat_location_awards_no_point_event(google_auth_ok, tables):
    kwargs = {"credential": "token", "place": "梅田", "pref": "大阪府", "city": "大阪市", "town": "梅田"}
    fa.visits(make_request("POST", "visits", json_body=kwargs))
    fa.visits(make_request("POST", "visits", json_body=dict(kwargs, place="梅田(2回目)")))

    points = json.loads(fa.points(make_request("GET", "points")).get_body())
    assert len(points) == 1  # 1回目の分だけ


def test_visits_without_pref_city_town_awards_no_point_event(google_auth_ok, tables):
    resp = fa.visits(make_request("POST", "visits", json_body={"credential": "token", "place": "どこか"}))
    body = json.loads(resp.get_body())
    assert body["autoPointGranularity"] == ""

    points = json.loads(fa.points(make_request("GET", "points")).get_body())
    assert points == []


# ---- score-events (ba-165①: 加点軸の固定カタログ) ----------------------------

def test_score_events_get_returns_catalog():
    req = make_request("GET", "score-events")
    resp = fa.score_events(req)
    assert resp.status_code == 200
    body = json.loads(resp.get_body())
    ids = [item["id"] for item in body["catalog"]]
    assert "tidy_room" in ids
    assert "visit_new" not in ids  # 自動加点分は手動カタログには含めない
    automated_ids = [item["id"] for item in body["automated"]]
    assert set(automated_ids) == {"visit_new", "plan_done", "daily_streak"}
    assert body["difficultyPoints"] == {"low": 2, "normal": 5, "high": 10}


# ---- points (ba-165①: 加点軸の固定選択肢化) ----------------------------------

def test_points_get_is_public_no_auth(tables):
    req = make_request("GET", "points")
    resp = fa.points(req)
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == []


def test_points_list_returns_saved_entries(tables, google_auth_ok):
    post_req = make_request("POST", "points", json_body={"credential": "token", "axis": "tidy_room", "points": 2})
    fa.points(post_req)

    list_req = make_request("GET", "points")
    resp = fa.points(list_req)
    assert resp.status_code == 200
    items = json.loads(resp.get_body())
    assert len(items) == 1
    assert items[0]["axis"] == "部屋の片付け(衣装ケース等)"  # カタログの正規ラベルで保存される
    assert items[0]["points"] == 2
    assert items[0]["period"] == "week"
    assert items[0]["catalogId"] == "tidy_room"


def test_points_post_requires_auth(tables):
    req = make_request("POST", "points", json_body={"axis": "tidy_room", "points": 2})
    resp = fa.points(req)
    assert resp.status_code == 401


def test_points_post_requires_axis(google_auth_ok, tables):
    req = make_request("POST", "points", json_body={"credential": "token", "axis": "  ", "points": 5})
    resp = fa.points(req)
    assert resp.status_code == 400


def test_points_post_rejects_unknown_axis(google_auth_ok, tables):
    # カタログにもotherにも無い自由文字列はもう受け付けない(表記ゆれ防止が①の目的のため)
    req = make_request("POST", "points", json_body={"credential": "token", "axis": "運動streak", "points": 5})
    resp = fa.points(req)
    assert resp.status_code == 400


def test_points_post_rejects_non_integer_points(google_auth_ok, tables):
    req = make_request("POST", "points", json_body={"credential": "token", "axis": "exercise", "points": "たくさん"})
    resp = fa.points(req)
    assert resp.status_code == 400


def test_points_post_creates_entity_with_catalog_axis(google_auth_ok, tables):
    req = make_request("POST", "points", json_body={"credential": "token", "axis": "gadget_use", "points": 3, "note": "ラズパイ"})
    resp = fa.points(req)
    assert resp.status_code == 201
    body = json.loads(resp.get_body())
    assert body["axis"] == "ガジェット活用(ラズパイ/クラコン等)"
    assert body["points"] == 3
    assert body["note"] == "ラズパイ"
    assert body["catalogId"] == "gadget_use"


def test_points_post_month_period_catalog_axis(google_auth_ok, tables):
    # 生産/予測系はperiod="month"で記録され、月次得点(ba-165③)側の集計対象になる
    req = make_request("POST", "points", json_body={"credential": "token", "axis": "earn_money", "points": 10})
    resp = fa.points(req)
    body = json.loads(resp.get_body())
    assert body["period"] == "month"


def test_points_post_other_requires_axis_label(google_auth_ok, tables):
    req = make_request("POST", "points", json_body={"credential": "token", "axis": "other", "points": 3})
    resp = fa.points(req)
    assert resp.status_code == 400


def test_points_post_other_creates_entity_with_freeform_label(google_auth_ok, tables):
    req = make_request("POST", "points", json_body={
        "credential": "token", "axis": "other", "axisLabel": "新規市", "points": 3, "note": "神戸",
    })
    resp = fa.points(req)
    assert resp.status_code == 201
    body = json.loads(resp.get_body())
    assert body["axis"] == "新規市"
    assert body["points"] == 3
    assert body["catalogId"] == "other"


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


# ---- gist(ba-175: 確定仕様スレッドの「今の結論」一言) ------------------------

def test_ba_post_human_lane_can_write_gist(google_auth_ok, tables):
    root = json.loads(fa.ba_log(make_request(
        "POST", "ba", json_body={"credential": "token", "type": "new", "title": "t", "body": "b"},
    )).get_body())
    req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "gist", "ref": root["id"], "text": "結論はこう"},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 201
    body = json.loads(resp.get_body())
    assert body["by"] == "takashi"
    assert body["text"] == "結論はこう"


def test_ba_post_claude_pc_lane_can_write_gist(monkeypatch, tables):
    monkeypatch.setenv("BA_CLAUDE_KEY_PC", "pc-secret")
    root = json.loads(fa.ba_log(make_request(
        "POST", "ba",
        json_body={"claude_key": "pc-secret", "type": "new", "title": "t", "body": "b"},
    )).get_body())
    req = make_request(
        "POST", "ba",
        json_body={"claude_key": "pc-secret", "type": "gist", "ref": root["id"], "text": "結論はこう"},
    )
    resp = fa.ba_log(req)
    assert resp.status_code == 201
    assert json.loads(resp.get_body())["by"] == "claude-pc"


def test_ba_gist_rejects_missing_text(google_auth_ok, tables):
    root = json.loads(fa.ba_log(make_request(
        "POST", "ba", json_body={"credential": "token", "type": "new", "title": "t", "body": "b"},
    )).get_body())
    req = make_request("POST", "ba", json_body={"credential": "token", "type": "gist", "ref": root["id"]})
    assert fa.ba_log(req).status_code == 400


def test_ba_gist_rejects_text_over_max_length(google_auth_ok, tables):
    root = json.loads(fa.ba_log(make_request(
        "POST", "ba", json_body={"credential": "token", "type": "new", "title": "t", "body": "b"},
    )).get_body())
    req = make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "gist", "ref": root["id"], "text": "あ" * 201},
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


# ---- open/minimal GETフィルタ(ba-174: 全件取得コスト削減) -------------------

def test_ba_get_open_filter_excludes_voided_thread(google_auth_ok, tables):
    root = json.loads(fa.ba_log(make_request(
        "POST", "ba", json_body={"credential": "token", "type": "new", "title": "t", "body": "b"},
    )).get_body())
    fa.ba_log(make_request(
        "POST", "ba", json_body={"credential": "token", "type": "void", "ref": root["id"]},
    ))

    items = json.loads(fa.ba_log(make_request("GET", "ba", params={"open": "1"})).get_body())
    assert items == []


def test_ba_get_open_filter_excludes_closed_status_thread(google_auth_ok, tables):
    root = json.loads(fa.ba_log(make_request(
        "POST", "ba", json_body={"credential": "token", "type": "new", "title": "t", "body": "b"},
    )).get_body())
    fa.ba_log(make_request("POST", "ba", json_body={
        "credential": "token", "type": "status", "status": "closed", "ref": root["id"],
    }))

    items = json.loads(fa.ba_log(make_request("GET", "ba", params={"open": "1"})).get_body())
    assert items == []


def test_ba_get_open_filter_keeps_open_thread_and_its_notes(google_auth_ok, tables):
    root = json.loads(fa.ba_log(make_request(
        "POST", "ba", json_body={"credential": "token", "type": "new", "title": "t", "body": "b"},
    )).get_body())
    fa.ba_log(make_request("POST", "ba", json_body={
        "credential": "token", "type": "note", "ref": root["id"], "body": "n",
    }))

    items = json.loads(fa.ba_log(make_request("GET", "ba", params={"open": "1"})).get_body())
    assert {e["type"] for e in items} == {"new", "note"}


def test_ba_get_minimal_strips_body(google_auth_ok, tables):
    fa.ba_log(make_request(
        "POST", "ba",
        json_body={"credential": "token", "type": "new", "title": "t", "body": "long body text"},
    ))

    items = json.loads(fa.ba_log(make_request("GET", "ba", params={"minimal": "1"})).get_body())
    assert len(items) == 1
    assert "body" not in items[0]
    assert items[0]["title"] == "t"


def test_ba_get_open_and_minimal_combine(google_auth_ok, tables):
    root = json.loads(fa.ba_log(make_request(
        "POST", "ba", json_body={"credential": "token", "type": "new", "title": "t", "body": "b"},
    )).get_body())
    other = json.loads(fa.ba_log(make_request(
        "POST", "ba", json_body={"credential": "token", "type": "new", "title": "t2", "body": "b2"},
    )).get_body())
    fa.ba_log(make_request("POST", "ba", json_body={
        "credential": "token", "type": "status", "status": "closed", "ref": other["id"],
    }))

    items = json.loads(fa.ba_log(make_request(
        "GET", "ba", params={"open": "1", "minimal": "1"},
    )).get_body())
    assert len(items) == 1
    assert items[0]["id"] == root["id"]
    assert "body" not in items[0]


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


def test_weekly_scores_dedupes_duplicate_close_without_reopen(tables):
    # ba-109の実インシデント再現: 同じスレッドが間にopenを挟まず誤って2回closeされても
    # 1回分しか数えない(2026-07-26発見、修正前は+5点分過大計上していた)。
    thread_id = "thread-dup-close"
    ba_table = fa._table_client("BaLog")
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id, "By": "takashi", "Ref": "", "Type": "new",
        "Data": json.dumps({"title": "t", "difficulty": "normal"}), "CreatedAt": "2026-07-15T03:00:00+00:00", "Seq": 1,
    })
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id + "-close1", "By": "claude-pc", "Ref": thread_id,
        "Type": "status", "Data": json.dumps({"status": "closed"}), "CreatedAt": "2026-07-15T03:00:00+00:00",
    })
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id + "-close2", "By": "claude-pc", "Ref": thread_id,
        "Type": "status", "Data": json.dumps({"status": "closed"}), "CreatedAt": "2026-07-15T03:00:36+00:00",
    })

    resp = fa.weekly_scores_item(
        make_request("GET", "weekly-scores/2026-W29", route_params={"week_key": "2026-W29"})
    )
    body = json.loads(resp.get_body())
    assert body["closeCount"] == 1
    assert body["closeValue"] == 5


def test_weekly_scores_counts_close_again_after_reopen(tables):
    # 間にopen(再オープン)を挟んだ2回目のcloseは、重複ではなく正当な追加イベントとして数える。
    thread_id = "thread-reopen-close"
    ba_table = fa._table_client("BaLog")
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id, "By": "takashi", "Ref": "", "Type": "new",
        "Data": json.dumps({"title": "t", "difficulty": "normal"}), "CreatedAt": "2026-07-15T03:00:00+00:00", "Seq": 1,
    })
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id + "-close1", "By": "takashi", "Ref": thread_id,
        "Type": "status", "Data": json.dumps({"status": "closed"}), "CreatedAt": "2026-07-15T03:00:00+00:00",
    })
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id + "-reopen", "By": "takashi", "Ref": thread_id,
        "Type": "status", "Data": json.dumps({"status": "open"}), "CreatedAt": "2026-07-16T03:00:00+00:00",
    })
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id + "-close2", "By": "takashi", "Ref": thread_id,
        "Type": "status", "Data": json.dumps({"status": "closed"}), "CreatedAt": "2026-07-17T03:00:00+00:00",
    })

    resp = fa.weekly_scores_item(
        make_request("GET", "weekly-scores/2026-W29", route_params={"week_key": "2026-W29"})
    )
    body = json.loads(resp.get_body())
    assert body["closeCount"] == 2
    assert body["closeValue"] == 10


def test_weekly_scores_excludes_voided_thread(tables):
    # voidされたスレッドのcloseは週次得点に一切数えない(ba-109で見つかったcalc側の未対応)。
    thread_id = "thread-voided"
    ba_table = fa._table_client("BaLog")
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id, "By": "takashi", "Ref": "", "Type": "new",
        "Data": json.dumps({"title": "t", "difficulty": "high"}), "CreatedAt": "2026-07-15T03:00:00+00:00", "Seq": 1,
    })
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id + "-close", "By": "takashi", "Ref": thread_id,
        "Type": "status", "Data": json.dumps({"status": "closed"}), "CreatedAt": "2026-07-15T03:00:00+00:00",
    })
    ba_table.upsert_entity({
        "PartitionKey": thread_id, "RowKey": thread_id + "-void", "By": "takashi", "Ref": thread_id,
        "Type": "void", "Data": json.dumps({"value": True}), "CreatedAt": "2026-07-15T04:00:00+00:00",
    })

    resp = fa.weekly_scores_item(
        make_request("GET", "weekly-scores/2026-W29", route_params={"week_key": "2026-W29"})
    )
    body = json.loads(resp.get_body())
    assert body["closeCount"] == 0
    assert body["closeValue"] == 0


# ---- monthly-scores (ba-165③: 生産/予測を週次得点と別集計) --------------------

def test_monthly_scores_list_is_public_and_empty_initially(tables):
    req = make_request("GET", "monthly-scores")
    resp = fa.monthly_scores(req)
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == []


def test_monthly_scores_item_rejects_malformed_month_key(tables):
    resp = fa.monthly_scores_item(make_request("GET", "monthly-scores/2026-13", route_params={"month_key": "2026-13"}))
    assert resp.status_code == 400


def test_monthly_scores_item_computes_on_demand_when_not_saved(tables):
    point_events_table = fa._table_client(fa.POINT_EVENTS_TABLE)
    point_events_table.upsert_entity({
        "PartitionKey": "point", "RowKey": "p1", "Axis": "お金を稼ぐ(出版/YouTube)", "Points": 10,
        "Period": "month", "CatalogId": "earn_money", "CreatedAt": "2026-07-15T03:00:00+00:00",
    })
    # week軸(period="week")は月次には含めない
    point_events_table.upsert_entity({
        "PartitionKey": "point", "RowKey": "p2", "Axis": "部屋の片付け(衣装ケース等)", "Points": 2,
        "Period": "week", "CatalogId": "tidy_room", "CreatedAt": "2026-07-15T03:00:00+00:00",
    })
    # 別の月のイベントは含めない
    point_events_table.upsert_entity({
        "PartitionKey": "point", "RowKey": "p3", "Axis": "知名度up", "Points": 10,
        "Period": "month", "CatalogId": "fame", "CreatedAt": "2026-08-01T03:00:00+00:00",
    })

    resp = fa.monthly_scores_item(make_request("GET", "monthly-scores/2026-07", route_params={"month_key": "2026-07"}))
    body = json.loads(resp.get_body())
    assert body["monthScore"] == 10
    assert body["breakdownByAxis"] == {"お金を稼ぐ(出版/YouTube)": 10}
    assert body["calculatedAt"] is None


def test_monthly_scores_recalculate_requires_auth(tables):
    resp = fa.monthly_scores_recalculate(make_request("POST", "monthly-scores/recalculate", json_body={"monthKey": "2026-07"}))
    assert resp.status_code == 401


def test_monthly_scores_recalculate_persists_and_shows_in_list(google_auth_ok, tables):
    point_events_table = fa._table_client(fa.POINT_EVENTS_TABLE)
    point_events_table.upsert_entity({
        "PartitionKey": "point", "RowKey": "p1", "Axis": "資産・体重をきっちり予測", "Points": 5,
        "Period": "month", "CatalogId": "predict_data", "CreatedAt": "2026-07-15T03:00:00+00:00",
    })

    resp = fa.monthly_scores_recalculate(make_request(
        "POST", "monthly-scores/recalculate", json_body={"credential": "token", "monthKey": "2026-07"}
    ))
    assert resp.status_code == 201

    list_resp = fa.monthly_scores(make_request("GET", "monthly-scores"))
    items = json.loads(list_resp.get_body())
    assert len(items) == 1
    assert items[0]["monthKey"] == "2026-07"
    assert items[0]["monthScore"] == 5
    assert items[0]["calculatedAt"]


# ---- streak-checks (ba-165④: 連続作業5日で自動加点、週1回まで) -----------------

def test_streak_checks_get_is_public_no_auth(tables):
    req = make_request("GET", "streak-checks")
    resp = fa.streak_checks(req)
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == []


def test_streak_checks_post_requires_auth(tables):
    resp = fa.streak_checks(make_request("POST", "streak-checks", json_body={"task": "散歩", "date": "2026-07-20"}))
    assert resp.status_code == 401


def test_streak_checks_post_requires_task(google_auth_ok, tables):
    resp = fa.streak_checks(make_request(
        "POST", "streak-checks", json_body={"credential": "token", "task": "  ", "date": "2026-07-20"}
    ))
    assert resp.status_code == 400


def test_streak_checks_below_five_days_does_not_award(google_auth_ok, tables):
    for day in ["2026-07-20", "2026-07-21", "2026-07-22"]:
        resp = fa.streak_checks(make_request(
            "POST", "streak-checks", json_body={"credential": "token", "task": "散歩", "date": day}
        ))
    body = json.loads(resp.get_body())
    assert body["streakLength"] == 3
    assert body["awarded"] is False
    assert json.loads(fa.points(make_request("GET", "points")).get_body()) == []


def test_streak_checks_five_consecutive_days_awards_high_point_event(google_auth_ok, tables):
    days = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"]  # 月〜金
    resp = None
    for day in days:
        resp = fa.streak_checks(make_request(
            "POST", "streak-checks", json_body={"credential": "token", "task": "散歩", "date": day}
        ))
    body = json.loads(resp.get_body())
    assert body["streakLength"] == 5
    assert body["awarded"] is True

    points = json.loads(fa.points(make_request("GET", "points")).get_body())
    assert len(points) == 1
    assert points[0]["points"] == 10
    assert points[0]["axis"] == "継続達成"
    assert points[0]["catalogId"] == "daily_streak"


def test_streak_checks_gap_resets_streak(google_auth_ok, tables):
    fa.streak_checks(make_request("POST", "streak-checks", json_body={"credential": "token", "task": "散歩", "date": "2026-07-20"}))
    fa.streak_checks(make_request("POST", "streak-checks", json_body={"credential": "token", "task": "散歩", "date": "2026-07-21"}))
    # 07-22を飛ばして07-23に申告 → 連続はリセットされ1から数え直し
    resp = fa.streak_checks(make_request("POST", "streak-checks", json_body={"credential": "token", "task": "散歩", "date": "2026-07-23"}))
    body = json.loads(resp.get_body())
    assert body["streakLength"] == 1


def test_streak_checks_only_awards_once_per_week(google_auth_ok, tables):
    days = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25", "2026-07-26"]  # 月〜日
    resp = None
    for day in days:
        resp = fa.streak_checks(make_request(
            "POST", "streak-checks", json_body={"credential": "token", "task": "散歩", "date": day}
        ))
    body = json.loads(resp.get_body())
    assert body["streakLength"] == 7
    assert body["awarded"] is False  # 5日目で既に付与済みなので7日目では付与しない

    points = json.loads(fa.points(make_request("GET", "points")).get_body())
    assert len(points) == 1


def test_streak_checks_resubmitting_same_day_is_idempotent(google_auth_ok, tables):
    fa.streak_checks(make_request("POST", "streak-checks", json_body={"credential": "token", "task": "散歩", "date": "2026-07-20"}))
    resp = fa.streak_checks(make_request("POST", "streak-checks", json_body={"credential": "token", "task": "散歩", "date": "2026-07-20"}))
    body = json.loads(resp.get_body())
    assert body["streakLength"] == 1

    checks = json.loads(fa.streak_checks(make_request("GET", "streak-checks")).get_body())
    assert len(checks) == 1


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


# ---- calendar-events (ba-160) ------------------------------------------------

class FakeGcalResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.exceptions.HTTPError(f"status={self.status_code}")

    def json(self):
        return self._payload


def test_calendar_events_requires_auth(tables):
    resp = fa.calendar_events(make_request("GET", "calendar-events"))
    assert resp.status_code == 401


def test_calendar_events_returns_503_when_not_configured(monkeypatch, tables):
    monkeypatch.setattr(fa, "_authorize_get", lambda req: None)
    monkeypatch.setattr(fa, "GCAL_OAUTH_CLIENT_ID", "")
    resp = fa.calendar_events(make_request("GET", "calendar-events"))
    assert resp.status_code == 503


def test_calendar_events_returns_simplified_items(monkeypatch, tables):
    monkeypatch.setattr(fa, "_authorize_get", lambda req: None)
    monkeypatch.setattr(fa, "GCAL_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setattr(fa, "GCAL_OAUTH_CLIENT_SECRET", "csecret")
    monkeypatch.setattr(fa, "GCAL_OAUTH_REFRESH_TOKEN", "rtoken")

    def _post(url, data=None, timeout=None):
        return FakeGcalResponse(200, {"access_token": "atoken"})

    def _get(url, headers=None, params=None, timeout=None):
        return FakeGcalResponse(200, {"items": [
            {
                "id": "e1", "summary": "会議",
                "start": {"dateTime": "2026-08-01T10:00:00+09:00"},
                "end": {"dateTime": "2026-08-01T11:00:00+09:00"},
                "location": "会議室A",
            },
        ]})

    monkeypatch.setattr(fa.requests, "post", _post)
    monkeypatch.setattr(fa.requests, "get", _get)

    resp = fa.calendar_events(make_request("GET", "calendar-events"))
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == [{
        "id": "e1", "summary": "会議",
        "start": "2026-08-01T10:00:00+09:00", "end": "2026-08-01T11:00:00+09:00",
        "location": "会議室A",
    }]


def test_calendar_events_returns_502_on_upstream_failure(monkeypatch, tables):
    monkeypatch.setattr(fa, "_authorize_get", lambda req: None)
    monkeypatch.setattr(fa, "GCAL_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setattr(fa, "GCAL_OAUTH_CLIENT_SECRET", "csecret")
    monkeypatch.setattr(fa, "GCAL_OAUTH_REFRESH_TOKEN", "rtoken")
    monkeypatch.setattr(fa.requests, "post", lambda *a, **k: FakeGcalResponse(200, {"access_token": "atoken"}))
    monkeypatch.setattr(fa.requests, "get", lambda *a, **k: FakeGcalResponse(500, {}))

    resp = fa.calendar_events(make_request("GET", "calendar-events"))
    assert resp.status_code == 502


# ---- declarations (ba-160: 宣言→達成で加点) -----------------------------------

def test_declarations_get_is_public_no_auth(tables):
    resp = fa.declarations(make_request("GET", "declarations"))
    assert resp.status_code == 200
    assert json.loads(resp.get_body()) == []


def test_declarations_post_requires_auth(tables):
    resp = fa.declarations(make_request(
        "POST", "declarations", json_body={"text": "部屋を片付ける", "targetWeek": "2026-W32"}
    ))
    assert resp.status_code == 401


def test_declarations_post_requires_text(google_auth_ok, tables):
    resp = fa.declarations(make_request(
        "POST", "declarations", json_body={"credential": "token", "text": "  ", "targetWeek": "2026-W32"}
    ))
    assert resp.status_code == 400


def test_declarations_post_rejects_malformed_target_week(google_auth_ok, tables):
    resp = fa.declarations(make_request(
        "POST", "declarations", json_body={"credential": "token", "text": "部屋を片付ける", "targetWeek": "bogus"}
    ))
    assert resp.status_code == 400


def test_declarations_post_creates_entity(google_auth_ok, tables):
    resp = fa.declarations(make_request(
        "POST", "declarations",
        json_body={"credential": "token", "text": "部屋を片付ける", "targetWeek": "2026-W32"},
    ))
    assert resp.status_code == 201
    body = json.loads(resp.get_body())
    assert body["text"] == "部屋を片付ける"
    assert body["targetWeek"] == "2026-W32"
    assert body["achieved"] is False


def test_declarations_achieve_requires_auth(google_auth_ok, tables):
    create_resp = fa.declarations(make_request(
        "POST", "declarations", json_body={"credential": "token", "text": "t", "targetWeek": "2026-W32"}
    ))
    decl_id = json.loads(create_resp.get_body())["id"]
    resp = fa.declarations_achieve(make_request(
        "POST", f"declarations/{decl_id}/achieve", route_params={"decl_id": decl_id}, json_body={}
    ))
    assert resp.status_code == 401


def test_declarations_achieve_awards_points_by_weeks_ahead(google_auth_ok, tables):
    # 2026-W29(2026-07-13作成) -> 対象2026-W31 = 2週先 -> ba-165決定の倍々式で10点。
    decl_table = tables.setdefault("Declarations", fa._table_client("Declarations"))
    decl_table.upsert_entity({
        "PartitionKey": "declaration", "RowKey": "decl-1", "Text": "難しい案件をやる",
        "TargetWeek": "2026-W31", "CreatedAt": "2026-07-13T03:00:00+00:00",
        "Achieved": False, "AchievedAt": "",
    })

    resp = fa.declarations_achieve(make_request(
        "POST", "declarations/decl-1/achieve", route_params={"decl_id": "decl-1"}, json_body={"credential": "token"}
    ))
    assert resp.status_code == 200
    body = json.loads(resp.get_body())
    assert body["achieved"] is True
    assert body["awardedPoints"] == 10

    points_items = json.loads(fa.points(make_request("GET", "points")).get_body())
    assert len(points_items) == 1
    assert points_items[0]["axis"] == "宣言達成"
    assert points_items[0]["points"] == 10


def test_declarations_achieve_is_idempotent(google_auth_ok, tables):
    decl_table = tables.setdefault("Declarations", fa._table_client("Declarations"))
    decl_table.upsert_entity({
        "PartitionKey": "declaration", "RowKey": "decl-2", "Text": "t",
        "TargetWeek": "2026-W30", "CreatedAt": "2026-07-13T03:00:00+00:00",
        "Achieved": False, "AchievedAt": "",
    })
    req_kwargs = dict(route_params={"decl_id": "decl-2"}, json_body={"credential": "token"})
    fa.declarations_achieve(make_request("POST", "declarations/decl-2/achieve", **req_kwargs))
    fa.declarations_achieve(make_request("POST", "declarations/decl-2/achieve", **req_kwargs))

    points_items = json.loads(fa.points(make_request("GET", "points")).get_body())
    assert len(points_items) == 1  # 2回叩いても加点は1回だけ


def test_declarations_achieve_not_found(google_auth_ok, tables):
    resp = fa.declarations_achieve(make_request(
        "POST", "declarations/nope/achieve", route_params={"decl_id": "nope"}, json_body={"credential": "token"}
    ))
    assert resp.status_code == 404
