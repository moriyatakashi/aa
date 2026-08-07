import json
import uuid
from datetime import datetime, timezone

import azure.functions as func

import function_app
from bp_ba import BA_DIFFICULTY_POINTS
from bp_points import _create_point_event

bp = func.Blueprint()

VISITS_TABLE = "Visits"
# ba-165②(2026-07-29確定、Takashi判断): Visits初登録の自動検知→自動加点。
# 粒度は県>市>町の順で粗い方を優先し(同時に複数が初登場でも二重加点しない)、
# 県=high/市=normal/町=low(「経年で易化」=同じ都道府県内の別の市を後から訪れても
# 県はもう新規でないのでnormal以下に自然に下がる、という設計でありスコアの割引処理は別途行わない)。
# pref/city/townはn2側のGPS逆ジオコーディング結果を送ってもらう想定の追加フィールドで、
# 過去のVisitsエントリはこれらを持たないため、既存訪問地との突合は「Pref/City/Townが
# 一致した場合のみ既訪問扱い」になる(過去データへの遡及はしない、difficulty導入時と同じ方針)。
VISIT_GRANULARITY_DIFFICULTY = {"pref": "high", "city": "normal", "town": "low"}


def _visit_dict(e):
    return {
        "id": e["RowKey"],
        "place": e.get("Place", ""),
        "date": e.get("Date", ""),
        "time": e.get("Time", ""),
        "memo": e.get("Memo", ""),
        "lat": e.get("Lat"),
        "lng": e.get("Lng"),
        "pref": e.get("Pref", ""),
        "city": e.get("City", ""),
        "town": e.get("Town", ""),
        "autoPointGranularity": e.get("AutoPointGranularity", ""),
        "createdAt": e.get("CreatedAt", ""),
    }


def _is_new_visit_value(table, field_name, value):
    if not value:
        return False
    return all(e.get(field_name) != value for e in table.list_entities())


@bp.function_name(name="visits")
@bp.route(route="visits", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def visits(req: func.HttpRequest) -> func.HttpResponse:
    table = function_app._table_client(VISITS_TABLE)

    if req.method == "GET":
        # ba-35残課題(2): 閲覧はログイン不要にする(2026-07-20)。書き込み(POST)は引き続き認証必須。
        items = [_visit_dict(e) for e in table.list_entities()]
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = function_app._get_body(req)
    err = function_app._authorize(body)
    if err:
        return err

    place = (body.get("place") or "").strip()
    if not place:
        return func.HttpResponse("place is required", status_code=400)

    pref = (body.get("pref") or "").strip()
    city = (body.get("city") or "").strip()
    town = (body.get("town") or "").strip()

    # 粗い粒度から先に判定する(同じ訪問で県も市も初登場なら県=highだけを採用しhigh+normalの
    # 二重加点にしない)。
    if pref and _is_new_visit_value(table, "Pref", pref):
        granularity = "pref"
    elif city and _is_new_visit_value(table, "City", city):
        granularity = "city"
    elif town and _is_new_visit_value(table, "Town", town):
        granularity = "town"
    else:
        granularity = None

    entity = {
        "PartitionKey": "visit",
        "RowKey": str(uuid.uuid4()),
        "Place": place,
        "Date": body.get("date", ""),
        "Time": body.get("time", ""),
        "Memo": body.get("memo", ""),
        "Pref": pref,
        "City": city,
        "Town": town,
        "AutoPointGranularity": granularity or "",
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    }
    if body.get("lat") is not None:
        entity["Lat"] = float(body["lat"])
    if body.get("lng") is not None:
        entity["Lng"] = float(body["lng"])
    table.upsert_entity(entity)

    if granularity:
        difficulty = VISIT_GRANULARITY_DIFFICULTY[granularity]
        label = {"pref": pref, "city": city, "town": town}[granularity]
        _create_point_event(
            "初訪問", BA_DIFFICULTY_POINTS[difficulty], f"{label}({granularity})",
            period="week", catalog_id="visit_new",
        )

    return func.HttpResponse(json.dumps(_visit_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json")
