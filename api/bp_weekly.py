import json
from datetime import datetime, timedelta, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError

import function_app
from bp_ba import BA_DEFAULT_DIFFICULTY, BA_DIFFICULTY_POINTS, BA_TABLE, _ba_close_transitions
from bp_points import POINT_EVENTS_TABLE
from bp_scores_daily import SCORES_TABLE
from bp_scoring_rules import (
    SCORING_RULES_TABLE,
    _latest_scoring_rule,
    _parse_week_key,
    _scoring_rule_at,
    _seed_scoring_rules_if_empty,
    _week_bounds,
    _week_row_key,
)

bp = func.Blueprint()

WEEKLY_SCORES_TABLE = "WeeklyScores"


def _calc_weekly_score(iso_year, iso_week):
    """指定週の週次得点を、Scores(毎日スコア)とBaLog(クローズ)から都度計算する。
    永続化はせず、呼び出し元(GET detailまたはrecalculate)が必要に応じて保存する。"""
    start_utc, end_utc, monday = _week_bounds(iso_year, iso_week)
    week_dates = [(monday + timedelta(days=i)).isoformat() for i in range(7)]

    scores_table = function_app._table_client(SCORES_TABLE)
    daily_score_sum = 0
    for d in week_dates:
        try:
            entity = scores_table.get_entity(partition_key="score", row_key=d)
        except ResourceNotFoundError:
            continue
        daily_score_sum += entity.get("Score", 0)

    # ba-159: その週の月曜日時点で有効だった配点(当時のルール)と、現在最新の配点
    # (「当時の基準だとこう」の比較用)の両方を使う。
    scoring_rules_table = function_app._table_client(SCORING_RULES_TABLE)
    _seed_scoring_rules_if_empty(scoring_rules_table)
    active_rule = _scoring_rule_at(scoring_rules_table, monday.isoformat())
    latest_rule = _latest_scoring_rule(scoring_rules_table)

    ba_table = function_app._table_client(BA_TABLE)
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
    point_events_table = function_app._table_client(POINT_EVENTS_TABLE)
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
    scoring_rules_table = function_app._table_client(SCORING_RULES_TABLE)
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
    function_app._table_client(WEEKLY_SCORES_TABLE).upsert_entity(entity)
    return entity


@bp.function_name(name="weekly-scores")
@bp.route(route="weekly-scores", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def weekly_scores(req: func.HttpRequest) -> func.HttpResponse:
    # recalculateで確定保存された週だけを一覧する(閲覧は無認証、scores/ba踏襲)。
    table = function_app._table_client(WEEKLY_SCORES_TABLE)
    items = [_weekly_score_entity_dict(e) for e in table.list_entities()]
    items.sort(key=lambda x: x["weekKey"])
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")


@bp.function_name(name="weekly-scores-item")
@bp.route(route="weekly-scores/{week_key}", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def weekly_scores_item(req: func.HttpRequest) -> func.HttpResponse:
    week_key = req.route_params.get("week_key")
    parsed = _parse_week_key(week_key)
    if not parsed:
        return func.HttpResponse("week_key must look like 2026-W29", status_code=400)
    iso_year, iso_week = parsed

    table = function_app._table_client(WEEKLY_SCORES_TABLE)
    _, _, monday = _week_bounds(iso_year, iso_week)
    try:
        entity = table.get_entity(partition_key=str(iso_year), row_key=_week_row_key(iso_week, monday))
        body = _weekly_score_entity_dict(entity)
    except ResourceNotFoundError:
        # まだrecalculateされていない週は、保存はせずその場計算した値を返す。
        body = _calc_weekly_score(iso_year, iso_week)
    return func.HttpResponse(json.dumps(body, ensure_ascii=False), mimetype="application/json")


@bp.function_name(name="weekly-scores-recalculate")
@bp.route(route="weekly-scores/recalculate", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def weekly_scores_recalculate(req: func.HttpRequest) -> func.HttpResponse:
    # 書き込み(確定保存)は他の書き込み系(visits/scores)同様に認証必須。
    body = function_app._get_body(req)
    err = function_app._authorize(body)
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
