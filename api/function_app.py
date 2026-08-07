import hashlib
import hmac
import os

import azure.functions as func
import requests
from azure.data.tables import TableServiceClient

app = func.FunctionApp()

CONN_STR = os.environ["TABLE_CONNECTION_STRING"]
GOOGLE_CLIENT_ID = os.environ["GOOGLE_CLIENT_ID"]
ALLOWED_EMAIL = os.environ["ALLOWED_EMAIL"]
# 手動パスコード認証（Googleログインが使えない時の代替経路）。
# Azure Function Appの環境変数に設定した場合のみ有効になる。未設定なら
# この経路は使われない（デフォルトでは何も変わらない、安全側）。
RBA_MANUAL_PASSCODE = os.environ.get("RBA_MANUAL_PASSCODE", "")
# 永続セッション機能（ba-XX 永続認証移行）の署名鍵。未設定ならこの機能自体を
# 無効化する（session()は503を返し、_authorizeはsession:トークンを一切受け付けない）。
# 既存のGoogle IDトークン直検証フローには影響しない（デフォルトでは何も変わらない、安全側）。
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
# last-updated用(ba-69)。GitHub APIの認証に使うPAT(read-onlyで十分)。未設定なら
# 未認証(60req/時/IP)のままGitHub APIを叩く(デフォルトでは何も変わらない、安全側)。
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
# ba-160: Googleカレンダー連携。calendar.readonlyスコープのrefresh tokenを別途取得して使う
# (scripts/get_gcal_refresh_token.py、2026-07-26セットアップ)。
GCAL_OAUTH_CLIENT_ID = os.environ.get("GCAL_OAUTH_CLIENT_ID", "")
GCAL_OAUTH_CLIENT_SECRET = os.environ.get("GCAL_OAUTH_CLIENT_SECRET", "")
GCAL_OAUTH_REFRESH_TOKEN = os.environ.get("GCAL_OAUTH_REFRESH_TOKEN", "")


# ba-243: function_app.pyのBlueprint分割リファクタリング(すま設計、利尻実装)。
# ここ(function_app.py本体)には、api-tests/がmonkeypatch.setattr(fa, "X", ...)で
# 直接書き換える名前(_table_client/SESSION_SECRET/RBA_MANUAL_PASSCODE/GITHUB_TOKEN/
# _authorize_get/GCAL_OAUTH_*)と、それに連なる認証チェーンだけを残す。理由:
# bp_*.py側が `from function_app import X` で束縛すると、importした瞬間の値が
# 固定されてしまいmonkeypatchが効かなくなる(既存テストが150箇所以上function_appの
# 名前空間を直接触っており、無改修で動かす前提のため)。bp_*.py側は
# `import function_app` した上で呼び出し時に `function_app.X` と参照する
# (遅延束縛、monkeypatchを正しく反映する。circular importになるが、
# 実際に属性へアクセスするのは各関数の呼び出し時=両モジュールの読み込みが
# 完了した後なので問題ない)。
_table_service = None


def _table_client(table_name):
    # ba-30(3): 毎リクエストでTableServiceClientを新規生成していたのをやめ、
    # ウォームインスタンス間で使い回す(モジュールレベルで1度だけ生成)。
    global _table_service
    if _table_service is None:
        _table_service = TableServiceClient.from_connection_string(CONN_STR)
    return _table_service.get_table_client(table_name)


def _get_body(req):
    try:
        return req.get_json()
    except ValueError:
        return {}


def _verify_google_credential(credential):
    """GoogleのIDトークンをtokeninfoエンドポイントに問い合わせて検証する。
    ALLOWED_EMAIL本人のトークンであればNone、そうでなければ401のHttpResponseを返す。"""
    try:
        resp = requests.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"id_token": credential},
            timeout=5,
        )
    except Exception:
        return func.HttpResponse("invalid credential", status_code=401)
    if resp.status_code != 200:
        return func.HttpResponse("invalid credential", status_code=401)

    payload = resp.json()
    if payload.get("aud") != GOOGLE_CLIENT_ID:
        return func.HttpResponse("invalid credential", status_code=401)
    # 「トークンは有効だが本人ではない」ことを403で区別すると、有効なGoogle
    # アカウントを持つ第三者が「自分は認証済みだが権限がない」ことを判別できて
    # しまう。本人以外は常に401にして、無効トークンと見分けがつかないようにする。
    if payload.get("email_verified") != "true" or payload.get("email", "").lower() != ALLOWED_EMAIL.lower():
        return func.HttpResponse("invalid credential", status_code=401)
    return None


SESSIONS_TABLE = "Sessions"
SESSIONS_PARTITION = "session"


