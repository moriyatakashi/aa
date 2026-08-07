import json
from datetime import datetime, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError

import function_app
from bp_points import POINT_EVENTS_TABLE
from bp_scoring_rules import JST

bp = func.Blueprint()

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
    point_events_table = function_app._table_client(POINT_EVENTS_TABLE)
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
    function_app._table_client(MONTHLY_SCORES_TABLE).upsert_entity(entity)
    return entity


@bp.function_name(name="monthly-scores")
@bp.route(route="monthly-scores", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def monthly_scores(req: func.HttpRequest) -> func.HttpResponse:
    table = function_app._table_client(MONTHLY_SCORES_TABLE)
    items = [_monthly_score_entity_dict(e) for e in table.list_entities()]
    items.sort(key=lambda x: x["monthKey"])
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


@bp.function_name(name="monthly-scores-item")
@bp.route(route="monthly-scores/{month_key}", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def monthly_scores_item(req: func.HttpRequest) -> func.HttpResponse:
    month_key = req.route_params.get("month_key")
    parsed = _parse_month_key(month_key)
    if not parsed:
        return func.HttpResponse("month_key must look like 2026-07", status_code=400)
    year, month = parsed

    table = function_app._table_client(MONTHLY_SCORES_TABLE)
    try:
        entity = table.get_entity(partition_key=str(year), row_key=f"M{month:02d}")
        body = _monthly_score_entity_dict(entity)
    except ResourceNotFoundError:
        body = _calc_monthly_score(year, month)
    return func.HttpResponse(json.dumps(body, ensure_ascii=False), mimetype="application/json")


@bp.function_name(name="monthly-scores-recalculate")
@bp.route(route="monthly-scores/recalculate", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def monthly_scores_recalculate(req: func.HttpRequest) -> func.HttpResponse:
    body = function_app._get_body(req)
    err = function_app._authorize(body)
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
