import hashlib
import hmac
import json
import os
import re
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone

import azure.functions as func
import requests
from azure.core.exceptions import ResourceNotFoundError
from azure.data.tables import TableServiceClient

app = func.FunctionApp()

CONN_STR = os.environ["TABLE_CONNECTION_STRING"]
GOOGLE_CLIENT_ID = os.environ["GOOGLE_CLIENT_ID"]
ALLOWED_EMAIL = os.environ["ALLOWED_EMAIL"]
# 手動パスコード認証（Googleログインが使えない時の代替経路）。
# Azure Function Appの環境変数に設定した場合のみ有効になる。未設定なら
# この経路は使われない（デフォルトでは何も変わらない、安全側）。
RBA_MANUAL_PASSCODE = os.environ.get("RBA_MANUAL_PASSCODE", "")
# 永続セッション機能（ba-XX 永続認証移行）の署名鍵。未設定ならこの機能自体を
# 無効化する（session()は503を返し、_authorizeはsession:トークンを一切受け付けない）。
# 既存のGoogle IDトークン直検証フローには影響しない（デフォルトでは何も変わらない、安全側）。
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
# last-updated用(ba-69)。GitHub APIの認証に使うPAT(read-onlyで十分)。未設定なら
# 未認証(60req/時/IP)のままGitHub APIを叩く(デフォルトでは何も変わらない、安全側)。
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")


_table_service = None


def _table_client(table_name):
    # ba-30(3): 毎リクエストでTableServiceClientを新規生成していたのをやめ、
    # ウォームインスタンス間で使い回す(モジュールレベルで1度だけ生成)。
    global _table_service
    if _table_service is None:
        _table_service = TableServiceClient.from_connection_string(CONN_STR)
    return _table_service.get_table_client(table_name)


def _get_body(req):
    try:
        return req.get_json()
    except ValueError:
        return {}


def _verify_google_credential(credential):
    """GoogleのIDトークンをtokeninfoエンドポイントに問い合わせて検証する。
    ALLOWED_EMAIL本人のトークンであればNone、そうでなければ401のHttpResponseを返す。"""
    try:
        resp = requests.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"id_token": credential},
            timeout=5,
        )
    except Exception:
        return func.HttpResponse("invalid credential", status_code=401)
    if resp.status_code != 200:
        return func.HttpResponse("invalid credential", status_code=401)

    payload = resp.json()
    if payload.get("aud") != GOOGLE_CLIENT_ID:
        return func.HttpResponse("invalid credential", status_code=401)
    # 「トークンは有効だが本人ではない」ことを403で区別すると、有効なGoogle
    # アカウントを持つ第三者が「自分は認証済みだが権限がない」ことを判別できて
    # しまう。本人以外は常に401にして、無効トークンと見分けがつかないようにする。
    if payload.get("email_verified") != "true" or payload.get("email", "").lower() != ALLOWED_EMAIL.lower():
        return func.HttpResponse("invalid credential", status_code=401)
    return None


SESSIONS_TABLE = "Sessions"
SESSIONS_PARTITION = "session"


def _sign_session_id(session_id):
    return hmac.new(SESSION_SECRET.encode(), session_id.encode(), hashlib.sha256).hexdigest()


def _make_session_token(session_id):
    return f"session:{session_id}.{_sign_session_id(session_id)}"


def _parse_session_token(credential):
    """"session:<id>.<署名>"形式を検証し、正当ならidを、そうでなければNoneを返す。
    ここではSESSION_SECRETによる署名検証のみ行い、テーブル上の失効確認は呼び出し側で行う。"""
    if not credential.startswith("session:"):
        return None
    rest = credential[len("session:"):]
    if "." not in rest:
        return None
    session_id, _, sig = rest.rpartition(".")
    if not session_id or not sig:
        return None
    if not hmac.compare_digest(_sign_session_id(session_id), sig):
        return None
    return session_id


def _authorize_session(credential):
    """署名済みの永続セッショントークンを検証する。Sessionsテーブルに該当行が
    残っていれば有効(ログアウト等で行を削除すると、無期限トークンでも即座に失効する)。"""
    session_id = _parse_session_token(credential)
    if not session_id:
        return func.HttpResponse("invalid credential", status_code=401)
    table = _table_client(SESSIONS_TABLE)
    try:
        table.get_entity(partition_key=SESSIONS_PARTITION, row_key=session_id)
    except Exception:
        return func.HttpResponse("invalid credential", status_code=401)
    return None


def _authorize(body):
    """ab個人データの書き込みをALLOWED_EMAIL本人のGoogleログインのみに制限する。
    問題なければNone、問題があればそのまま返すHttpResponseを返す。
    RBA_MANUAL_PASSCODEが設定されている場合のみ、"manual:<パスコード>"形式の
    credentialでも通す（Googleログインが壊れた時の代替経路）。
    SESSION_SECRETが設定されている場合のみ、"session:<id>.<署名>"形式の
    永続セッショントークン（POST /api/sessionで発行）でも通す。"""
    credential = (body or {}).get("credential", "")
    if not credential:
        return func.HttpResponse("credential is required", status_code=401)

    if RBA_MANUAL_PASSCODE and credential == f"manual:{RBA_MANUAL_PASSCODE}":
        return None

    if SESSION_SECRET and credential.startswith("session:"):
        return _authorize_session(credential)

    return _verify_google_credential(credential)


def _authorize_get(req):
    """GETリクエスト用の_authorize。ba-160のcalendar-events/declarations achieveのように
    「閲覧にも認証が要る」エンドポイント向けに、クエリ文字列のcredentialを見る
    (GETはボディを送るのが一般的でないため)。"""
    return _authorize({"credential": req.params.get("credential", "")})


VISITS_TABLE = "Visits"
# ba-165②(2026-07-29確定、Takashi判断): Visits初登録の自動検知→自動加点。
# 粒度は県>市>町の順で粗い方を優先し(同時に複数が初登場でも二重加点しない)、
# 県=high/市=normal/町=low(「経年で易化」=同じ都道府県内の別の市を後から訪れても
# 県はもう新規でないのでnormal以下に自然に下がる、という設計でありスコアの割引処理は別途行わない)。
# pref/city/townはn2側のGPS逆ジオコーディング結果を送ってもらう想定の追加フィールドで、
# 過去のVisitsエントリはこれらを持たないため、既存訪問地との突合は「Pref/City/Townが
# 一致した場合のみ既訪問扱い」になる(過去データへの遡及はしない、difficulty導入時と同じ方針)。
VISIT_GRANULARITY_DIFFICULTY = {"pref": "high", "city": "normal", "town": "low"}


def _visit_dict(e):
    return {
        "id": e["RowKey"],
        "place": e.get("Place", ""),
        "date": e.get("Date", ""),
        "time": e.get("Time", ""),
        "memo": e.get("Memo", ""),
        "lat": e.get("Lat"),
        "lng": e.get("Lng"),
        "pref": e.get("Pref", ""),
        "city": e.get("City", ""),
        "town": e.get("Town", ""),
        "autoPointGranularity": e.get("AutoPointGranularity", ""),
        "createdAt": e.get("CreatedAt", ""),
    }


def _is_new_visit_value(table, field_name, value):
    if not value:
        return False
    return all(e.get(field_name) != value for e in table.list_entities())


