import json
from datetime import datetime, timezone

import azure.functions as func

import function_app

bp = func.Blueprint()

SCORES_TABLE = "Scores"


def _score_dict(e):
    return {"score": e.get("Score", 0), "note": e.get("Note", ""), "createdAt": e.get("CreatedAt", "")}


@bp.function_name(name="scores")
@bp.route(route="scores", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def scores(req: func.HttpRequest) -> func.HttpResponse:
    # ba-35残課題(2): 閲覧はログイン不要にする(2026-07-20)。書き込み(PUT)は引き続き認証必須。
    table = function_app._table_client(SCORES_TABLE)
    items = [{"date": e["RowKey"], **_score_dict(e)} for e in table.list_entities()]
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


@bp.function_name(name="scores-item")
@bp.route(route="scores/{date}", methods=["GET", "PUT"], auth_level=func.AuthLevel.ANONYMOUS)
def scores_item(req: func.HttpRequest) -> func.HttpResponse:
    date = req.route_params.get("date")
    table = function_app._table_client(SCORES_TABLE)

    if req.method == "GET":
        # ba-35残課題(2): 閲覧はログイン不要にする(2026-07-20)。書き込み(PUT)は引き続き認証必須。
        try:
            body = _score_dict(table.get_entity(partition_key="score", row_key=date))
        except Exception:
            body = None
        return func.HttpResponse(json.dumps(body, ensure_ascii=False), mimetype="application/json")

    body = function_app._get_body(req)
    err = function_app._authorize(body)
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
