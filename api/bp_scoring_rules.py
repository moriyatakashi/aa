import json
from datetime import date, datetime, timedelta, timezone

import azure.functions as func

import function_app
from bp_ba import BA_DIFFICULTY_POINTS

bp = func.Blueprint()

# ba-53: 週次得点(毎日スコア合計 + baクローズの難易度別得点)。takashi確定仕様(2026-07-21):
# ・週は月曜始まり(月〜日、JST)。ISO 8601の週番号(date.isocalendar系)がそのままこの定義に合う。
# ・難易度別配点: low=2/normal=5/high=10。difficulty未設定の過去スレッドはnormal扱い。
# ・計算タイミングは「管理ページアクセス時のオンデマンド」を推奨(takashi)。このためWeeklyScores
#   テーブルは"確定させたい週のスナップショット"を保存する用途とし、GET detailは未保存の週なら
#   その場で計算した値をその都度返す(保存はrecalculateを呼んだ時のみ)。
# JST/週ユーティリティはscoring-rules・weekly-scores・monthly-scores・declarations・
# streak-checksの複数ドメインが共用するため、ここ(ba-243でscoring-rulesを寄せた先)に置く。
JST = timezone(timedelta(hours=9))


def _week_bounds(iso_year, iso_week):
    """ISO年/週(月曜始まり)から、その週の[月曜0時JST, 翌月曜0時JST)をUTCで返す。
    3つ目の戻り値はその週の月曜日(JSTのdate)。"""
    monday = date.fromisocalendar(iso_year, iso_week, 1)
    start_jst = datetime(monday.year, monday.month, monday.day, tzinfo=JST)
    end_jst = start_jst + timedelta(days=7)
    return start_jst.astimezone(timezone.utc), end_jst.astimezone(timezone.utc), monday


def _week_row_key(iso_week, monday):
    return f"W{iso_week:02d}_{monday.isoformat()}"


def _parse_week_key(week_key):
    """"2026-W29"形式をパースして(year, week)を返す。不正な形式ならNone。"""
    year_str, sep, week_str = (week_key or "").partition("-W")
    if not sep:
        return None
    try:
        return int(year_str), int(week_str)
    except ValueError:
        return None


# ba-159: イカサマ対策(基準ずらし記録)。difficulty配点(BA_DIFFICULTY_POINTS)は元々
# コード上の固定定数だったため、将来配点を変えると、まだrecalculateしていない過去の週の
# オンデマンド計算結果が当時のルールでなく新ルールで静かに変わってしまう欠陥があった
# (2026-07-26、ba-165実装中に発見)。ScoringRulesテーブルで配点を版管理し、週の月曜日
# 時点で有効だった配点を都度引くことでこれを直す。ラベル集合(low/normal/high)自体は
# 変えない前提とし、BA_DIFFICULTY_POINTSは「ラベルの妥当性チェック」と「初回シード値」に
# 用途を絞る。
SCORING_RULES_TABLE = "ScoringRules"
SCORING_RULES_PARTITION = "rule"
SCORING_RULES_SEED_EFFECTIVE_FROM = "2026-01-01"


def _seed_scoring_rules_if_empty(table):
    """初回のみ、現行配点(BA_DIFFICULTY_POINTS)を過去日付でシードする。既存の
    recalculate済みWeeklyScoresの挙動が、新設のScoringRulesテーブルの有無で
    変わらないようにするための一度きりの移行措置。"""
    if list(table.list_entities()):
        return
    table.upsert_entity({
        "PartitionKey": SCORING_RULES_PARTITION,
        "RowKey": SCORING_RULES_SEED_EFFECTIVE_FROM,
        "DifficultyPoints": json.dumps(BA_DIFFICULTY_POINTS, ensure_ascii=False),
        "Note": "初期配点(seed)",
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    })


def _scoring_rule_at(table, on_or_before_date_str):
    """table内で、EffectiveFrom(RowKey)がon_or_before_date_str以前の行のうち
    最新のものの配点を返す。無ければBA_DIFFICULTY_POINTS(現行値)にフォールバック。"""
    candidates = [e for e in table.list_entities() if e["RowKey"] <= on_or_before_date_str]
    if not candidates:
        return dict(BA_DIFFICULTY_POINTS)
    latest = max(candidates, key=lambda e: e["RowKey"])
    try:
        return json.loads(latest.get("DifficultyPoints") or "{}")
    except ValueError:
        return dict(BA_DIFFICULTY_POINTS)


def _latest_scoring_rule(table):
    return _scoring_rule_at(table, "9999-12-31")


def _scoring_rule_dict(e):
    return {
        "effectiveFrom": e["RowKey"],
        "difficultyPoints": json.loads(e.get("DifficultyPoints") or "{}"),
        "note": e.get("Note", ""),
        "createdAt": e.get("CreatedAt", ""),
    }


@bp.function_name(name="scoring-rules")
@bp.route(route="scoring-rules", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def scoring_rules(req: func.HttpRequest) -> func.HttpResponse:
    table = function_app._table_client(SCORING_RULES_TABLE)
    _seed_scoring_rules_if_empty(table)

    if req.method == "GET":
        items = [_scoring_rule_dict(e) for e in table.list_entities()]
        items.sort(key=lambda x: x["effectiveFrom"])
        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = function_app._get_body(req)
    err = function_app._authorize(body)
    if err:
        return err

    difficulty_points = body.get("difficultyPoints")
    if not isinstance(difficulty_points, dict) or set(difficulty_points.keys()) != set(BA_DIFFICULTY_POINTS.keys()):
        return func.HttpResponse(
            f"difficultyPoints must have exactly these keys: {', '.join(sorted(BA_DIFFICULTY_POINTS))}",
            status_code=400,
        )
    for v in difficulty_points.values():
        if not isinstance(v, int) or isinstance(v, bool):
            return func.HttpResponse("difficultyPoints values must be integers", status_code=400)

    effective_from = body.get("effectiveFrom") or datetime.now(JST).date().isoformat()
    try:
        date.fromisoformat(effective_from)
    except ValueError:
        return func.HttpResponse("effectiveFrom must look like YYYY-MM-DD", status_code=400)

    entity = {
        "PartitionKey": SCORING_RULES_PARTITION,
        "RowKey": effective_from,
        "DifficultyPoints": json.dumps(difficulty_points, ensure_ascii=False),
        "Note": body.get("note", ""),
        "CreatedAt": datetime.now(timezone.utc).isoformat(),
    }
    table.upsert_entity(entity)
    return func.HttpResponse(json.dumps(_scoring_rule_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json")