@app.function_name(name="visits")
@app.route(route="visits", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def visits(req: func.HttpRequest) -> func.HttpResponse:
    table = _table_client(VISITS_TABLE)

    if req.method == "GET":
        # ba-35残課題(2): 閲覧はログイン不要にする(2026-07-20)。書き込み(POST)は引き続き認証必須。
        items = [_visit_dict(e) for e in table.list_entities()]
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    place = (body.get("place") or "").strip()
    if not place:
        return func.HttpResponse("place is required", status_code=400)

    pref = (body.get("pref") or "").strip()
    city = (body.get("city") or "").strip()
    town = (body.get("town") or "").strip()

    # 粗い粒度から先に判定する(同じ訪問で県も市も初登場なら県=highだけを採用しhigh+normalの
    # 二重加点にしない)。
    if pref and _is_new_visit_value(table, "Pref", pref):
        granularity = "pref"
    elif city and _is_new_visit_value(table, "City", city):
        granularity = "city"
    elif town and _is_new_visit_value(table, "Town", town):
        granularity = "town"
    else:
        granularity = None

    entity = {
        "PartitionKey": "visit",
        "RowKey": str(uuid.uuid4()),
        "Place": place,
        "Date": body.get("date", ""),
        "Time": body.get("time", ""),
        "Memo": body.get("memo", ""),
        "Pref": pref,
        "City": city,
        "Town": town,
        "AutoPointGranularity": granularity or "",
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    }
    if body.get("lat") is not None:
        entity["Lat"] = float(body["lat"])
    if body.get("lng") is not None:
        entity["Lng"] = float(body["lng"])
    table.upsert_entity(entity)

    if granularity:
        difficulty = VISIT_GRANULARITY_DIFFICULTY[granularity]
        label = {"pref": pref, "city": city, "town": town}[granularity]
        _create_point_event(
            "初訪問", BA_DIFFICULTY_POINTS[difficulty], f"{label}({granularity})",
            period="week", catalog_id="visit_new",
        )

    return func.HttpResponse(json.dumps(_visit_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json")


POINT_EVENTS_TABLE = "PointEvents"


def _point_event_dict(e):
    return {
        "id": e["RowKey"],
        "axis": e.get("Axis", ""),
        "points": e.get("Points", 0),
        "note": e.get("Note", ""),
        # ba-165(2026-07-29): 週次/月次のどちらの得点に合算するかの区分。旧データ(Period未設定)は
        # 移行当時すべて週次のみが存在したためweek扱いにフォールバックする。
        "period": e.get("Period", "week"),
        "catalogId": e.get("CatalogId", ""),
        "createdAt": e.get("CreatedAt", ""),
    }


def _create_point_event(axis, points_value, note="", period="week", catalog_id=None, created_at=None):
    """PointEventsへの追記だけを行う内部ヘルパー。POST /api/pointsの本体、
    ba-160のdeclarations achieve(宣言達成時の自動加点)、ba-165②のVisits初登録自動加点、
    ba-165④のstreak-checks自動加点の全てから呼ばれる。
    created_atは通常省略(その場の"今")でよいが、streak-checksのように過去日付を自己申告
    できる場合は、その申告日に紐づけないと週次得点・週1回までの判定が実際の投稿日時と
    ずれるため、呼び出し側から明示的に渡す。"""
    entity = {
        "PartitionKey": "point",
        "RowKey": str(uuid.uuid4()),
        "Axis": axis,
        "Points": points_value,
        "Note": note,
        "Period": period,
        "CatalogId": catalog_id or "",
        "CreatedAt": (created_at or datetime.now(timezone.utc)).isoformat(),
    }
    _table_client(POINT_EVENTS_TABLE).upsert_entity(entity)
    return entity


# ba-165①(2026-07-29確定、Takashi判断): 加点軸を自由入力から固定選択肢へ変更する。
# 以前は「軸(自由文字列)+点数」を無条件に記録していたため、同じ意味の軸が表記ゆれ
# (例:「運動」と「運動streak」)で分裂し、k2の内訳集計が安定しなかった。
# ここではba-53「加点カタログ確定版」(2026-07-26、すま)のJSON叩き台をそのまま採用する。
# 12種のうちvisit_new(② Visits初登録で自動判定)とplan_done(既存のdeclarations achieveで
# 既に自動化済み)は、二重加点を避けるため手動選択肢からは除外し、AUTOMATED_SCORE_EVENTSに
# 分離して「自動で付く軸」として案内する。periodは週次得点(week)と月次得点(month、ba-165③)の
# どちらに合算するかを示す。
SCORE_EVENT_CATALOG = [
    {"id": "tidy_room", "label": "部屋の片付け(衣装ケース等)", "cat": "生活", "period": "week", "difficulty": "low"},
    {"id": "trash_planned", "label": "計画的なゴミ出し", "cat": "生活", "period": "week", "difficulty": "low"},
    {"id": "brave_purchase", "label": "勇気ある買い物(食洗機/シュレッダー等)", "cat": "買物", "period": "week", "difficulty": "normal"},
    {"id": "gadget_use", "label": "ガジェット活用(ラズパイ/クラコン等)", "cat": "買物", "period": "week", "difficulty": "normal"},
    {"id": "local_food", "label": "名物を食べる", "cat": "移動", "period": "week", "difficulty": "low"},
    {"id": "exercise", "label": "運動(単発)", "cat": "運動", "period": "week", "difficulty": "low"},
    {"id": "earn_money", "label": "お金を稼ぐ(出版/YouTube)", "cat": "生産", "period": "month", "difficulty": "high"},
    {"id": "fame", "label": "知名度up", "cat": "生産", "period": "month", "difficulty": "high"},
    {"id": "hard_idea", "label": "難しい案件を思いつく", "cat": "予定", "period": "week", "difficulty": "high"},
    {"id": "predict_data", "label": "資産・体重をきっちり予測", "cat": "予測", "period": "month", "difficulty": "normal"},
]
SCORE_EVENT_CATALOG_BY_ID = {e["id"]: e for e in SCORE_EVENT_CATALOG}
AUTOMATED_SCORE_EVENTS = [
    {"id": "visit_new", "label": "初訪問", "cat": "移動", "period": "week",
     "note": "POST /api/visitsのpref/city/townで自動判定(県=high/市=normal/町=low、経年で易化)"},
    {"id": "plan_done", "label": "宣言達成", "cat": "予定", "period": "week",
     "note": "POST /api/declarations/{id}/achieveで自動加点(倍々式)"},
    {"id": "daily_streak", "label": "継続達成", "cat": "継続", "period": "week",
     "note": "POST /api/streak-checksへの5日連続自己申告で自動加点(週1回まで)"},
]


@app.function_name(name="score-events")
@app.route(route="score-events", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def score_events(req: func.HttpRequest) -> func.HttpResponse:
    # ba-165①: n1のプルダウン等が参照する、加点軸の固定カタログ(手動選択分+自動加点の案内)。
    return func.HttpResponse(json.dumps({
        "catalog": SCORE_EVENT_CATALOG,
        "automated": AUTOMATED_SCORE_EVENTS,
        "difficultyPoints": BA_DIFFICULTY_POINTS,
    }, ensure_ascii=False), mimetype="application/json")


@app.function_name(name="points")
@app.route(route="points", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def points(req: func.HttpRequest) -> func.HttpResponse:
    # ba-165①(2026-07-29): axisはSCORE_EVENT_CATALOGのidか、カタログにない事象を拾うための
    # "other"のどちらかのみ受け付ける(以前の完全自由入力から変更)。pointsは引き続き自己申告
    # (difficultyから機械的に決め打ちしない、ころころ変えてよい前提の運用のため)。
    table = _table_client(POINT_EVENTS_TABLE)

    if req.method == "GET":
        items = [_point_event_dict(e) for e in table.list_entities()]
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    axis_id = (body.get("axis") or "").strip()
    if not axis_id:
        return func.HttpResponse("axis is required", status_code=400)

    points_value = body.get("points")
    if not isinstance(points_value, int) or isinstance(points_value, bool):
        return func.HttpResponse("points must be an integer", status_code=400)

    if axis_id == "other":
        label = (body.get("axisLabel") or "").strip()
        if not label:
            return func.HttpResponse("axisLabel is required when axis is 'other'", status_code=400)
        entity = _create_point_event(label, points_value, body.get("note", ""), period="week", catalog_id="other")
    else:
        catalog_entry = SCORE_EVENT_CATALOG_BY_ID.get(axis_id)
        if not catalog_entry:
            return func.HttpResponse(
                f"axis must be one of: {', '.join(SCORE_EVENT_CATALOG_BY_ID)}, other",
                status_code=400,
            )
        entity = _create_point_event(
            catalog_entry["label"], points_value, body.get("note", ""),
            period=catalog_entry["period"], catalog_id=axis_id,
        )
    return func.HttpResponse(json.dumps(_point_event_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json")


# ba-160: Googleカレンダー連携(予定ページ)。このAzure Functions自体のOAuth連携が要る
# (Claude Code側のMCPツールはこのセッション専用でサイトからは呼べないため)。
# aapj-501407のDesktopクライアント(scripts/backup-balog-to-drive.pyと共用)で、
# calendar.readonlyスコープのrefresh tokenを別途取得して使う
# (scripts/get_gcal_refresh_token.py、2026-07-26セットアップ)。
GCAL_OAUTH_CLIENT_ID = os.environ.get("GCAL_OAUTH_CLIENT_ID", "")
GCAL_OAUTH_CLIENT_SECRET = os.environ.get("GCAL_OAUTH_CLIENT_SECRET", "")
GCAL_OAUTH_REFRESH_TOKEN = os.environ.get("GCAL_OAUTH_REFRESH_TOKEN", "")


def _gcal_access_token():
    resp = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": GCAL_OAUTH_CLIENT_ID,
        "client_secret": GCAL_OAUTH_CLIENT_SECRET,
        "refresh_token": GCAL_OAUTH_REFRESH_TOKEN,
        "grant_type": "refresh_token",
    }, timeout=5)
    resp.raise_for_status()
    return resp.json()["access_token"]


@app.function_name(name="calendar-events")
@app.route(route="calendar-events", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def calendar_events(req: func.HttpRequest) -> func.HttpResponse:
    # カレンダーの中身は他者の氏名・場所等を含みうる個人情報のため、visits/scoresと違い
    # 閲覧も認証必須にする(このサイトの「GETは公開」の既定から意図的に外す)。
    err = _authorize_get(req)
    if err:
        return err

    if not (GCAL_OAUTH_CLIENT_ID and GCAL_OAUTH_CLIENT_SECRET and GCAL_OAUTH_REFRESH_TOKEN):
        return func.HttpResponse("calendar integration not configured", status_code=503)

    try:
        access_token = _gcal_access_token()
        resp = requests.get(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            headers={"Authorization": f"Bearer {access_token}"},
            params={
                "timeMin": datetime.now(timezone.utc).isoformat(),
                "maxResults": 20,
                "singleEvents": "true",
                "orderBy": "startTime",
            },
            timeout=5,
        )
        resp.raise_for_status()
    except Exception as e:
        return func.HttpResponse(f"calendar fetch failed: {e}", status_code=502)

    items = []
    for e in resp.json().get("items", []):
        start = (e.get("start") or {}).get("dateTime") or (e.get("start") or {}).get("date")
        end = (e.get("end") or {}).get("dateTime") or (e.get("end") or {}).get("date")
        items.append({
            "id": e.get("id"),
            "summary": e.get("summary", ""),
            "start": start,
            "end": end,
            "location": e.get("location", ""),
        })
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


# ba-160: 宣言(Declarations)。ba-165機構3(翌週以降の宣言→達成で加点、先の週ほど
# 高得点)の宣言側。達成にした瞬間、確定済みの倍々式(1週先=5/2週先=10/3週先=20/
# 4週先=40)でPointEventsへ自動追記する(手動計算の手間を無くす)。
DECLARATIONS_TABLE = "Declarations"


def _declaration_dict(e):
    return {
        "id": e["RowKey"],
        "text": e.get("Text", ""),
        "targetWeek": e.get("TargetWeek", ""),
        "createdAt": e.get("CreatedAt", ""),
        "achieved": e.get("Achieved", False),
        "achievedAt": e.get("AchievedAt", ""),
    }


@app.function_name(name="declarations")
@app.route(route="declarations", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def declarations(req: func.HttpRequest) -> func.HttpResponse:
    table = _table_client(DECLARATIONS_TABLE)

    if req.method == "GET":
        items = [_declaration_dict(e) for e in table.list_entities()]
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    text = (body.get("text") or "").strip()
    if not text:
        return func.HttpResponse("text is required", status_code=400)

    target_week = body.get("targetWeek") or ""
    if not _parse_week_key(target_week):
        return func.HttpResponse("targetWeek must look like 2026-W32", status_code=400)

    entity = {
        "PartitionKey": "declaration",
        "RowKey": str(uuid.uuid4()),
        "Text": text,
        "TargetWeek": target_week,
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
        "Achieved": False,
        "AchievedAt": "",
    }
    table.upsert_entity(entity)
    return func.HttpResponse(json.dumps(_declaration_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json")


@app.function_name(name="declarations-achieve")
@app.route(route="declarations/{decl_id}/achieve", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def declarations_achieve(req: func.HttpRequest) -> func.HttpResponse:
    decl_id = req.route_params.get("decl_id")
    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    table = _table_client(DECLARATIONS_TABLE)
    try:
        entity = table.get_entity(partition_key="declaration", row_key=decl_id)
    except ResourceNotFoundError:
        return func.HttpResponse("declaration not found", status_code=404)

    if entity.get("Achieved"):
        return func.HttpResponse(json.dumps(_declaration_dict(entity), ensure_ascii=False), mimetype="application/json")

    parsed = _parse_week_key(entity.get("TargetWeek", ""))
    target_year, target_week = parsed
    _, _, target_monday = _week_bounds(target_year, target_week)

    created_at = datetime.fromisoformat(entity["CreatedAt"])
    declared_year, declared_week, _ = created_at.astimezone(JST).isocalendar()
    _, _, declared_monday = _week_bounds(declared_year, declared_week)

    weeks_ahead = max(1, (target_monday - declared_monday).days // 7)
    # ba-165決定(2026-07-26): 1週先=5/2週先=10/3週先=20/4週先=40(倍々式)。上限は運用で調整。
    awarded_points = 5 * (2 ** (weeks_ahead - 1))

    entity["Achieved"] = True
    entity["AchievedAt"] = datetime.now(timezone.utc).isoformat()
    table.upsert_entity(entity)

    _create_point_event("宣言達成", awarded_points, f"{entity.get('Text', '')}({weeks_ahead}週先)", catalog_id="plan_done")

    result = _declaration_dict(entity)
    result["awardedPoints"] = awarded_points
    return func.HttpResponse(json.dumps(result, ensure_ascii=False), status_code=200, mimetype="application/json")


SCORES_TABLE = "Scores"


def _score_dict(e):
    return {"score": e.get("Score", 0), "note": e.get("Note", ""), "createdAt": e.get("CreatedAt", "")}


@app.function_name(name="scores")
@app.route(route="scores", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def scores(req: func.HttpRequest) -> func.HttpResponse:
    # ba-35残課題(2): 閲覧はログイン不要にする(2026-07-20)。書き込み(PUT)は引き続き認証必須。
    table = _table_client(SCORES_TABLE)
    items = [{"date": e["RowKey"], **_score_dict(e)} for e in table.list_entities()]
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


@app.function_name(name="scores-item")
@app.route(route="scores/{date}", methods=["GET", "PUT"], auth_level=func.AuthLevel.ANONYMOUS)
def scores_item(req: func.HttpRequest) -> func.HttpResponse:
    date = req.route_params.get("date")
    table = _table_client(SCORES_TABLE)

    if req.method == "GET":
        # ba-35残課題(2): 閲覧はログイン不要にする(2026-07-20)。書き込み(PUT)は引き続き認証必須。
        try:
            body = _score_dict(table.get_entity(partition_key="score", row_key=date))
        except Exception:
            body = None
        return func.HttpResponse(json.dumps(body, ensure_ascii=False), mimetype="application/json")

    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    score = body.get("score")
    if not isinstance(score, (int, float)) or isinstance(score, bool) or not (0 <= score <= 100):
        return func.HttpResponse("score must be a number between 0 and 100", status_code=400)

    entity = {
        "PartitionKey": "score",
        "RowKey": date,
        "Score": score,
        "Note": body.get("note", ""),
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    }
    table.upsert_entity(entity)
    # ba-30(4): upsert(更新もありうる)なのに常に201を返していたのをやめ、checksと揃えて既定の200にする。
    return func.HttpResponse(json.dumps(_score_dict(entity), ensure_ascii=False), mimetype="application/json")


# ba(n4の後継)。骨組みはn4と同じ追記オンリー台帳だが、Claude Codeレーンを
# スマホ/PCで別鍵にし、"実機/実ブラウザで確認できた"ことを主張する種別
# (verified_on_device)だけはPCレーンのみ書き込み可にする。
BA_TABLE = "BaLog"
BA_HUMAN_ALLOWED_TYPES = {"new", "note", "void", "status", "approval", "correction", "react", "link", "gist"}
BA_DEVICE_VERIFIED_TYPES = {"verified_on_device"}
# ba-77: 承認キュー。claudeレーンがproposeFor:"takashi"付きで投函した提案を、
# takashi本人(人間レーン、実ログイン)だけが承認できるようにする。新しい秘密は増やさない。
BA_TAKASHI_ONLY_TYPES = {"approval"}
# correction: タイトルは追記オンリーゆえ最初の書き方に固定されがちなので、
# titleを持つcorrectionをstatusのopen/closedと同じ「refで参照し最新が勝つ」形で
# 見出しの付け直しに使う(thread-logic.jsのdisplayTitle解決を参照)。
# 元のnewエントリのtitleは書き換えず残る(付け直しの履歴も追記として残る)。
# 以前はclaude-pc/mobileレーンだけが書けた(人間レーンのアローリストに無かった)が、
# takashi本人も付け直せるようにここに追加した。
# react: 3レーン(takashi/claude-pc/claude-mobile)がそれぞれ自分の反応(value:true/false、
# voidと同じく後勝ち・by別に独立)を残せる種別。参考程度の反応であり、正式な承認・決定
# 条件ではない(意思決定はapprovalが担う。reactは判断根拠にしない)。
# ba-53: スレッドクローズの難易度別得点(週次得点で使う)。
BA_DIFFICULTY_POINTS = {"low": 2, "normal": 5, "high": 10}
BA_DEFAULT_DIFFICULTY = "normal"
# ba-162: スレッド間の関連付け(redmine風の関連チケット)。voidと同じ「追記のみ・
# 最新値が勝つ」設計にし、rel先はthreadIdでなく人間が呼ぶseq番号(relSeq)で指定する
# (投稿側がthreadIdを調べずに済む)。存在しないseqへの誤参照はreact同様に許容し、
# POSTのたびにテーブル全体を走査してseqの実在確認はしない。双方向表示・タイトル
# プレビューの集約はthread-logic.js側のprojectionが担う。
# gist: 確定仕様スレッドに「今の結論」を一言(200字以内)で持たせる種別。correction/statusと
# 同じ「追記のみ・最新のtextが勝つ」設計。分類(確定仕様)に関わらず投稿・計算は無条件に行い、
# 「確定仕様の時だけ意味を持つ」という制約は表示側(ba/bb/rbook)の判断に任せる。


def _ba_entry_dict(e):
    try:
        data = json.loads(e.get("Data") or "{}")
    except ValueError:
        data = {}
    return {
        "id": e["RowKey"],
        "threadId": e["PartitionKey"],
        "by": e.get("By", ""),
        "ref": e.get("Ref") or None,
        "type": e.get("Type", ""),
        "seq": e.get("Seq"),
        "createdAt": e.get("CreatedAt", ""),
        **data,
    }


BA_SEQ_PARTITION = "_meta"
BA_SEQ_ROW = "ba_seq"


def _next_ba_seq(table):
    """採番用の専用カウンタエンティティをインクリメントする。
    以前は台帳全件をスキャンしてSeqの最大値を求めていたが、台帳が育つほど
    書き込みが遅くなるため、O(1)のカウンタ読み書きに変更した。
    カウンタ未作成(初回のみ)はResourceNotFoundErrorとして0からにするが、
    それ以外の例外(一時的な通信障害等)まで0扱いにすると採番が巻き戻って
    Seq重複を生むため、ここは握りつぶさず呼び出し元に伝播させる(2026-07-20実例で発覚)。"""
    try:
        current = table.get_entity(partition_key=BA_SEQ_PARTITION, row_key=BA_SEQ_ROW).get("Value", 0)
    except ResourceNotFoundError:
        current = 0
    seq = current + 1
    table.upsert_entity({"PartitionKey": BA_SEQ_PARTITION, "RowKey": BA_SEQ_ROW, "Value": seq})
    return seq


def _ba_claude_lane(claude_key):
    """渡された鍵がスマホ用/PC用のどちらと一致するかを判定する。
    一致しなければNoneを返し、人間レーンへフォールバックさせる。"""
    if not claude_key:
        return None
    mobile_key = os.environ.get("BA_CLAUDE_KEY_MOBILE", "")
    pc_key = os.environ.get("BA_CLAUDE_KEY_PC", "")
    if pc_key and claude_key == pc_key:
        return "claude-pc"
    if mobile_key and claude_key == mobile_key:
        return "claude-mobile"
    return None


def _truthy_param(value):
    return (value or "").strip().lower() in ("1", "true", "yes")


def _require_existing_root(table, entry_type, ref):
    """rootless防止(ba-72/ba-101、gist追加でstatus専用から汎用化): refが
    既存スレッドのroot(PartitionKey=RowKey=ref)を指していることを確認する。
    問題なければNone、問題があれば返すべきHttpResponseを返す。"""
    if ref:
        try:
            table.get_entity(partition_key=ref, row_key=ref)
            return None
        except ResourceNotFoundError:
            pass
    return func.HttpResponse(
        json.dumps(
            {"error": f"{entry_type}のref先スレッドが存在しません(rootless防止)", "ref": ref},
            ensure_ascii=False,
        ),
        status_code=400,
        mimetype="application/json",
    )


def _ba_open_thread_ids(items):
    """void済み・status=closedでないスレッドのthreadId集合を返す。
    rbook(run.py)の_ba_is_voided/_ba_current_statusと同じ判定ロジック
    (voidはref/threadId両対応、statusはref指定のみ)をサーバー側に複製したもの。"""
    news_tids = [e["threadId"] for e in items if e.get("type") == "new"]

    voided = set()
    for e in items:
        if e.get("type") != "void":
            continue
        if e.get("ref"):
            voided.add(e["ref"])
        if e.get("threadId"):
            voided.add(e["threadId"])

    latest_status = {}
    for e in items:
        if e.get("type") != "status":
            continue
        tid = e.get("ref")
        if not tid:
            continue
        created = e.get("createdAt", "")
        if tid not in latest_status or created > latest_status[tid][0]:
            latest_status[tid] = (created, e.get("status") or "open")

    return {
        tid for tid in news_tids
        if tid not in voided and latest_status.get(tid, ("", "open"))[1] == "open"
    }


@app.function_name(name="ba-log")
@app.route(route="ba", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def ba_log(req: func.HttpRequest) -> func.HttpResponse:
    table = _table_client(BA_TABLE)

    if req.method == "GET":
        # 読み取りは無認証で公開(2026-07-15 takashi判断)。ba-16「GETは認証必須」の
        # 一部撤回であり、ba-35の「閲覧専用の軽い経路」に相当。POST側の認証は従来どおり。
        items = [
            _ba_entry_dict(e) for e in table.list_entities()
            if e["PartitionKey"] != BA_SEQ_PARTITION
        ]
        items.sort(key=lambda x: x["createdAt"])

        # ba-174: セッション開始時の全件取得コストを下げるための軽量モード。
        # open=1はクローズ済みスレッド一式を除外(実測37%程度に縮小)、
        # minimal=1はbodyを削る(同28.7%)。組み合わせると実測10.7%まで縮む。
        if _truthy_param(req.params.get("open")):
            open_ids = _ba_open_thread_ids(items)
            items = [e for e in items if e.get("threadId") in open_ids]
        if _truthy_param(req.params.get("minimal")):
            items = [{k: v for k, v in e.items() if k != "body"} for e in items]

        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = _get_body(req)

    by = _ba_claude_lane(body.get("claude_key", ""))
    if not by:
        err = _authorize(body)
        if err:
            return err
        by = "takashi"

    entry_type = body.get("type") or "new"
    if by == "takashi" and entry_type not in BA_HUMAN_ALLOWED_TYPES:
        return func.HttpResponse(
            f"human lane can only write: {', '.join(sorted(BA_HUMAN_ALLOWED_TYPES))}",
            status_code=400,
        )
    if entry_type in BA_DEVICE_VERIFIED_TYPES and by != "claude-pc":
        return func.HttpResponse(
            f"only claude-pc can write: {', '.join(sorted(BA_DEVICE_VERIFIED_TYPES))}",
            status_code=400,
        )
    if entry_type in BA_TAKASHI_ONLY_TYPES and by != "takashi":
        return func.HttpResponse(
            f"only takashi can write: {', '.join(sorted(BA_TAKASHI_ONLY_TYPES))}",
            status_code=400,
        )

    # ba-53: 週次得点のクローズ得点計算に使うdifficulty(low/normal/high)。
    # newスレッド作成時のみ受け付け、未指定ならBA_DEFAULT_DIFFICULTYを明示的に補う
    # (difficultyなしの過去スレッドはweekly-scores側の計算時にも同じ既定値へフォールバックする)。
    if entry_type == "new":
        difficulty = body.get("difficulty") or BA_DEFAULT_DIFFICULTY
        if difficulty not in BA_DIFFICULTY_POINTS:
            return func.HttpResponse(
                f"difficulty must be one of: {', '.join(sorted(BA_DIFFICULTY_POINTS))}",
                status_code=400,
            )
        body = {**body, "difficulty": difficulty}

    # ba-162: 関連付け(link)。relSeq(対象スレッドのseq番号)必須、valueは省略時true、
    # falseなら「この(ref, relSeq)の組の関連付けを取り消す」を意味する(追記のみ)。
    if entry_type == "link":
        rel_seq = body.get("relSeq")
        if not isinstance(rel_seq, int) or isinstance(rel_seq, bool) or rel_seq <= 0:
            return func.HttpResponse(
                "relSeq must be a positive integer",
                status_code=400,
            )
        body = {**body, "value": body.get("value", True)}

    if entry_type == "gist":
        text = (body.get("text") or "").strip()
        if not text:
            return func.HttpResponse("text is required", status_code=400)
        if len(text) > 200:
            return func.HttpResponse("text must be 200 characters or fewer", status_code=400)
        body = {**body, "text": text}

    # 疎通確認用: dry_run=trueなら鍵・種別の検証だけ行い、台帳には書き込まない(ba-5)。
    if body.get("dry_run"):
        return func.HttpResponse(
            json.dumps({"dry_run": True, "by": by, "type": entry_type}, ensure_ascii=False),
            mimetype="application/json",
        )

    ref = (body.get("ref") or "").strip()
    if entry_type == "new":
        ref = ""  # newは常に新規スレッドの起点にする

    # rootless防止(ba-72/ba-101、gist追加でstatus専用から汎用化): statusやgistは必ず
    # 既存スレッドのroot(PartitionKey=RowKey=ref)を指していなければならない。スタレ/破損refを
    # 通すと孤立エントリ(rootless)ができ、_calc_weekly_scoreのクローズ集計等が静かにズレる。
    # 発生源で拒否する。
    if entry_type in ("status", "gist"):
        err = _require_existing_root(table, entry_type, ref)
        if err:
            return err

    now = datetime.now(timezone.utc)
    entry_id = now.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
    partition = ref if ref else entry_id

    exclude_keys = {"credential", "claude_key", "type", "ref"}
    data_fields = {k: v for k, v in body.items() if k not in exclude_keys}

    entity = {
        "PartitionKey": partition,
        "RowKey": entry_id,
        "By": by,
        "Ref": ref,
        "Type": entry_type,
        "Data": json.dumps(data_fields, ensure_ascii=False),
        "CreatedAt": now.isoformat(),
    }
    if entry_type == "new":
        entity["Seq"] = _next_ba_seq(table)
    table.upsert_entity(entity)
    return func.HttpResponse(json.dumps(_ba_entry_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json")


# ba-53: 週次得点(毎日スコア合計 + baクローズの難易度別得点)。takashi確定仕様(2026-07-21):
# ・週は月曜始まり(月〜日、JST)。ISO 8601の週番号(date.isocalendar系)がそのままこの定義に合う。
# ・難易度別配点: low=2/normal=5/high=10。difficulty未設定の過去スレッドはnormal扱い。
# ・計算タイミングは「管理ページアクセス時のオンデマンド」を推奨(takashi)。このためWeeklyScores
#   テーブルは"確定させたい週のスナップショット"を保存する用途とし、GET detailは未保存の週なら
#   その場で計算した値をその都度返す(保存はrecalculateを呼んだ時のみ)。
WEEKLY_SCORES_TABLE = "WeeklyScores"
JST = timezone(timedelta(hours=9))


def _week_bounds(iso_year, iso_week):
    """ISO年/週(月曜始まり)から、その週の[月曜0時JST, 翌月曜0時JST)をUTCで返す。
    3つ目の戻り値はその週の月曜日(JSTのdate)。"""
    monday = date.fromisocalendar(iso_year, iso_week, 1)
    start_jst = datetime(monday.year, monday.month, monday.day, tzinfo=JST)
    end_jst = start_jst + timedelta(days=7)
    return start_jst.astimezone(timezone.utc), end_jst.astimezone(timezone.utc), monday


def _week_row_key(iso_week, monday):
    return f"W{iso_week:02d}_{monday.isoformat()}"


def _parse_week_key(week_key):
    """"2026-W29"形式をパースして(year, week)を返す。不正な形式ならNone。"""
    year_str, sep, week_str = (week_key or "").partition("-W")
    if not sep:
        return None
    try:
        return int(year_str), int(week_str)
    except ValueError:
        return None


# ba-159: イカサマ対策(基準ずらし記録)。difficulty配点(BA_DIFFICULTY_POINTS)は元々
# コード上の固定定数だったため、将来配点を変えると、まだrecalculateしていない過去の週の
# オンデマンド計算結果が当時のルールでなく新ルールで静かに変わってしまう欠陥があった
# (2026-07-26、ba-165実装中に発見)。ScoringRulesテーブルで配点を版管理し、週の月曜日
# 時点で有効だった配点を都度引くことでこれを直す。ラベル集合(low/normal/high)自体は
# 変えない前提とし、BA_DIFFICULTY_POINTSは「ラベルの妥当性チェック」と「初回シード値」に
# 用途を絞る。
SCORING_RULES_TABLE = "ScoringRules"
SCORING_RULES_PARTITION = "rule"
SCORING_RULES_SEED_EFFECTIVE_FROM = "2026-01-01"


def _seed_scoring_rules_if_empty(table):
    """初回のみ、現行配点(BA_DIFFICULTY_POINTS)を過去日付でシードする。既存の
    recalculate済みWeeklyScoresの挙動が、新設のScoringRulesテーブルの有無で
    変わらないようにするための一度きりの移行措置。"""
    if list(table.list_entities()):
        return
    table.upsert_entity({
        "PartitionKey": SCORING_RULES_PARTITION,
        "RowKey": SCORING_RULES_SEED_EFFECTIVE_FROM,
        "DifficultyPoints": json.dumps(BA_DIFFICULTY_POINTS, ensure_ascii=False),
        "Note": "初期配点(seed)",
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    })


def _scoring_rule_at(table, on_or_before_date_str):
    """table内で、EffectiveFrom(RowKey)がon_or_before_date_str以前の行のうち
    最新のものの配点を返す。無ければBA_DIFFICULTY_POINTS(現行値)にフォールバック。"""
    candidates = [e for e in table.list_entities() if e["RowKey"] <= on_or_before_date_str]
    if not candidates:
        return dict(BA_DIFFICULTY_POINTS)
    latest = max(candidates, key=lambda e: e["RowKey"])
    try:
        return json.loads(latest.get("DifficultyPoints") or "{}")
    except ValueError:
        return dict(BA_DIFFICULTY_POINTS)


def _latest_scoring_rule(table):
    return _scoring_rule_at(table, "9999-12-31")


def _scoring_rule_dict(e):
    return {
        "effectiveFrom": e["RowKey"],
        "difficultyPoints": json.loads(e.get("DifficultyPoints") or "{}"),
        "note": e.get("Note", ""),
        "createdAt": e.get("CreatedAt", ""),
    }


@app.function_name(name="scoring-rules")
@app.route(route="scoring-rules", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def scoring_rules(req: func.HttpRequest) -> func.HttpResponse:
    table = _table_client(SCORING_RULES_TABLE)
    _seed_scoring_rules_if_empty(table)

    if req.method == "GET":
        items = [_scoring_rule_dict(e) for e in table.list_entities()]
        items.sort(key=lambda x: x["effectiveFrom"])
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    difficulty_points = body.get("difficultyPoints")
    if not isinstance(difficulty_points, dict) or set(difficulty_points.keys()) != set(BA_DIFFICULTY_POINTS.keys()):
        return func.HttpResponse(
            f"difficultyPoints must have exactly these keys: {', '.join(sorted(BA_DIFFICULTY_POINTS))}",
            status_code=400,
        )
    for v in difficulty_points.values():
        if not isinstance(v, int) or isinstance(v, bool):
            return func.HttpResponse("difficultyPoints values must be integers", status_code=400)

    effective_from = body.get("effectiveFrom") or datetime.now(JST).date().isoformat()
    try:
        date.fromisoformat(effective_from)
    except ValueError:
        return func.HttpResponse("effectiveFrom must look like YYYY-MM-DD", status_code=400)

    entity = {
        "PartitionKey": SCORING_RULES_PARTITION,
        "RowKey": effective_from,
        "DifficultyPoints": json.dumps(difficulty_points, ensure_ascii=False),
        "Note": body.get("note", ""),
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    }
    table.upsert_entity(entity)
    return func.HttpResponse(json.dumps(_scoring_rule_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json")


def _ba_close_transitions(ba_table):
    """ba-109: スレッドごとのstatus履歴を辿り、「非closeからcloseへ転じた瞬間」だけを
    close確定イベントとして抽出する。同じスレッドが間にopen(再オープン)を挟まず連続で
    複数回closeされても(2026-07-26に実際発生した誤投稿・重複close)、2回目以降は数えない。
    voidされたスレッドのcloseは(スレッド単位で)一切数えない。
    戻り値: [(thread_id, closeエントリのCreatedAt文字列), ...]"""
    statuses_by_thread = {}
    voided_threads = set()
    for e in ba_table.list_entities():
        etype = e.get("Type")
        if etype == "void":
            voided_threads.add(e["PartitionKey"])
            if e.get("Ref"):
                voided_threads.add(e["Ref"])
        elif etype == "status":
            data = json.loads(e.get("Data") or "{}")
            status = data.get("status")
            if not status:
                continue
            statuses_by_thread.setdefault(e["PartitionKey"], []).append((e.get("CreatedAt", ""), status))

    transitions = []
    for thread_id, records in statuses_by_thread.items():
        if thread_id in voided_threads:
            continue
        records.sort(key=lambda r: r[0])
        was_closed = False
        for created_at, status in records:
            if status == "closed":
                if not was_closed:
                    transitions.append((thread_id, created_at))
                was_closed = True
            else:
                was_closed = False
    return transitions


def _calc_weekly_score(iso_year, iso_week):
    """指定週の週次得点を、Scores(毎日スコア)とBaLog(クローズ)から都度計算する。
    永続化はせず、呼び出し元(GET detailまたはrecalculate)が必要に応じて保存する。"""
    start_utc, end_utc, monday = _week_bounds(iso_year, iso_week)
    week_dates = [(monday + timedelta(days=i)).isoformat() for i in range(7)]

    scores_table = _table_client(SCORES_TABLE)
    daily_score_sum = 0
    for d in week_dates:
        try:
            entity = scores_table.get_entity(partition_key="score", row_key=d)
        except ResourceNotFoundError:
            continue
        daily_score_sum += entity.get("Score", 0)

    # ba-159: その週の月曜日時点で有効だった配点(当時のルール)と、現在最新の配点
    # (「当時の基準だとこう」の比較用)の両方を使う。
    scoring_rules_table = _table_client(SCORING_RULES_TABLE)
    _seed_scoring_rules_if_empty(scoring_rules_table)
    active_rule = _scoring_rule_at(scoring_rules_table, monday.isoformat())
    latest_rule = _latest_scoring_rule(scoring_rules_table)

    ba_table = _table_client(BA_TABLE)
    breakdown = {"low": 0, "normal": 0, "high": 0}
    close_count = 0
    close_value = 0
    close_value_as_of_latest = 0
    for thread_id, created_at_str in _ba_close_transitions(ba_table):
        try:
            created_at = datetime.fromisoformat(created_at_str)
        except ValueError:
            continue
        if not (start_utc <= created_at < end_utc):
            continue

        difficulty = BA_DEFAULT_DIFFICULTY
        try:
            root = ba_table.get_entity(partition_key=thread_id, row_key=thread_id)
            root_data = json.loads(root.get("Data") or "{}")
            difficulty = root_data.get("difficulty") or BA_DEFAULT_DIFFICULTY
        except ResourceNotFoundError:
            pass
        if difficulty not in BA_DIFFICULTY_POINTS:
            difficulty = BA_DEFAULT_DIFFICULTY

        close_count += 1
        breakdown[difficulty] += 1
        close_value += active_rule.get(difficulty, BA_DIFFICULTY_POINTS[difficulty])
        close_value_as_of_latest += latest_rule.get(difficulty, BA_DIFFICULTY_POINTS[difficulty])

    # ba-165: 加点軸の拡張。PointEvents(自己申告のpoints)を週範囲で合算するだけ。
    # 軸ごとの意味(streakか予測的中か等)はサーバーでは判定しない(自己申告のため)。
    point_events_table = _table_client(POINT_EVENTS_TABLE)
    point_event_sum = 0
    for e in point_events_table.list_entities():
        try:
            created_at = datetime.fromisoformat(e.get("CreatedAt", ""))
        except ValueError:
            continue
        if start_utc <= created_at < end_utc:
            point_event_sum += e.get("Points", 0)

    return {
        "year": iso_year,
        "week": iso_week,
        "weekKey": f"{iso_year}-W{iso_week:02d}",
        "weekStart": monday.isoformat(),
        "weekEnd": (monday + timedelta(days=6)).isoformat(),
        "dailyScoreSum": daily_score_sum,
        "closeCount": close_count,
        "closeValue": close_value,
        "closeValueAsOfLatest": close_value_as_of_latest,
        "breakdownByDifficulty": breakdown,
        "pointEventSum": point_event_sum,
        "weekScore": daily_score_sum + close_value + point_event_sum,
        "weekScoreAsOfLatest": daily_score_sum + close_value_as_of_latest + point_event_sum,
        "calculatedAt": None,
    }


def _weekly_score_entity_dict(e):
    # ba-159: 保存済み(recalculate済み)週も、「今の配点だったら」を都度計算して見せる。
    # 保存値(当時のルールで確定した値)自体は書き換えない。
    breakdown = json.loads(e.get("BreakdownByDifficulty") or "{}")
    scoring_rules_table = _table_client(SCORING_RULES_TABLE)
    _seed_scoring_rules_if_empty(scoring_rules_table)
    latest_rule = _latest_scoring_rule(scoring_rules_table)
    close_value_as_of_latest = sum(
        breakdown.get(k, 0) * latest_rule.get(k, BA_DIFFICULTY_POINTS[k]) for k in BA_DIFFICULTY_POINTS
    )
    daily_score_sum = e.get("DailyScoreSum", 0)
    point_event_sum = e.get("PointEventSum", 0)
    return {
        "year": int(e["PartitionKey"]),
        "week": e.get("Week"),
        "weekKey": f"{e['PartitionKey']}-W{e.get('Week', 0):02d}",
        "weekStart": e.get("WeekStart", ""),
        "weekEnd": e.get("WeekEnd", ""),
        "dailyScoreSum": daily_score_sum,
        "closeCount": e.get("CloseCount", 0),
        "closeValue": e.get("CloseValue", 0),
        "closeValueAsOfLatest": close_value_as_of_latest,
        "breakdownByDifficulty": breakdown,
        "pointEventSum": point_event_sum,
        "weekScore": e.get("WeekScore", 0),
        "weekScoreAsOfLatest": daily_score_sum + close_value_as_of_latest + point_event_sum,
        "calculatedAt": e.get("CalculatedAt", ""),
    }


def _persist_weekly_score(iso_year, iso_week):
    result = _calc_weekly_score(iso_year, iso_week)
    _, _, monday = _week_bounds(iso_year, iso_week)
    entity = {
        "PartitionKey": str(iso_year),
        "RowKey": _week_row_key(iso_week, monday),
        "Week": iso_week,
        "WeekStart": result["weekStart"],
        "WeekEnd": result["weekEnd"],
        "DailyScoreSum": result["dailyScoreSum"],
        "CloseCount": result["closeCount"],
        "CloseValue": result["closeValue"],
        "BreakdownByDifficulty": json.dumps(result["breakdownByDifficulty"], ensure_ascii=False),
        "PointEventSum": result["pointEventSum"],
        "WeekScore": result["weekScore"],
        "CalculatedAt": datetime.now(timezone.utc).isoformat(),
    }
    _table_client(WEEKLY_SCORES_TABLE).upsert_entity(entity)
    return entity


@app.function_name(name="weekly-scores")
@app.route(route="weekly-scores", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def weekly_scores(req: func.HttpRequest) -> func.HttpResponse:
    # recalculateで確定保存された週だけを一覧する(閲覧は無認証、scores/ba踏襲)。
    table = _table_client(WEEKLY_SCORES_TABLE)
    items = [_weekly_score_entity_dict(e) for e in table.list_entities()]
    items.sort(key=lambda x: x["weekKey"])
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


@app.function_name(name="weekly-scores-item")
@app.route(route="weekly-scores/{week_key}", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def weekly_scores_item(req: func.HttpRequest) -> func.HttpResponse:
    week_key = req.route_params.get("week_key")
    parsed = _parse_week_key(week_key)
    if not parsed:
        return func.HttpResponse("week_key must look like 2026-W29", status_code=400)
    iso_year, iso_week = parsed

    table = _table_client(WEEKLY_SCORES_TABLE)
    _, _, monday = _week_bounds(iso_year, iso_week)
    try:
        entity = table.get_entity(partition_key=str(iso_year), row_key=_week_row_key(iso_week, monday))
        body = _weekly_score_entity_dict(entity)
    except ResourceNotFoundError:
        # まだrecalculateされていない週は、保存はせずその場計算した値を返す。
        body = _calc_weekly_score(iso_year, iso_week)
    return func.HttpResponse(json.dumps(body, ensure_ascii=False), mimetype="application/json")


@app.function_name(name="weekly-scores-recalculate")
@app.route(route="weekly-scores/recalculate", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def weekly_scores_recalculate(req: func.HttpRequest) -> func.HttpResponse:
    # 書き込み(確定保存)は他の書き込み系(visits/scores)同様に認証必須。
    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    parsed = _parse_week_key(body.get("weekKey", ""))
    if not parsed:
        return func.HttpResponse("weekKey must look like 2026-W29", status_code=400)
    iso_year, iso_week = parsed

    entity = _persist_weekly_score(iso_year, iso_week)
    return func.HttpResponse(
        json.dumps(_weekly_score_entity_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json"
    )


# ba-165③(2026-07-29確定、Takashi判断): 月次得点。生産(出版/YouTube/知名度)・予測(資産/体重)は
# 月単位でしか意味を持たない事象のため、週次得点(dailyScoreSum/closeValue)とは完全に別集計にする。
# 週次側と対称的に、SCORE_EVENT_CATALOGでperiod="month"の軸のPointEventsだけを月範囲で合算する
# (毎日スコアやbaクローズは月次には含めない)。オンデマンド計算+recalculateでの保存という
# weekly-scoresと同じ設計を踏襲する。
MONTHLY_SCORES_TABLE = "MonthlyScores"


def _month_bounds(year, month):
    """year/month(JST)から、その月の[1日0時JST, 翌月1日0時JST)をUTCで返す。"""
    start_jst = datetime(year, month, 1, tzinfo=JST)
    if month == 12:
        end_jst = datetime(year + 1, 1, 1, tzinfo=JST)
    else:
        end_jst = datetime(year, month + 1, 1, tzinfo=JST)
    return start_jst.astimezone(timezone.utc), end_jst.astimezone(timezone.utc)


def _parse_month_key(month_key):
    """"2026-07"形式をパースして(year, month)を返す。不正な形式ならNone。"""
    parts = (month_key or "").split("-")
    if len(parts) != 2:
        return None
    try:
        year, month = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (1 <= month <= 12):
        return None
    return year, month


def _calc_monthly_score(year, month):
    start_utc, end_utc = _month_bounds(year, month)
    point_events_table = _table_client(POINT_EVENTS_TABLE)
    breakdown = {}
    total = 0
    for e in point_events_table.list_entities():
        if e.get("Period") != "month":
            continue
        try:
            created_at = datetime.fromisoformat(e.get("CreatedAt", ""))
        except ValueError:
            continue
        if not (start_utc <= created_at < end_utc):
            continue
        axis = e.get("Axis", "")
        breakdown[axis] = breakdown.get(axis, 0) + e.get("Points", 0)
        total += e.get("Points", 0)

    return {
        "year": year,
        "month": month,
        "monthKey": f"{year}-{month:02d}",
        "breakdownByAxis": breakdown,
        "monthScore": total,
        "calculatedAt": None,
    }


def _monthly_score_entity_dict(e):
    return {
        "year": int(e["PartitionKey"]),
        "month": e.get("Month"),
        "monthKey": f"{e['PartitionKey']}-{e.get('Month', 0):02d}",
        "breakdownByAxis": json.loads(e.get("BreakdownByAxis") or "{}"),
        "monthScore": e.get("MonthScore", 0),
        "calculatedAt": e.get("CalculatedAt", ""),
    }


def _persist_monthly_score(year, month):
    result = _calc_monthly_score(year, month)
    entity = {
        "PartitionKey": str(year),
        "RowKey": f"M{month:02d}",
        "Month": month,
        "BreakdownByAxis": json.dumps(result["breakdownByAxis"], ensure_ascii=False),
        "MonthScore": result["monthScore"],
        "CalculatedAt": datetime.now(timezone.utc).isoformat(),
    }
    _table_client(MONTHLY_SCORES_TABLE).upsert_entity(entity)
    return entity


@app.function_name(name="monthly-scores")
@app.route(route="monthly-scores", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def monthly_scores(req: func.HttpRequest) -> func.HttpResponse:
    table = _table_client(MONTHLY_SCORES_TABLE)
    items = [_monthly_score_entity_dict(e) for e in table.list_entities()]
    items.sort(key=lambda x: x["monthKey"])
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


@app.function_name(name="monthly-scores-item")
@app.route(route="monthly-scores/{month_key}", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def monthly_scores_item(req: func.HttpRequest) -> func.HttpResponse:
    month_key = req.route_params.get("month_key")
    parsed = _parse_month_key(month_key)
    if not parsed:
        return func.HttpResponse("month_key must look like 2026-07", status_code=400)
    year, month = parsed

    table = _table_client(MONTHLY_SCORES_TABLE)
    try:
        entity = table.get_entity(partition_key=str(year), row_key=f"M{month:02d}")
        body = _monthly_score_entity_dict(entity)
    except ResourceNotFoundError:
        body = _calc_monthly_score(year, month)
    return func.HttpResponse(json.dumps(body, ensure_ascii=False), mimetype="application/json")


@app.function_name(name="monthly-scores-recalculate")
@app.route(route="monthly-scores/recalculate", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def monthly_scores_recalculate(req: func.HttpRequest) -> func.HttpResponse:
    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    parsed = _parse_month_key(body.get("monthKey", ""))
    if not parsed:
        return func.HttpResponse("monthKey must look like 2026-07", status_code=400)
    year, month = parsed

    entity = _persist_monthly_score(year, month)
    return func.HttpResponse(
        json.dumps(_monthly_score_entity_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json"
    )


# ba-165④(2026-07-29確定、Takashi判断): 連続作業(streak)。同一作業(自己申告の文字列)を
# 5日連続で申告したらhigh(10点)を自動加点し、途切れたら振り出しに戻る。streak成立(5日目)は
# 週1回までしか加点しない(その週のうちに10日目・15日目…と伸びても2回目以降は加点しない)。
# 専用の状態テーブルは持たず、既にPointEventsにAxis="継続達成"で記録されているかを都度
# 週範囲で確認するだけにする(状態の単一の情報源をPointEventsに寄せる)。
STREAK_CHECKS_TABLE = "StreakChecks"
STREAK_PARTITION = "streak"
STREAK_LENGTH = 5
STREAK_DIFFICULTY = "high"
STREAK_AWARD_AXIS = "継続達成"


def _streak_check_dict(e):
    return {"task": e.get("Task", ""), "date": e.get("Date", ""), "createdAt": e.get("CreatedAt", "")}


def _streak_check_key(task, day):
    return f"{task}|{day.isoformat()}"


def _has_streak_check(table, task, day):
    try:
        table.get_entity(partition_key=STREAK_PARTITION, row_key=_streak_check_key(task, day))
        return True
    except ResourceNotFoundError:
        return False


def _streak_length_ending_at(table, task, end_day):
    """taskについて、end_dayから遡って連続で自己申告があった日数を数える。"""
    length = 0
    d = end_day
    while _has_streak_check(table, task, d):
        length += 1
        d = d - timedelta(days=1)
    return length


def _has_streak_award_this_week(point_events_table, task, on_day):
    """on_dayが属する週(JST月〜日)内に、このtaskの継続達成報酬が既に付与済みか。"""
    iso_year, iso_week, _ = on_day.isocalendar()
    start_utc, end_utc, _ = _week_bounds(iso_year, iso_week)
    prefix = f"{task}("
    for e in point_events_table.list_entities():
        if e.get("Axis") != STREAK_AWARD_AXIS or not e.get("Note", "").startswith(prefix):
            continue
        try:
            created_at = datetime.fromisoformat(e.get("CreatedAt", ""))
        except ValueError:
            continue
        if start_utc <= created_at < end_utc:
            return True
    return False


@app.function_name(name="streak-checks")
@app.route(route="streak-checks", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def streak_checks(req: func.HttpRequest) -> func.HttpResponse:
    table = _table_client(STREAK_CHECKS_TABLE)

    if req.method == "GET":
        items = [_streak_check_dict(e) for e in table.list_entities()]
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    task = (body.get("task") or "").strip()
    if not task:
        return func.HttpResponse("task is required", status_code=400)

    day_str = body.get("date") or datetime.now(JST).date().isoformat()
    try:
        day = date.fromisoformat(day_str)
    except ValueError:
        return func.HttpResponse("date must look like YYYY-MM-DD", status_code=400)

    entity = {
        "PartitionKey": STREAK_PARTITION,
        "RowKey": _streak_check_key(task, day),
        "Task": task,
        "Date": day.isoformat(),
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    }
    table.upsert_entity(entity)  # 同一task+dateの再送はupsertで無害(二重記録にならない)

    streak_len = _streak_length_ending_at(table, task, day)
    awarded = False
    if streak_len > 0 and streak_len % STREAK_LENGTH == 0:
        point_events_table = _table_client(POINT_EVENTS_TABLE)
        if not _has_streak_award_this_week(point_events_table, task, day):
            # 申告日(day)の正午JSTをCreatedAtに使う。実行時刻(datetime.now)をそのまま使うと、
            # 過去日付を後からまとめて申告した場合に週の境界判定がずれてしまうため。
            day_created_at = datetime(day.year, day.month, day.day, 12, tzinfo=JST).astimezone(timezone.utc)
            _create_point_event(
                STREAK_AWARD_AXIS, BA_DIFFICULTY_POINTS[STREAK_DIFFICULTY], f"{task}({streak_len}日連続)",
                period="week", catalog_id="daily_streak", created_at=day_created_at,
            )
            awarded = True

    return func.HttpResponse(
        json.dumps({**_streak_check_dict(entity), "streakLength": streak_len, "awarded": awarded}, ensure_ascii=False),
        status_code=201, mimetype="application/json",
    )


# 永続認証移行(ba-XX)。POSTはGoogle IDトークンを無期限の署名済みセッション
# トークンに交換し、DELETEはそのトークンを即座に失効させる(ログアウト)。
# SESSION_SECRETが未設定の間はこのエンドポイント自体が503を返すだけで、
# 既存のGoogle直接検証フローには一切影響しない。
@app.function_name(name="session")
@app.route(route="session", methods=["POST", "DELETE"], auth_level=func.AuthLevel.ANONYMOUS)
def session(req: func.HttpRequest) -> func.HttpResponse:
    if not SESSION_SECRET:
        return func.HttpResponse("session feature not configured", status_code=503)

    body = _get_body(req)
    credential = (body or {}).get("credential", "")
    table = _table_client(SESSIONS_TABLE)

    if req.method == "DELETE":
        session_id = _parse_session_token(credential)
        if not session_id:
            return func.HttpResponse("invalid credential", status_code=401)
        try:
            table.delete_entity(partition_key=SESSIONS_PARTITION, row_key=session_id)
        except Exception:
            pass
        return func.HttpResponse(status_code=204)

    # POST: 新規発行は必ず生のGoogle IDトークンからのみ行う(session:や manual:
    # トークンからの自己更新を許すと、一度発行した無期限トークンが無期限に延長
    # され続けてしまい、ログアウトによる失効の意味が薄れるため)。
    err = _verify_google_credential(credential)
    if err:
        return err

    session_id = secrets.token_urlsafe(24)
    table.upsert_entity({
        "PartitionKey": SESSIONS_PARTITION,
        "RowKey": session_id,
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    })
    return func.HttpResponse(
        json.dumps({"sessionToken": _make_session_token(session_id)}, ensure_ascii=False),
        status_code=201,
        mimetype="application/json",
    )


# src/common/last-updated.js用のプロキシ(ba-68/ba-69)。GitHubトークンを
# クライアント側のJSに一切埋め込まないため、サーバー側(ここ)でGitHub commits API
# を認証付きで叩き、結果だけをクライアントへ返す。GITHUB_TOKEN未設定でも動作する
# (その場合は未認証のままGitHub APIを叩く。既存の直接fetch版と同じ挙動)。
GITHUB_REPO = "moriyatakashi/aa"
_last_updated_cache = {}  # path -> (fetched_at: datetime, iso_date: str | None)
LAST_UPDATED_CACHE_TTL = timedelta(minutes=10)


@app.function_name(name="last-updated")
@app.route(route="last-updated", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def last_updated(req: func.HttpRequest) -> func.HttpResponse:
    path = req.params.get("path", "")
    # pathはGitHub API呼び出しにそのまま使うため、リポジトリ内のファイルパスとして
    # 妥当な文字種だけを許可する(このエンドポイントが任意URLへのオープンプロキシに
    # されるのを防ぐ)。".."セグメントも明示的に拒否する(文字種だけでは"../.."を防げないため)。
    if not path or not re.match(r"^[A-Za-z0-9_./-]+$", path) or ".." in path.split("/"):
        return func.HttpResponse("invalid path", status_code=400)

    now = datetime.now(timezone.utc)
    cached = _last_updated_cache.get(path)
    if cached and now - cached[0] < LAST_UPDATED_CACHE_TTL:
        return func.HttpResponse(json.dumps({"date": cached[1]}), mimetype="application/json")

    headers = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    try:
        resp = requests.get(
            f"https://api.github.com/repos/{GITHUB_REPO}/commits",
            params={"path": path, "per_page": 1},
            headers=headers,
            timeout=5,
        )
    except Exception:
        return func.HttpResponse(json.dumps({"date": None}), mimetype="application/json")

    if resp.status_code != 200:
        return func.HttpResponse(json.dumps({"date": None}), mimetype="application/json")

    data = resp.json()
    iso_date = data[0]["commit"]["committer"]["date"] if data else None
    _last_updated_cache[path] = (now, iso_date)
    return func.HttpResponse(json.dumps({"date": iso_date}), mimetype="application/json")


# ===== s1 / WIP作業台 (ba-200) — 追記ブロック。既存には一切触れない =====
# baから抽出したidに作業メタだけ別持ち。使い捨て前提・作り込まない。
# テーブルはハンドラ内で遅延生成(create_table_if_not_exists)。az CLI不要。
WIP_TASKS_TABLE = "WipTasks"
WIP_TASKS_PARTITION = "wip"


def _ensure_wip_table():
    # _table_service(グローバル)を初期化しつつ、無ければ空テーブルを作る(冪等)。
    _table_client(WIP_TASKS_TABLE)
    try:
        _table_service.create_table_if_not_exists(WIP_TASKS_TABLE)
    except Exception:
        pass
    return _table_client(WIP_TASKS_TABLE)


def _wip_task_dict(e):
    return {
        "baId": e["RowKey"],
        "seq": e.get("Seq"),
        "important": e.get("Important", False),
        "assignee": e.get("Assignee", ""),
        "plannedDate": e.get("PlannedDate", ""),
        "createdAt": e.get("CreatedAt", ""),
    }


@app.function_name(name="wip-tasks")
@app.route(route="s1", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def wip_tasks(req: func.HttpRequest) -> func.HttpResponse:
    # 段2a: GETのみ。閲覧はba GETと同様に無認証。書き込み(POST)は段2bで追加。
    table = _ensure_wip_table()
    items = [_wip_task_dict(e) for e in table.list_entities()]
    items.sort(key=lambda x: ((x.get("plannedDate") or ""), (x.get("createdAt") or "")))
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")
