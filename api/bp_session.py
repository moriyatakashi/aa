import json
import secrets
from datetime import datetime, timezone

import azure.functions as func

import function_app

bp = func.Blueprint()

# 永続認証移行(ba-XX)。POSTはGoogle IDトークンを無期限の署名済みセッション
# トークンに交換し、DELETEはそのトークンを即座に失効させる(ログアウト)。
# SESSION_SECRETが未設定の間はこのエンドポイント自体が503を返すだけで、
# 既存のGoogle直接検証フローには一切影響しない。
# SESSION_SECRETや_parse_session_token等はapi-tests/がmonkeypatchするため
# function_app.py側に定義がある(ba-243)。ここではfunction_app.Xで遅延参照する。


@bp.function_name(name="session")
@bp.route(route="session", methods=["POST", "DELETE"], auth_level=func.AuthLevel.ANONYMOUS)
def session(req: func.HttpRequest) -> func.HttpResponse:
    if not function_app.SESSION_SECRET:
        return func.HttpResponse("session feature not configured", status_code=503)

    body = function_app._get_body(req)
    credential = (body or {}).get("credential", "")
    table = function_app._table_client(function_app.SESSIONS_TABLE)

    if req.method == "DELETE":
        session_id = function_app._parse_session_token(credential)
        if not session_id:
            return func.HttpResponse("invalid credential", status_code=401)
        try:
            table.delete_entity(partition_key=function_app.SESSIONS_PARTITION, row_key=session_id)
        except Exception:
            pass
        return func.HttpResponse(status_code=204)

    # POST: 新規発行は必ず生のGoogle IDトークンからのみ行う(session:や manual:
    # トークンからの自己更新を許すと、一度発行した無期限トークンが無期限に延長
    # され続けてしまい、ログアウトによる失効の意味が薄れるため)。
    err = function_app._verify_google_credential(credential)
    if err:
        return err

    session_id = secrets.token_urlsafe(24)
    table.upsert_entity({
        "PartitionKey": function_app.SESSIONS_PARTITION,
        "RowKey": session_id,
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    })
    return func.HttpResponse(
        json.dumps({"sessionToken": function_app._make_session_token(session_id)}, ensure_ascii=False),
        status_code=201,
        mimetype="application/json",
    )
