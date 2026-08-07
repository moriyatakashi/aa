import json
import re
from datetime import datetime, timedelta, timezone

import azure.functions as func
import requests

import function_app

bp = func.Blueprint()

# src/common/last-updated.js用のプロキシ(ba-68/ba-69)。GitHubトークンを
# クライアント側のJSに一切埋め込まないため、サーバー側(ここ)でGitHub commits API
# を認証付きで叩き、結果だけをクライアントへ返す。GITHUB_TOKEN未設定でも動作する
# (その場合は未認証のままGitHub APIを叩く。既存の直接fetch版と同じ挙動)。
GITHUB_REPO = "moriyatakashi/aa"
_last_updated_cache = {}  # path -> (fetched_at: datetime, iso_date: str | None)
LAST_UPDATED_CACHE_TTL = timedelta(minutes=10)


@bp.function_name(name="last-updated")
@bp.route(route="last-updated", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def last_updated(req: func.HttpRequest) -> func.HttpResponse:
    path = req.params.get("path", "")
    # pathはGitHub API呼び出しにそのまま使うため、リポジトリ内のファイルパスとして
    # 妥当な文字種だけを許可する(このエンドポイントが任意URLへのオープンプロキシに
    # されるのを防ぐ)。".."セグメントも明示的に拒否する(文字種だけでは"../.."を防げないため)。
    if not path or not re.match(r"^[A-Za-z0-9_./-]+$", path) or ".." in path.split("/"):
        return func.HttpResponse("invalid path", status_code=400)

    now = datetime.now(timezone.utc)
    cached = _last_updated_cache.get(path)
    if cached and now - cached[0] < LAST_UPDATED_CACHE_TTL:
        return func.HttpResponse(json.dumps({"date": cached[1]}), mimetype="application/json")

    headers = {"Accept": "application/vnd.github+json"}
    if function_app.GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {function_app.GITHUB_TOKEN}"
    try:
        resp = requests.get(
            f"https://api.github.com/repos/{GITHUB_REPO}/commits",
            params={"path": path, "per_page": 1},
            headers=headers,
            timeout=5,
        )
    except Exception:
        return func.HttpResponse(json.dumps({"date": None}), mimetype="application/json")

    if resp.status_code != 200:
        return func.HttpResponse(json.dumps({"date": None}), mimetype="application/json")

    data = resp.json()
    iso_date = data[0]["commit"]["committer"]["date"] if data else None
    _last_updated_cache[path] = (now, iso_date)
    return func.HttpResponse(json.dumps({"date": iso_date}), mimetype="application/json")
