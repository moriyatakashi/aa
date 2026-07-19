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
    # 「トークンは有効だが本人ではない」ことを403で区別すると、有効なGoogle
    # アカウントを持つ第三者が「自分は認証済みだが権限がない」ことを判別できて
    # しまう。本人以外は常に401にして、無効トークンと見分けがつかないようにする。
    if payload.get("email_verified") != "true" or payload.get("email", "").lower() != ALLOWED_EMAIL.lower():
        return func.HttpResponse("invalid credential", status_code=401)
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
    err = _authorize({"credential": req.headers.get("X-Checks-Credential", "")})
    if err:
        return err
    table = _table_client(CHECKS_TABLE)
    items = [{"date": e["RowKey"], **_check_dict(e)} for e in table.list_entities()]
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


@app.function_name(name="checks-item")
@app.route(route="checks/{date}", methods=["GET", "PUT"], auth_level=func.AuthLevel.ANONYMOUS)
def checks_item(req: func.HttpRequest) -> func.HttpResponse:
    date = req.route_params.get("date")
    table = _table_client(CHECKS_TABLE)

    if req.method == "GET":
        err = _authorize({"credential": req.headers.get("X-Checks-Credential", "")})
        if err:
            return err
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
        err = _authorize({"credential": req.headers.get("X-Visits-Credential", "")})
        if err:
            return err
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
    err = _authorize({"credential": req.headers.get("X-Scores-Credential", "")})
    if err:
        return err
    table = _table_client(SCORES_TABLE)
    items = [{"date": e["RowKey"], **_score_dict(e)} for e in table.list_entities()]
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


@app.function_name(name="scores-item")
@app.route(route="scores/{date}", methods=["GET", "PUT"], auth_level=func.AuthLevel.ANONYMOUS)
def scores_item(req: func.HttpRequest) -> func.HttpResponse:
    date = req.route_params.get("date")
    table = _table_client(SCORES_TABLE)

    if req.method == "GET":
        err = _authorize({"credential": req.headers.get("X-Scores-Credential", "")})
        if err:
            return err
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


# ba(n4の後継)。骨組みはn4と同じ追記オンリー台帳だが、Claude Codeレーンを
# スマホ/PCで別鍵にし、"実機/実ブラウザで確認できた"ことを主張する種別
# (verified_on_device)だけはPCレーンのみ書き込み可にする。
BA_TABLE = "BaLog"
BA_HUMAN_ALLOWED_TYPES = {"new", "note", "void", "status"}
BA_DEVICE_VERIFIED_TYPES = {"verified_on_device"}


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
    書き込みが遅くなるため、O(1)のカウンタ読み書きに変更した。"""
    try:
        current = table.get_entity(partition_key=BA_SEQ_PARTITION, row_key=BA_SEQ_ROW).get("Value", 0)
    except Exception:
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
