import json
import os
import uuid
from datetime import datetime, timezone

import azure.functions as func
import requests
from azure.data.tables import TableServiceClient

app = func.FunctionApp()

CONN_STR = os.environ["TABLE_CONNECTION_STRING"]
GOOGLE_CLIENT_ID = os.environ["GOOGLE_CLIENT_ID"]
ALLOWED_EMAIL = os.environ["ALLOWED_EMAIL"]
# 一時的な緊急パスコード（Googleログインが使えない時の避難用）。
# Azure Function Appの環境変数に設定した場合のみ有効になる。未設定なら
# この経路は使われない（デフォルトでは何も変わらない、安全側）。
TEMP_PASSCODE = os.environ.get("TEMP_PASSCODE", "")


def _table_client(table_name):
    service = TableServiceClient.from_connection_string(CONN_STR)
    return service.get_table_client(table_name)


def _get_body(req):
    try:
        return req.get_json()
    except ValueError:
        return {}


def _authorize(body):
    """ab個人データの書き込みをALLOWED_EMAIL本人のGoogleログインのみに制限する。
    問題なければNone、問題があればそのまま返すHttpResponseを返す。
    TEMP_PASSCODEが設定されている場合のみ、"manual:<パスコード>"形式の
    credentialでも通す（Googleログインが壊れた時の一時避難用）。"""
    credential = (body or {}).get("credential", "")
    if not credential:
        return func.HttpResponse("credential is required", status_code=401)

    if TEMP_PASSCODE and credential == f"manual:{TEMP_PASSCODE}":
        return None

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
    if payload.get("email_verified") != "true" or payload.get("email", "").lower() != ALLOWED_EMAIL.lower():
        return func.HttpResponse("forbidden", status_code=403)
    return None


CHECKS_TABLE = "Checks"


def _check_dict(e):
    return {
        "crossedMidnight": e.get("CrossedMidnight", False),
        "ateMeal": e.get("AteMeal", False),
        "reviewDate": e.get("ReviewDate", ""),
        "updatedAt": e.get("UpdatedAt", ""),
    }


@app.function_name(name="checks")
@app.route(route="checks", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def checks(req: func.HttpRequest) -> func.HttpResponse:
    table = _table_client(CHECKS_TABLE)
    items = [{"date": e["RowKey"], **_check_dict(e)} for e in table.list_entities()]
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


@app.function_name(name="checks-item")
@app.route(route="checks/{date}", methods=["GET", "PUT"], auth_level=func.AuthLevel.ANONYMOUS)
def checks_item(req: func.HttpRequest) -> func.HttpResponse:
    date = req.route_params.get("date")
    table = _table_client(CHECKS_TABLE)

    if req.method == "GET":
        try:
            body = _check_dict(table.get_entity(partition_key="check", row_key=date))
        except Exception:
            body = None
        return func.HttpResponse(json.dumps(body, ensure_ascii=False), mimetype="application/json")

    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    entity = {"PartitionKey": "check", "RowKey": date}
    if "crossedMidnight" in body:
        entity["CrossedMidnight"] = bool(body["crossedMidnight"])
    if "ateMeal" in body:
        entity["AteMeal"] = bool(body["ateMeal"])
    if "reviewDate" in body:
        entity["ReviewDate"] = body["reviewDate"] or ""
    entity["UpdatedAt"] = datetime.now(timezone.utc).isoformat()
    table.upsert_entity(entity)

    return func.HttpResponse(json.dumps(_check_dict(table.get_entity(partition_key="check", row_key=date)), ensure_ascii=False), mimetype="application/json")


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
    table = _table_client(SCORES_TABLE)
    items = [{"date": e["RowKey"], **_score_dict(e)} for e in table.list_entities()]
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


@app.function_name(name="scores-item")
@app.route(route="scores/{date}", methods=["GET", "PUT"], auth_level=func.AuthLevel.ANONYMOUS)
def scores_item(req: func.HttpRequest) -> func.HttpResponse:
    date = req.route_params.get("date")
    table = _table_client(SCORES_TABLE)

    if req.method == "GET":
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
    return func.HttpResponse(json.dumps(_score_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json")


# n4(気づきログ)。1件=1つの出来事(new/note/correction/priority/status/void/...)を
# 追記していくだけの台帳。過去の行は書き換えない(赤黒帳票方式)。
# PartitionKey=スレッド起点のid、RowKey=その出来事自身のid。
# 種別ごとに変わる中身(body/tags/value/reasonなど)は固定カラムにせず、Dataに
# JSONのまま自由に持たせる(骨組みだけ決めて中身は増やせるようにする)。
N4_TABLE = "N4Log"
N4_HUMAN_ALLOWED_TYPES = {"new", "note", "void", "status"}


def _n4_entry_dict(e):
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


def _next_n4_seq(table):
    """会話で「n4-7」のように参照できる、スレッド起点(new)専用の連番。
    低頻度な個人利用のため、既存最大値+1という単純な採番(排他制御なし)で十分とした。"""
    existing = [e.get("Seq") for e in table.query_entities("Type eq 'new'") if e.get("Seq") is not None]
    return (max(existing) if existing else 0) + 1


@app.function_name(name="n4-log")
@app.route(route="n4", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def n4_log(req: func.HttpRequest) -> func.HttpResponse:
    table = _table_client(N4_TABLE)

    if req.method == "GET":
        claude_key = req.headers.get("X-Claude-Key", "")
        n4_claude_key = os.environ.get("N4_CLAUDE_KEY", "")
        if not (claude_key and n4_claude_key and claude_key == n4_claude_key):
            err = _authorize({"credential": req.headers.get("X-N4-Credential", "")})
            if err:
                return err
        items = [_n4_entry_dict(e) for e in table.list_entities()]
        items.sort(key=lambda x: x["createdAt"])
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = _get_body(req)

    # Claude Codeレーン: n4専用の鍵。有効なら種別自由、そうでなければ人間レーン(Googleログイン)を試す。
    claude_key = body.get("claude_key", "")
    n4_claude_key = os.environ.get("N4_CLAUDE_KEY", "")
    if claude_key and n4_claude_key and claude_key == n4_claude_key:
        by = "claude"
    else:
        err = _authorize(body)
        if err:
            return err
        by = "takashi"

    entry_type = body.get("type") or "new"
    if by == "takashi" and entry_type not in N4_HUMAN_ALLOWED_TYPES:
        return func.HttpResponse(
            f"human lane can only write: {', '.join(sorted(N4_HUMAN_ALLOWED_TYPES))}",
            status_code=400,
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
        entity["Seq"] = _next_n4_seq(table)
    table.upsert_entity(entity)
    return func.HttpResponse(json.dumps(_n4_entry_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json")
