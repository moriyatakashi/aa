import json
from datetime import datetime, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError

import function_app
from bp_ba import _ba_claude_lane

bp = func.Blueprint()

# ===== s1 / WIP作業台 (ba-200) — 追記ブロック。既存には一切触れない =====
# baから抽出したidに作業メタだけ別持ち。使い捨て前提・作り込まない。
# テーブルはハンドラ内で遅延生成(create_table_if_not_exists)。az CLI不要。
WIP_TASKS_TABLE = "WipTasks"
WIP_TASKS_PARTITION = "wip"


def _ensure_wip_table():
    # _table_service(グローバル、function_app.py側)を初期化しつつ、無ければ空テーブルを作る(冪等)。
    function_app._table_client(WIP_TASKS_TABLE)
    try:
        function_app._table_service.create_table_if_not_exists(WIP_TASKS_TABLE)
    except Exception:
        pass
    return function_app._table_client(WIP_TASKS_TABLE)


def _wip_task_dict(e):
    return {
        "baId": e["RowKey"],
        "seq": e.get("Seq"),
        "important": e.get("Important", False),
        "assignee": e.get("Assignee", ""),
        "plannedDate": e.get("PlannedDate", ""),
        "createdAt": e.get("CreatedAt", ""),
    }


@bp.function_name(name="wip-tasks")
@bp.route(route="s1", methods=["GET", "POST", "DELETE"], auth_level=func.AuthLevel.ANONYMOUS)
def wip_tasks(req: func.HttpRequest) -> func.HttpResponse:
    # 段2a: GET(無認証・閲覧)。段2b: POST(登録/更新)を追加。POSTはba同様claude_key必須。
    # DELETE(2026-08-01、ba-200残課題対応): 作業台から外す。POSTと同じ認証(claude_key
    # またはGoogleログイン)。ba本体(BaLog)には一切触れない(作業メタだけの削除)。
    table = _ensure_wip_table()

    if req.method == "GET":
        items = [_wip_task_dict(e) for e in table.list_entities()]
        items.sort(key=lambda x: ((x.get("plannedDate") or ""), (x.get("createdAt") or "")))
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    if req.method == "DELETE":
        body = function_app._get_body(req)
        by = _ba_claude_lane(body.get("claude_key", ""))
        if not by:
            err = function_app._authorize(body)
            if err:
                return err
            by = "takashi"

        ba_id = (body.get("baId") or "").strip()
        if not ba_id:
            return func.HttpResponse("baId is required", status_code=400)

        try:
            table.delete_entity(partition_key=WIP_TASKS_PARTITION, row_key=ba_id)
        except ResourceNotFoundError:
            pass  # 既に無ければそれで目的達成(冪等)
        return func.HttpResponse(status_code=204)

    # POST: 登録/更新(upsert)。RowKey=baIdなので同じidの再送は上書き(二重にならない)。
    # ba_logと同じく、claude_keyが無ければGoogleログイン(_authorize)にフォールバックし、
    # 人間レーン(takashi本人)からも画面経由で登録できるようにする(2026-08-01、ba-200残課題対応)。
    body = function_app._get_body(req)
    by = _ba_claude_lane(body.get("claude_key", ""))
    if not by:
        err = function_app._authorize(body)
        if err:
            return err
        by = "takashi"

    ba_id = (body.get("baId") or "").strip()
    if not ba_id:
        return func.HttpResponse("baId is required", status_code=400)

    # 既存があれば登録時間(CreatedAt)は据え置く。無ければ今。
    try:
        existing = table.get_entity(partition_key=WIP_TASKS_PARTITION, row_key=ba_id)
        created_at = existing.get("CreatedAt") or datetime.now(timezone.utc).isoformat()
    except ResourceNotFoundError:
        created_at = datetime.now(timezone.utc).isoformat()

    entity = {
        "PartitionKey": WIP_TASKS_PARTITION,
        "RowKey": ba_id,
        "Important": bool(body.get("important", False)),
        "Assignee": (body.get("assignee") or "").strip(),
        "PlannedDate": (body.get("plannedDate") or "").strip(),
        "CreatedAt": created_at,
    }
    seq = body.get("seq")
    if seq is not None:
        entity["Seq"] = seq
    table.upsert_entity(entity)
    return func.HttpResponse(json.dumps(_wip_task_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json")
