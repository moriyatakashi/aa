import json
import os
import uuid
from datetime import datetime, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError

import function_app

bp = func.Blueprint()

# ba(n4の後継)。骨組みはn4と同じ追記オンリー台帳だが、Claude Codeレーンを
# スマホ/PCで別鍵にし、"実機/実ブラウザで確認できた"ことを主張する種別
# (verified_on_device)だけはPCレーンのみ書き込み可にする。
BA_TABLE = "BaLog"
BA_HUMAN_ALLOWED_TYPES = {"new", "note", "void", "status", "approval", "correction", "react", "link", "gist"}
BA_DEVICE_VERIFIED_TYPES = {"verified_on_device"}
# ba-77: 承認キュー。claudeレーンがproposeFor:"takashi"付きで投函した提案を、
# takashi本人(人間レーン、実ログイン)だけが承認できるようにする。新しい秘密は増やさない。
BA_TAKASHI_ONLY_TYPES = {"approval"}
# correction: タイトルは追記オンリーゆえ最初の書き方に固定されがちなので、
# titleを持つcorrectionをstatusのopen/closedと同じ「refで参照し最新が勝つ」形で
# 見出しの付け直しに使う(thread-logic.jsのdisplayTitle解決を参照)。
# 元のnewエントリのtitleは書き換えず残る(付け直しの履歴も追記として残る)。
# 以前はclaude-pc/mobileレーンだけが書けた(人間レーンのアローリストに無かった)が、
# takashi本人も付け直せるようにここに追加した。
# react: 3レーン(takashi/claude-pc/claude-mobile)がそれぞれ自分の反応(value:true/false、
# voidと同じく後勝ち・by別に独立)を残せる種別。参考程度の反応であり、正式な承認・決定
# 条件ではない(意思決定はapprovalが担う。reactは判断根拠にしない)。
# ba-53: スレッドクローズの難易度別得点(週次得点で使う)。
BA_DIFFICULTY_POINTS = {"low": 2, "normal": 5, "high": 10}
BA_DEFAULT_DIFFICULTY = "normal"
# ba-162: スレッド間の関連付け(redmine風の関連チケット)。voidと同じ「追記のみ・
# 最新値が勝つ」設計にし、rel先はthreadIdでなく人間が呼ぶseq番号(relSeq)で指定する
# (投稿側がthreadIdを調べずに済む)。存在しないseqへの誤参照はreact同様に許容し、
# POSTのたびにテーブル全体を走査してseqの実在確認はしない。双方向表示・タイトル
# プレビューの集約はthread-logic.js側のprojectionが担う。
# gist: 確定仕様スレッドに「今の結論」を一言(200字以内)で持たせる種別。correction/statusと
# 同じ「追記のみ・最新のtextが勝つ」設計。分類(確定仕様)に関わらず投稿・計算は無条件に行い、
# 「確定仕様の時だけ意味を持つ」という制約は表示側(ba/bb/rbook)の判断に任せる。


def _ba_entry_dict(e):
    try:
        data = json.loads(e.get("Data") or "{}")
    except ValueError:
        data = {}
    return {
        "id": e["RowKey"],
        "threadId": e["PartitionKey"],
        "by": e.get("By", ""),
        "ref": e.get("Ref") or None,
        "type": e.get("Type", ""),
        "seq": e.get("Seq"),
        "createdAt": e.get("CreatedAt", ""),
        **data,
    }


BA_SEQ_PARTITION = "_meta"
BA_SEQ_ROW = "ba_seq"


def _next_ba_seq(table):
    """採番用の専用カウンタエンティティをインクリメントする。
    以前は台帳全件をスキャンしてSeqの最大値を求めていたが、台帳が育つほど
    書き込みが遅くなるため、O(1)のカウンタ読み書きに変更した。
    カウンタ未作成(初回のみ)はResourceNotFoundErrorとして0からにするが、
    それ以外の例外(一時的な通信障害等)まで0扱いにすると採番が巻き戻って
    Seq重複を生むため、ここは握りつぶさず呼び出し元に伝播させる(2026-07-20実例で発覚)。"""
    try:
        current = table.get_entity(partition_key=BA_SEQ_PARTITION, row_key=BA_SEQ_ROW).get("Value", 0)
    except ResourceNotFoundError:
        current = 0
    seq = current + 1
    table.upsert_entity({"PartitionKey": BA_SEQ_PARTITION, "RowKey": BA_SEQ_ROW, "Value": seq})
    return seq


