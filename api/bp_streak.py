import json
from datetime import date, datetime, timedelta, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError

import function_app
from bp_ba import BA_DIFFICULTY_POINTS
from bp_points import POINT_EVENTS_TABLE, _create_point_event
from bp_scoring_rules import JST, _week_bounds

bp = func.Blueprint()

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


@bp.function_name(name="streak-checks")
@bp.route(route="streak-checks", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def streak_checks(req: func.HttpRequest) -> func.HttpResponse:
    table = function_app._table_client(STREAK_CHECKS_TABLE)

    if req.method == "GET":
        items = [_streak_check_dict(e) for e in table.list_entities()]
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = function_app._get_body(req)
    err = function_app._authorize(body)
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
        point_events_table = function_app._table_client(POINT_EVENTS_TABLE)
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
