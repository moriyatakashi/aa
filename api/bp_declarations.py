import json
import uuid
from datetime import datetime, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError

import function_app
from bp_points import _create_point_event
from bp_scoring_rules import JST, _parse_week_key, _week_bounds

bp = func.Blueprint()

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


@bp.function_name(name="declarations")
@bp.route(route="declarations", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def declarations(req: func.HttpRequest) -> func.HttpResponse:
    table = function_app._table_client(DECLARATIONS_TABLE)

    if req.method == "GET":
        items = [_declaration_dict(e) for e in table.list_entities()]
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = function_app._get_body(req)
    err = function_app._authorize(body)
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


@bp.function_name(name="declarations-achieve")
@bp.route(route="declarations/{decl_id}/achieve", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def declarations_achieve(req: func.HttpRequest) -> func.HttpResponse:
    decl_id = req.route_params.get("decl_id")
    body = function_app._get_body(req)
    err = function_app._authorize(body)
    if err:
        return err

    table = function_app._table_client(DECLARATIONS_TABLE)
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