def _ba_claude_lane(claude_key):
    """渡された鍵がスマホ用/PC用のどちらと一致するかを判定する。
    一致しなければNoneを返し、人間レーンへフォールバックさせる。"""
    if not claude_key:
        return None
    mobile_key = os.environ.get("BA_CLAUDE_KEY_MOBILE", "")
    pc_key = os.environ.get("BA_CLAUDE_KEY_PC", "")
    if pc_key and claude_key == pc_key:
        return "claude-pc"
    if mobile_key and claude_key == mobile_key:
        return "claude-mobile"
    return None


def _truthy_param(value):
    return (value or "").strip().lower() in ("1", "true", "yes")


def _require_existing_root(table, entry_type, ref):
    """rootless防止(ba-72/ba-101、gist追加でstatus専用から汎用化): refが
    既存スレッドのroot(PartitionKey=RowKey=ref)を指していることを確認する。
    問題なければNone、問題があれば返すべきHttpResponseを返す。"""
    if ref:
        try:
            table.get_entity(partition_key=ref, row_key=ref)
            return None
        except ResourceNotFoundError:
            pass
    return func.HttpResponse(
        json.dumps(
            {"error": f"{entry_type}のref先スレッドが存在しません(rootless防止)", "ref": ref},
            ensure_ascii=False,
        ),
        status_code=400,
        mimetype="application/json",
    )


def _ba_open_thread_ids(items):
    """void済み・status=closedでないスレッドのthreadId集合を返す。
    rbook(run.py)の_ba_is_voided/_ba_current_statusと同じ判定ロジック
    (voidはref/threadId両対応、statusはref指定のみ)をサーバー側に複製したもの。"""
    news_tids = [e["threadId"] for e in items if e.get("type") == "new"]

    voided = set()
    for e in items:
        if e.get("type") != "void":
            continue
        if e.get("ref"):
            voided.add(e["ref"])
        if e.get("threadId"):
            voided.add(e["threadId"])

    latest_status = {}
    for e in items:
        if e.get("type") != "status":
            continue
        tid = e.get("ref")
        if not tid:
            continue
        created = e.get("createdAt", "")
        if tid not in latest_status or created > latest_status[tid][0]:
            latest_status[tid] = (created, e.get("status") or "open")

    return {
        tid for tid in news_tids
        if tid not in voided and latest_status.get(tid, ("", "open"))[1] == "open"
    }


