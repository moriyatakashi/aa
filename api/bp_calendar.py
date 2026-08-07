import json
from datetime import datetime, timezone

import azure.functions as func
import requests

import function_app

bp = func.Blueprint()

# ba-160: Googleカレンダー連携(予定ページ)。このAzure Functions自体のOAuth連携が要る
# (Claude Code側のMCPツールはこのセッション専用でサイトからは呼べないため)。
# aapj-501407のDesktopクライアント(scripts/backup-balog-to-drive.pyと共用)で、
# calendar.readonlyスコープのrefresh tokenを別途取得して使う
# (scripts/get_gcal_refresh_token.py、2026-07-26セットアップ)。
# GCAL_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKENはapi-tests/がmonkeypatchするため
# function_app.py側に定義がある(ba-243)。ここではfunction_app.Xで遅延参照する。


def _gcal_access_token():
    resp = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": function_app.GCAL_OAUTH_CLIENT_ID,
        "client_secret": function_app.GCAL_OAUTH_CLIENT_SECRET,
        "refresh_token": function_app.GCAL_OAUTH_REFRESH_TOKEN,
        "grant_type": "refresh_token",
    }, timeout=5)
    resp.raise_for_status()
    return resp.json()["access_token"]


@bp.function_name(name="calendar-events")
@bp.route(route="calendar-events", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def calendar_events(req: func.HttpRequest) -> func.HttpResponse:
    # カレンダーの中身は他者の氏名・場所等を含みうる個人情報のため、visits/scoresと違い
    # 閲覧も認証必須にする(このサイトの「GETは公開」の既定から意図的に外す)。
    err = function_app._authorize_get(req)
    if err:
        return err

    if not (function_app.GCAL_OAUTH_CLIENT_ID and function_app.GCAL_OAUTH_CLIENT_SECRET and function_app.GCAL_OAUTH_REFRESH_TOKEN):
        return func.HttpResponse("calendar integration not configured", status_code=503)

    try:
        access_token = _gcal_access_token()
        resp = requests.get(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            headers={"Authorization": f"Bearer {access_token}"},
            params={
                "timeMin": datetime.now(timezone.utc).isoformat(),
                "maxResults": 20,
                "singleEvents": "true",
                "orderBy": "startTime",
            },
            timeout=5,
        )
        resp.raise_for_status()
    except Exception as e:
        return func.HttpResponse(f"calendar fetch failed: {e}", status_code=502)

    items = []
    for e in resp.json().get("items", []):
        start = (e.get("start") or {}).get("dateTime") or (e.get("start") or {}).get("date")
        end = (e.get("end") or {}).get("dateTime") or (e.get("end") or {}).get("date")
        items.append({
            "id": e.get("id"),
            "summary": e.get("summary", ""),
            "start": start,
            "end": end,
            "location": e.get("location", ""),
        })
    return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")
