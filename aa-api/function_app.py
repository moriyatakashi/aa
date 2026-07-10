import json
import os
import re
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
TABLE_NAME = "Messages"
MAX_COMMENT_LENGTH = 500


def _table_client(table_name=TABLE_NAME):
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


def _list_entities(table_name, fields):
    table = _table_client(table_name)
    items = [
        {"id": e["RowKey"], **{f: e.get(f, "") for f in fields}}
        for e in table.list_entities()
    ]
    items.sort(key=lambda x: x.get("CreatedAt", ""), reverse=True)
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


def _get_hi(table_name):
    table = _table_client(table_name)
    try:
        e = table.get_entity(partition_key="hi", row_key="record")
        body = {"Score": e.get("Score", 0), "Date": e.get("Date", "")}
    except Exception:
        body = None
    return func.HttpResponse(json.dumps(body, ensure_ascii=False), mimetype="application/json")


def _save_score(req, hist_table, hi_table, extra_map, require_auth=True):
    body = _get_body(req)
    if require_auth:
        err = _authorize(body)
        if err:
            return err

    score = body.get("score")
    if not isinstance(score, (int, float)) or isinstance(score, bool) or score < 0:
        return func.HttpResponse("score must be a non-negative number", status_code=400)
    date = body.get("date") or datetime.now(timezone.utc).strftime("%Y-%m-%d")

    entity = {
        "PartitionKey": "history",
        "RowKey": str(uuid.uuid4()),
        "Score": score,
        "Date": date,
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    }
    for json_key, table_key in extra_map:
        if json_key in body:
            entity[table_key] = body[json_key]
    _table_client(hist_table).upsert_entity(entity)

    hi_client = _table_client(hi_table)
    hi_score = 0
    try:
        hi_score = hi_client.get_entity(partition_key="hi", row_key="record").get("Score", 0)
    except Exception:
        pass
    if score > hi_score:
        hi_score = score
        hi_client.upsert_entity({"PartitionKey": "hi", "RowKey": "record", "Score": score, "Date": date})

    return func.HttpResponse(json.dumps({"hiScore": hi_score}, ensure_ascii=False), status_code=201, mimetype="application/json")