def _sign_session_id(session_id):
    return hmac.new(SESSION_SECRET.encode(), session_id.encode(), hashlib.sha256).hexdigest()


def _make_session_token(session_id):
    return f"session:{session_id}.{_sign_session_id(session_id)}"


def _parse_session_token(credential):
    """"session:<id>.<署名>"形式を検証し、正当ならidを、そうでなければNoneを返す。
    ここではSESSION_SECRETによる署名検証のみ行い、テーブル上の失効確認は呼び出し側で行う。"""
    if not credential.startswith("session:"):
        return None
    rest = credential[len("session:"):]
    if "." not in rest:
        return None
    session_id, _, sig = rest.rpartition(".")
    if not session_id or not sig:
        return None
    if not hmac.compare_digest(_sign_session_id(session_id), sig):
        return None
    return session_id


def _authorize_session(credential):
    """署名済みの永続セッショントークンを検証する。Sessionsテーブルに該当行が
    残っていれば有効(ログアウト等で行を削除すると、無期限トークンでも即座に失効する)。"""
    session_id = _parse_session_token(credential)
    if not session_id:
        return func.HttpResponse("invalid credential", status_code=401)
    table = _table_client(SESSIONS_TABLE)
    try:
        table.get_entity(partition_key=SESSIONS_PARTITION, row_key=session_id)
    except Exception:
        return func.HttpResponse("invalid credential", status_code=401)
    return None


def _authorize(body):
    """ab個人データの書き込みをALLOWED_EMAIL本人のGoogleログインのみに制限する。
    問題なければNone、問題があればそのまま返すHttpResponseを返す。
    RBA_MANUAL_PASSCODEが設定されている場合のみ、"manual:<パスコード>"形式の
    credentialでも通す（Googleログインが壊れた時の代替経路）。
    SESSION_SECRETが設定されている場合のみ、"session:<id>.<署名>"形式の
    永続セッショントークン（POST /api/sessionで発行）でも通す。"""
    credential = (body or {}).get("credential", "")
    if not credential:
        return func.HttpResponse("credential is required", status_code=401)

    if RBA_MANUAL_PASSCODE and credential == f"manual:{RBA_MANUAL_PASSCODE}":
        return None

    if SESSION_SECRET and credential.startswith("session:"):
        return _authorize_session(credential)

    return _verify_google_credential(credential)


def _authorize_get(req):
    """GETリクエスト用の_authorize。ba-160のcalendar-events/declarations achieveのように
    「閲覧にも認証が要る」エンドポイント向けに、クエリ文字列のcredentialを見る
    (GETはボディを送るのが一般的でないため)。"""
    return _authorize({"credential": req.params.get("credential", "")})


# ===== ここから下、ドメインごとのBlueprintを取り込んで登録する(ba-243) =====
import bp_visits
import bp_points
import bp_calendar
import bp_declarations
import bp_scores_daily
import bp_ba
import bp_scoring_rules
import bp_weekly
import bp_monthly
import bp_streak
import bp_session
import bp_last_updated
import bp_s1

for _bp_module in (
    bp_visits, bp_points, bp_calendar, bp_declarations, bp_scores_daily,
    bp_ba, bp_scoring_rules, bp_weekly, bp_monthly, bp_streak,
    bp_session, bp_last_updated, bp_s1,
):
    app.register_blueprint(_bp_module.bp)

# api-tests/が `fa.visits` のように関数・定数をfunction_app名前空間から直接参照する
# ためだけの再エクスポート(ba-243: テスト無改修のため)。実体は各bp_*.py側にある。
visits = bp_visits.visits
score_events = bp_points.score_events
points = bp_points.points
POINT_EVENTS_TABLE = bp_points.POINT_EVENTS_TABLE
calendar_events = bp_calendar.calendar_events
declarations = bp_declarations.declarations
declarations_achieve = bp_declarations.declarations_achieve
scores = bp_scores_daily.scores
scores_item = bp_scores_daily.scores_item
ba_log = bp_ba.ba_log
BA_SEQ_PARTITION = bp_ba.BA_SEQ_PARTITION
scoring_rules = bp_scoring_rules.scoring_rules
weekly_scores = bp_weekly.weekly_scores
weekly_scores_item = bp_weekly.weekly_scores_item
weekly_scores_recalculate = bp_weekly.weekly_scores_recalculate
monthly_scores = bp_monthly.monthly_scores
monthly_scores_item = bp_monthly.monthly_scores_item
monthly_scores_recalculate = bp_monthly.monthly_scores_recalculate
streak_checks = bp_streak.streak_checks
session = bp_session.session
last_updated = bp_last_updated.last_updated
_last_updated_cache = bp_last_updated._last_updated_cache
wip_tasks = bp_s1.wip_tasks