@bp.function_name(name="ba-log")
@bp.route(route="ba", methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def ba_log(req: func.HttpRequest) -> func.HttpResponse:
    table = function_app._table_client(BA_TABLE)

    if req.method == "GET":
        # 読み取りは無認証で公開(2026-07-15 takashi判断)。ba-16「GETは認証必須」の
        # 一部撤回であり、ba-35の「閲覧専用の軽い経路」に相当。POST側の認証は従来どおり。
        items = [
            _ba_entry_dict(e) for e in table.list_entities()
            if e["PartitionKey"] != BA_SEQ_PARTITION
        ]
        items.sort(key=lambda x: x["createdAt"])

        # ba-174: セッション開始時の全件取得コストを下げるための軽量モード。
        # open=1はクローズ済みスレッド一式を除外(実測37%程度に縮小)、
        # minimal=1はbodyを削る(同28.7%)。組み合わせると実測10.7%まで縮む。
        if _truthy_param(req.params.get("open")):
            open_ids = _ba_open_thread_ids(items)
            items = [e for e in items if e.get("threadId") in open_ids]
        if _truthy_param(req.params.get("minimal")):
            items = [{k: v for k, v in e.items() if k != "body"} for e in items]

        return func.HttpResponse(json.dumps(items, ensure_ascii=False), mimetype="application/json")

    body = function_app._get_body(req)

    by = _ba_claude_lane(body.get("claude_key", ""))
    if not by:
        err = function_app._authorize(body)
        if err:
            return err
        by = "takashi"

    entry_type = body.get("type") or "new"
    if by == "takashi" and entry_type not in BA_HUMAN_ALLOWED_TYPES:
        return func.HttpResponse(
            f"human lane can only write: {', '.join(sorted(BA_HUMAN_ALLOWED_TYPES))}",
            status_code=400,
        )
    if entry_type in BA_DEVICE_VERIFIED_TYPES and by != "claude-pc":
        return func.HttpResponse(
            f"only claude-pc can write: {', '.join(sorted(BA_DEVICE_VERIFIED_TYPES))}",
            status_code=400,
        )
    if entry_type in BA_TAKASHI_ONLY_TYPES and by != "takashi":
        return func.HttpResponse(
            f"only takashi can write: {', '.join(sorted(BA_TAKASHI_ONLY_TYPES))}",
            status_code=400,
        )

    # ba-53: 週次得点のクローズ得点計算に使うdifficulty(low/normal/high)。
    # newスレッド作成時のみ受け付け、未指定ならBA_DEFAULT_DIFFICULTYを明示的に補う
    # (difficultyなしの過去スレッドはweekly-scores側の計算時にも同じ既定値へフォールバックする)。
    if entry_type == "new":
        difficulty = body.get("difficulty") or BA_DEFAULT_DIFFICULTY
        if difficulty not in BA_DIFFICULTY_POINTS:
            return func.HttpResponse(
                f"difficulty must be one of: {', '.join(sorted(BA_DIFFICULTY_POINTS))}",
                status_code=400,
            )
        body = {**body, "difficulty": difficulty}

    # ba-162: 関連付け(link)。relSeq(対象スレッドのseq番号)必須、valueは省略時true、
    # falseなら「この(ref, relSeq)の組の関連付けを取り消す」を意味する(追記のみ)。
    if entry_type == "link":
        rel_seq = body.get("relSeq")
        if not isinstance(rel_seq, int) or isinstance(rel_seq, bool) or rel_seq <= 0:
            return func.HttpResponse(
                "relSeq must be a positive integer",
                status_code=400,
            )
        body = {**body, "value": body.get("value", True)}

    if entry_type == "gist":
        text = (body.get("text") or "").strip()
        if not text:
            return func.HttpResponse("text is required", status_code=400)
        if len(text) > 200:
            return func.HttpResponse("text must be 200 characters or fewer", status_code=400)
        body = {**body, "text": text}

    # 疎通確認用: dry_run=trueなら鍵・種別の検証だけ行い、台帳には書き込まない(ba-5)。
    if body.get("dry_run"):
        return func.HttpResponse(
            json.dumps({"dry_run": True, "by": by, "type": entry_type}, ensure_ascii=False),
            mimetype="application/json",
        )

    ref = (body.get("ref") or "").strip()
    if entry_type == "new":
        ref = ""  # newは常に新規スレッドの起点にする

    # rootless防止(ba-72/ba-101、gist追加でstatus専用から汎用化): statusやgistは必ず
    # 既存スレッドのroot(PartitionKey=RowKey=ref)を指していなければならない。スタレ/破損refを
    # 通すと孤立エントリ(rootless)ができ、_calc_weekly_scoreのクローズ集計等が静かにズレる。
    # 発生源で拒否する。
    if entry_type in ("status", "gist"):
        err = _require_existing_root(table, entry_type, ref)
        if err:
            return err

    now = datetime.now(timezone.utc)
    entry_id = now.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
    partition = ref if ref else entry_id

    exclude_keys = {"credential", "claude_key", "type", "ref"}
    data_fields = {k: v for k, v in body.items() if k not in exclude_keys}

    entity = {
        "PartitionKey": partition,
        "RowKey": entry_id,
        "By": by,
        "Ref": ref,
        "Type": entry_type,
        "Data": json.dumps(data_fields, ensure_ascii=False),
        "CreatedAt": now.isoformat(),
    }
    if entry_type == "new":
        entity["Seq"] = _next_ba_seq(table)
    table.upsert_entity(entity)
    return func.HttpResponse(json.dumps(_ba_entry_dict(entity), ensure_ascii=False), status_code=201, mimetype="application/json")


def _ba_close_transitions(ba_table):
    """ba-109: スレッドごとのstatus履歴を辿り、「非closeからcloseへ転じた瞬間」だけを
    close確定イベントとして抽出する。同じスレッドが間にopen(再オープン)を挟まず連続で
    複数回closeされても(2026-07-26に実際発生した誤投稿・重複close)、2回目以降は数えない。
    voidされたスレッドのcloseは(スレッド単位で)一切数えない。
    戻り値: [(thread_id, closeエントリのCreatedAt文字列), ...]"""
    statuses_by_thread = {}
    voided_threads = set()
    for e in ba_table.list_entities():
        etype = e.get("Type")
        if etype == "void":
            voided_threads.add(e["PartitionKey"])
            if e.get("Ref"):
                voided_threads.add(e["Ref"])
        elif etype == "status":
            data = json.loads(e.get("Data") or "{}")
            status = data.get("status")
            if not status:
                continue
            statuses_by_thread.setdefault(e["PartitionKey"], []).append((e.get("CreatedAt", ""), status))

    transitions = []
    for thread_id, records in statuses_by_thread.items():
        if thread_id in voided_threads:
            continue
        records.sort(key=lambda r: r[0])
        was_closed = False
        for created_at, status in records:
            if status == "closed":
                if not was_closed:
                    transitions.append((thread_id, created_at))
                was_closed = True
            else:
                was_closed = False
    return transitions
