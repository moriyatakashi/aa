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
# 一時的な緊急パスコード（Googleログインが使えない時の避難用）。
# Azure Function Appの環境変数に設定した場合のみ有効になる。未設定なら
# この経路は使われない（デフォルトでは何も変わらない、安全側）。
TEMP_PASSCODE = os.environ.get("TEMP_PASSCODE", "")
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
    TEMP_PASSCODEが設定されている場合のみ、"manual:<パスコード>"形式の
    credentialでも通す（Googleログインが壊れた時の一時避難用）。
    SESSION_SECRETが設定されている場合のみ、"session:<id>.<署名>"形式の
    永続セッショントークン（POST /api/sessionで発行）でも通す。"""
    credential = (body or {}).get("credential", "")
    if not credential:
        return func.HttpResponse("credential is required", status_code=401)

    if TEMP_PASSCODE and credential == f"manual:{TEMP_PASSCODE}":
        return None

    if SESSION_SECRET and credential.startswith("session:"):
        return _authorize_session(credential)

    return _verify_google_credential(credential)


VISITS_TABLE = "Visits"


def _visit_dict(e):
    return {
        "id": e["RowKey"],
        "place": e.get("Place", ""),
        "date": e.get("Date", ""),
        "time": e.get("Time", ""),
        "memo": e.get("Memo", ""),
        "lat": e.get("Lat"),
        "lng": e.get("Lng"),
        "createdAt": e.get("CreatedAt", ""),
    }


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

    entity = {
        "PartitionKey": "visit",
        "RowKey": str(uuid.uuid4()),
        "Place": place,
        "Date": body.get("date", ""),
        "Time": body.get("time", ""),
        "Memo": body.get("memo", ""),
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    }
    if body.get("lat") is not None:
        entity["Lat"] = float(body["lat"])
    if body.get("lng") is not None:
        entity["Lng"] = float(body["lng"])
    table.upsert_entity(entity)

    return func.HttpResponse(json.dumps(_visit_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json")


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
BA_HUMAN_ALLOWED_TYPES = {"new", "note", "void", "status"}
BA_DEVICE_VERIFIED_TYPES = {"verified_on_device"}
# ba-53: スレッドクローズの難易度別得点(週次得点で使う)。
BA_DIFFICULTY_POINTS = {"low": 2, "normal": 5, "high": 10}
BA_DEFAULT_DIFFICULTY = "normal"


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

    # 疎通確認用: dry_run=trueなら鍵・種別の検証だけ行い、台帳には書き込まない(ba-5)。
    if body.get("dry_run"):
        return func.HttpResponse(
            json.dumps({"dry_run": True, "by": by, "type": entry_type}, ensure_ascii=False),
            mimetype="application/json",
        )

    ref = (body.get("ref") or "").strip()
    if entry_type == "new":
        ref = ""  # newは常に新規スレッドの起点にする

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

    ba_table = _table_client(BA_TABLE)
    breakdown = {"low": 0, "normal": 0, "high": 0}
    close_count = 0
    close_value = 0
    for e in ba_table.list_entities():
        if e.get("Type") != "status":
            continue
        data = json.loads(e.get("Data") or "{}")
        if data.get("status") != "closed":
            continue
        try:
            created_at = datetime.fromisoformat(e.get("CreatedAt", ""))
        except ValueError:
            continue
        if not (start_utc <= created_at < end_utc):
            continue

        thread_id = e["PartitionKey"]
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
        close_value += BA_DIFFICULTY_POINTS[difficulty]

    return {
        "year": iso_year,
        "week": iso_week,
        "weekKey": f"{iso_year}-W{iso_week:02d}",
        "weekStart": monday.isoformat(),
        "weekEnd": (monday + timedelta(days=6)).isoformat(),
        "dailyScoreSum": daily_score_sum,
        "closeCount": close_count,
        "closeValue": close_value,
        "breakdownByDifficulty": breakdown,
        "weekScore": daily_score_sum + close_value,
        "calculatedAt": None,
    }


def _weekly_score_entity_dict(e):
    return {
        "year": int(e["PartitionKey"]),
        "week": e.get("Week"),
        "weekKey": f"{e['PartitionKey']}-W{e.get('Week', 0):02d}",
        "weekStart": e.get("WeekStart", ""),
        "weekEnd": e.get("WeekEnd", ""),
        "dailyScoreSum": e.get("DailyScoreSum", 0),
        "closeCount": e.get("CloseCount", 0),
        "closeValue": e.get("CloseValue", 0),
        "breakdownByDifficulty": json.loads(e.get("BreakdownByDifficulty") or "{}"),
        "weekScore": e.get("WeekScore", 0),
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