@app.function_name(name="invader-history")
@app.route(route="invader-history", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def invader_history(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "GET":
        return _list_entities("InvaderHistory", ["Score", "Date", "CreatedAt", "Wave"])
    return _save_score(req, "InvaderHistory", "InvaderHi", [("wave", "Wave")])


@app.function_name(name="invader-hi")
@app.route(route="invader-hi", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def invader_hi(req: func.HttpRequest) -> func.HttpResponse:
    return _get_hi("InvaderHi")


@app.function_name(name="runner-history")
@app.route(route="runner-history", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def runner_history(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "GET":
        return _list_entities("RunnerHistory", ["Score", "Date", "CreatedAt", "Coins", "Level"])
    return _save_score(req, "RunnerHistory", "RunnerHi", [("coins", "Coins"), ("level", "Level")])


@app.function_name(name="runner-hi")
@app.route(route="runner-hi", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def runner_hi(req: func.HttpRequest) -> func.HttpResponse:
    return _get_hi("RunnerHi")


def _delete_all(table_name):
    table = _table_client(table_name)
    count = 0
    for e in list(table.list_entities()):
        table.delete_entity(partition_key=e["PartitionKey"], row_key=e["RowKey"])
        count += 1
    return func.HttpResponse(json.dumps({"deleted": count}, ensure_ascii=False), mimetype="application/json")


def _delete_hi(table_name):
    table = _table_client(table_name)
    try:
        table.delete_entity(partition_key="hi", row_key="record")
    except Exception:
        pass
    return func.HttpResponse(json.dumps({"deleted": True}, ensure_ascii=False), mimetype="application/json")


@app.function_name(name="libtest-history")
@app.route(route="libtest-history", methods=["GET", "POST", "DELETE"], auth_level=func.AuthLevel.ANONYMOUS)
def libtest_history(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "GET":
        return _list_entities("LibTestHistory", ["Score", "Date", "CreatedAt"])
    if req.method == "DELETE":
        return _delete_all("LibTestHistory")
    return _save_score(req, "LibTestHistory", "LibTestHi", [], require_auth=False)


@app.function_name(name="libtest-hi")
@app.route(route="libtest-hi", methods=["GET", "DELETE"], auth_level=func.AuthLevel.ANONYMOUS)
def libtest_hi(req: func.HttpRequest) -> func.HttpResponse:
    if req.method == "DELETE":
        return _delete_hi("LibTestHi")
    return _get_hi("LibTestHi")


TASKS_TABLE = "Tasks"


@app.function_name(name="tasks")
@app.route(route="tasks", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def tasks(req: func.HttpRequest) -> func.HttpResponse:
    table = _table_client(TASKS_TABLE)

    if req.method == "GET":
        items = [
            {
                "id": e["RowKey"],
                "col1": e.get("Col1", ""),
                "col2": e.get("Col2", ""),
                "col3": e.get("Col3", ""),
                "createdAt": e.get("CreatedAt", ""),
            }
            for e in table.list_entities()
        ]
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    col1 = (body.get("col1") or "").strip()
    if not col1:
        return func.HttpResponse("col1 is required", status_code=400)

    entity = {
        "PartitionKey": "task",
        "RowKey": str(uuid.uuid4()),
        "Col1": col1,
        "Col2": body.get("col2", ""),
        "Col3": body.get("col3", ""),
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    }
    table.upsert_entity(entity)
    return func.HttpResponse(
        json.dumps({
            "id": entity["RowKey"], "col1": entity["Col1"], "col2": entity["Col2"],
            "col3": entity["Col3"], "createdAt": entity["CreatedAt"],
        }, ensure_ascii=False),
        status_code=201, mimetype="application/json",
    )


@app.function_name(name="tasks-item")
@app.route(route="tasks/{id}", methods=["PUT", "DELETE"], auth_level=func.AuthLevel.ANONYMOUS)
def tasks_item(req: func.HttpRequest) -> func.HttpResponse:
    task_id = req.route_params.get("id")
    table = _table_client(TASKS_TABLE)

    if req.method == "DELETE":
        body = _get_body(req)
        err = _authorize(body)
        if err:
            return err
        try:
            table.delete_entity(partition_key="task", row_key=task_id)
        except Exception:
            pass
        return func.HttpResponse(json.dumps({"deleted": True}, ensure_ascii=False), mimetype="application/json")

    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    col1 = (body.get("col1") or "").strip()
    if not col1:
        return func.HttpResponse("col1 is required", status_code=400)

    try:
        entity = table.get_entity(partition_key="task", row_key=task_id)
    except Exception:
        return func.HttpResponse("not found", status_code=404)

    entity["Col1"] = col1
    entity["Col2"] = body.get("col2", entity.get("Col2", ""))
    table.upsert_entity(entity)
    return func.HttpResponse(json.dumps({"updated": True}, ensure_ascii=False), mimetype="application/json")


CHECKS_TABLE = "Checks"
REVIEWS_TABLE = "Reviews"


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


@app.function_name(name="reviews")
@app.route(route="reviews", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def reviews(req: func.HttpRequest) -> func.HttpResponse:
    table = _table_client(REVIEWS_TABLE)
    items = [
        {"date": e["RowKey"], "score": e.get("Score", 0), "createdAt": e.get("CreatedAt", "")}
        for e in table.list_entities()
    ]
    items.sort(key=lambda x: x["date"], reverse=True)
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


@app.function_name(name="reviews-item")
@app.route(route="reviews/{date}", methods=["PUT"], auth_level=func.AuthLevel.ANONYMOUS)
def reviews_item(req: func.HttpRequest) -> func.HttpResponse:
    date = req.route_params.get("date")
    body = _get_body(req)
    err = _authorize(body)
    if err:
        return err

    score = body.get("score")
    if not isinstance(score, (int, float)) or isinstance(score, bool) or not (0 <= score <= 100):
        return func.HttpResponse("score must be a number between 0 and 100", status_code=400)

    entity = {
        "PartitionKey": "review",
        "RowKey": date,
        "Score": score,
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    }
    _table_client(REVIEWS_TABLE).upsert_entity(entity)
    return func.HttpResponse(
        json.dumps({"date": date, "score": score, "createdAt": entity["CreatedAt"]}, ensure_ascii=False),
        status_code=201, mimetype="application/json",
    )


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


@app.function_name(name="messages")
@app.route(route="messages", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def messages(req: func.HttpRequest) -> func.HttpResponse:
    table = _table_client()

    if req.method == "GET":
        items = [
            {
                "Name": e.get("Name", ""),
                "Comment": e.get("Comment", ""),
                "CreatedAt": e.get("CreatedAt", ""),
            }
            for e in table.list_entities()
        ]
        items.sort(key=lambda x: x["CreatedAt"], reverse=True)
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    try:
        body = req.get_json()
    except ValueError:
        return func.HttpResponse("invalid json", status_code=400)

    credential = body.get("credential", "")
    comment = (body.get("comment") or "").strip()

    if not credential or not comment:
        return func.HttpResponse("credential and comment are required", status_code=400)
    if len(comment) > MAX_COMMENT_LENGTH:
        return func.HttpResponse(f"comment too long (max {MAX_COMMENT_LENGTH})", status_code=400)

    resp = requests.get(
        "https://oauth2.googleapis.com/tokeninfo",
        params={"id_token": credential},
        timeout=5,
    )
    if resp.status_code != 200:
        return func.HttpResponse("invalid google credential", status_code=401)

    payload = resp.json()
    if payload.get("aud") != GOOGLE_CLIENT_ID:
        return func.HttpResponse("token audience mismatch", status_code=401)

    name = payload.get("name") or payload.get("email", "").split("@")[0] or "anonymous"

    entity = {
        "PartitionKey": "board",
        "RowKey": str(uuid.uuid4()),
        "Name": name,
        "Comment": comment,
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    }
    table.upsert_entity(entity)

    return func.HttpResponse(json.dumps(entity, ensure_ascii=False), status_code=201, mimetype="application/json")


# ── a5 SQLコンソール（a1のFirestore版に対応するTable Storage版） ──────────
# a1のSQLコンソールと同じINSERT/UPDATE/DELETE/TRUNCATE構文を、
# a5が表示している4テーブルに限定して受け付ける。書き込みはab本人限定
# （Googleログインのcredentialが必要）。
TABLE_SQL_ALLOWED = {
    "InvaderHistory": "history",
    "RunnerHistory": "history",
    "InvaderHi": "hi",
    "RunnerHi": "hi",
    "Scores": "score",
}
TABLE_SQL_NUMERIC_FIELDS = {"Score", "Wave", "Coins", "Level"}
_SQL_ARG_RE = re.compile(r'([\w]+)=(?:"([^"]*)"|([^\s]*))')
_SQL_LINE_RE = re.compile(r'^(\S+)\s+(\S+)\s*(.*)$')


def _sql_parse_args(s):
    args = {}
    for m in _SQL_ARG_RE.finditer(s):
        args[m.group(1)] = m.group(2) if m.group(2) is not None else m.group(3)
    return args


def _sql_cast(field, value):
    if field in TABLE_SQL_NUMERIC_FIELDS:
        try:
            return int(value)
        except ValueError:
            try:
                return float(value)
            except ValueError:
                return value
    return value


def _sql_field_name(key):
    # Score/Date/Wave/Coins/Level はそのまま、それ以外は先頭大文字化
    return key[0].upper() + key[1:] if key else key


def _sql_select(table_name):
    """1テーブル分のSELECT結果（id + フィールド一覧）を返す"""
    partition = TABLE_SQL_ALLOWED[table_name]
    table = _table_client(table_name)
    if partition == "hi":
        try:
            e = table.get_entity(partition_key="hi", row_key="record")
            rows = [{"Score": e.get("Score", 0), "Date": e.get("Date", "")}]
        except Exception:
            rows = []
    else:
        skip = {"PartitionKey", "RowKey", "Timestamp", "etag"}
        rows = [
            {"id": e["RowKey"], **{k: v for k, v in e.items() if k not in skip}}
            for e in table.list_entities()
        ]
        rows.sort(key=lambda x: x.get("CreatedAt", ""), reverse=True)
    return rows


def _sql_infer_type(val):
    if val is None:
        return "null"
    if isinstance(val, bool):
        return "boolean"
    if isinstance(val, int):
        return "integer"
    if isinstance(val, float):
        return "double"
    if isinstance(val, str):
        if re.match(r'^\d{4}-\d{2}-\d{2}$', val):
            return "string (date-like)"
        if re.match(r'^\d+$', val):
            return "string (numeric)"
        return "string"
    return "unknown"


def _sql_describe(table_name):
    """1テーブル分の定義情報（フィールド名・推定型・件数）を返す"""
    partition = TABLE_SQL_ALLOWED[table_name]
    table = _table_client(table_name)
    skip = {"PartitionKey", "RowKey", "Timestamp", "etag"}

    if partition == "hi":
        try:
            entities = [table.get_entity(partition_key="hi", row_key="record")]
        except Exception:
            entities = []
    else:
        entities = list(table.list_entities())

    field_types = {}
    for e in entities:
        for k, v in e.items():
            if k in skip:
                continue
            field_types.setdefault(k, set()).add(_sql_infer_type(v))

    fields = [{"name": k, "type": "/".join(sorted(v))} for k, v in field_types.items()]
    return {"count": len(entities), "fields": fields}


@app.function_name(name="table-sql")
@app.route(route="table-sql", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def table_sql(req: func.HttpRequest) -> func.HttpResponse:
    body = _get_body(req)

    raw = (body.get("sql") or "").strip()
    if not raw:
        return func.HttpResponse("sql is required", status_code=400)

    lines = [l.strip() for l in raw.split("\n") if l.strip() and not l.strip().startswith("--")]

    # SELECT/DESCRIBE以外のコマンドが1つでも含まれる場合のみ、Googleログイン(本人限定)を要求する
    READONLY_CMDS = {"SELECT", "DESCRIBE"}
    needs_auth = any(
        (m := _SQL_LINE_RE.match(line)) and m.group(1).upper() not in READONLY_CMDS
        for line in lines
    )
    if needs_auth:
        err = _authorize(body)
        if err:
            return err

    log = []
    ok_count = 0
    err_count = 0
    results = []

    for line in lines:
        m = _SQL_LINE_RE.match(line)
        if not m:
            log.append({"ok": False, "msg": f"構文不明: {line}"})
            err_count += 1
            continue

        cmd, table_name, rest = m.group(1).upper(), m.group(2), m.group(3)

        if cmd == "SELECT":
            targets = list(TABLE_SQL_ALLOWED.keys()) if table_name == "*" else [table_name]
            for t in targets:
                if t not in TABLE_SQL_ALLOWED:
                    log.append({"ok": False, "msg": f"未対応テーブル: {t}"})
                    err_count += 1
                    continue
                rows = _sql_select(t)
                results.append({"type": "select", "table": t, "rows": rows})
                log.append({"ok": True, "msg": f"SELECT {t} → {len(rows)}件"})
                ok_count += 1
            continue

        if cmd == "DESCRIBE":
            targets = list(TABLE_SQL_ALLOWED.keys()) if table_name == "*" else [table_name]
            for t in targets:
                if t not in TABLE_SQL_ALLOWED:
                    log.append({"ok": False, "msg": f"未対応テーブル: {t}"})
                    err_count += 1
                    continue
                desc = _sql_describe(t)
                results.append({"type": "schema", "table": t, **desc})
                log.append({"ok": True, "msg": f"DESCRIBE {t} → フィールド{len(desc['fields'])}件"})
                ok_count += 1
            continue

        if table_name not in TABLE_SQL_ALLOWED:
            log.append({"ok": False, "msg": f"未対応テーブル: {table_name}"})
            err_count += 1
            continue

        partition = TABLE_SQL_ALLOWED[table_name]
        args = _sql_parse_args(rest)
        table = _table_client(table_name)

        try:
            if cmd == "INSERT":
                if partition == "history":
                    row_key = args.get("id") or str(uuid.uuid4())
                elif partition == "hi":
                    row_key = args.get("id") or "record"
                else:
                    row_key = args.get("id")
                    if not row_key:
                        raise ValueError("id=（Scoresの場合はid=日付）が必要です")
                entity = {"PartitionKey": partition, "RowKey": row_key}
                for k, v in args.items():
                    if k == "id":
                        continue
                    field = _sql_field_name(k)
                    entity[field] = _sql_cast(field, v)
                entity.setdefault("CreatedAt", datetime.now(timezone.utc).isoformat())
                table.upsert_entity(entity)
                log.append({"ok": True, "msg": f"INSERT → {table_name}/{row_key}"})
                ok_count += 1

            elif cmd == "UPDATE":
                row_key = args.get("id") or ("record" if partition == "hi" else None)
                if not row_key:
                    raise ValueError("id= が必要です（history系テーブル）")
                try:
                    entity = table.get_entity(partition_key=partition, row_key=row_key)
                except Exception:
                    raise ValueError(f"該当行が見つかりません: {row_key}")
                for k, v in args.items():
                    if k == "id":
                        continue
                    field = _sql_field_name(k)
                    entity[field] = _sql_cast(field, v)
                table.upsert_entity(entity)
                log.append({"ok": True, "msg": f"UPDATE → {table_name}/{row_key}"})
                ok_count += 1

            elif cmd == "DELETE":
                row_key = args.get("id") or ("record" if partition == "hi" else None)
                if not row_key:
                    raise ValueError("id= が必要です（history系テーブル）")
                table.delete_entity(partition_key=partition, row_key=row_key)
                log.append({"ok": True, "msg": f"DELETE → {table_name}/{row_key}"})
                ok_count += 1

            elif cmd == "TRUNCATE":
                count = 0
                for e in list(table.list_entities()):
                    table.delete_entity(partition_key=e["PartitionKey"], row_key=e["RowKey"])
                    count += 1
                log.append({"ok": True, "msg": f"TRUNCATE → {table_name} ({count}件削除)"})
                ok_count += 1

            else:
                log.append({"ok": False, "msg": f"未対応コマンド: {cmd}"})
                err_count += 1

        except Exception as e:
            log.append({"ok": False, "msg": f"{line} → {e}"})
            err_count += 1

    return func.HttpResponse(
        json.dumps(
            {"log": log, "ok": ok_count, "err": err_count, "results": results},
            ensure_ascii=False,
        ),
        mimetype="application/json",
    )
