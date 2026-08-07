import json
import uuid
from datetime import datetime, timezone

import azure.functions as func

import function_app
from bp_ba import BA_DIFFICULTY_POINTS

bp = func.Blueprint()

POINT_EVENTS_TABLE = "PointEvents"


def _point_event_dict(e):
    return {
        "id": e["RowKey"],
        "axis": e.get("Axis", ""),
        "points": e.get("Points", 0),
        # ba-165(2026-07-29): 週次/月次のどちらの得点に合算するかの区分。旧データ(Period未設定)は
        # 移行当時すべて週次のみが存在したためweek扱いにフォールバックする。
        "note": e.get("Note", ""),
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
    function_app._table_client(POINT_EVENTS_TABLE).upsert_entity(entity)
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


@bp.function_name(name="score-events")
@bp.route(route="score-events", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def score_events(req: func.HttpRequest) -> func.HttpResponse:
    # ba-165①: n1のプルダウン等が参照する、加点軸の固定カタログ(手動選択分+自動加点の案内)。
    return func.HttpResponse(json.dumps({
        "catalog": SCORE_EVENT_CATALOG,
        "automated": AUTOMATED_SCORE_EVENTS,
        "difficultyPoints": BA_DIFFICULTY_POINTS,
    }, ensure_ascii=False), mimetype="application/json")


@bp.function_name(name="points")
@bp.route(route="points", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def points(req: func.HttpRequest) -> func.HttpResponse:
    # ba-165①(2026-07-29): axisはSCORE_EVENT_CATALOGのidか、カタログにない事象を拾うための
    # "other"のどちらかのみ受け付ける(以前の完全自由入力から変更)。pointsは引き続き自己申告
    # (difficultyから機械的に決め打ちしない、ころころ変えてよい前提の運用のため)。
    table = function_app._table_client(POINT_EVENTS_TABLE)

    if req.method == "GET":
        items = [_point_event_dict(e) for e in table.list_entities()]
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = function_app._get_body(req)
    err = function_app._authorize(body)
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
