import azure.functions as func
from collections import defaultdict

import function_app
from bp_s1 import _ensure_wip_table, _wip_task_dict
from bp_ba import BA_TABLE, BA_SEQ_PARTITION, _ba_entry_dict

bp = func.Blueprint()

# /api/s1.md, /api/s1.html (ba-XX): WIP作業台(s1)をJS不要・認証不要で外部AIに公開する。
# 外部のfetch系AI(M365 Copilot / ChatGPT等)はJSを実行しないため、s1.htmlの生HTMLは
# 「読み込み中…」の殻しか読めない。ここでサーバ側でs1とbaを結合し、1回のfetchで
# 「各WIPタスクに紐づくbaスレッド全体(new/note/link/status…)を時系列で全文」返す。
# 既存のGET /api/s1・/api/ba(いずれも公開)と同じテーブル読み取り関数を使い回し、
# 自己HTTPは挟まない(HTTP一往復を省く)。
#
# 中身(Markdownテキスト)は同一で、Content-Typeだけ2系統を用意する:
#   - s1.md   : text/plain  … 拡張子.mdを見て弾くfetch系AI向けの保険(no-store付き)
#   - s1.html : text/html   … ChatGPT等が拡張子.mdを自前でmarkdown判定して弾くため、
#                             .html拡張子+text/htmlで確実に読ませる。


def _render_entry(ent) -> str:
    # 1エントリを「見出し行 + 本文全文(+tags)」で描く。body無しの操作系(link/status)は
    # 見出し行だけで用件が分かるように、link先やstatus値を見出しに畳む。
    typ = ent.get("type", "")
    when = str(ent.get("createdAt", ""))[:16].replace("T", " ")
    by = ent.get("by", "")
    tag = f"{when} {typ}"
    if typ == "link":
        rel = ent.get("relSeq")
        if rel is not None:
            tag += f" → ba-{rel}"
        if ent.get("value") is False:
            tag += "(解除)"
    if typ == "status":
        st = ent.get("status")
        if st:
            tag += f" = {st}"
    lines = [f"**[{tag}]** ({by})"]
    body = ent.get("body")
    if body:
        lines.append(body)
    tags = ent.get("tags")
    if tags:
        lines.append("tags: " + ", ".join(tags))
    return "\n".join(lines)


def _render_s1_body() -> str:
    # s1(WipTasks)とba(BaLog)を既存関数でそのまま読む。s1のGETと同じ_wip_task_dict、
    # baのGETと同じ_ba_entry_dictを使うので、公開APIと同じ見え方になる。
    s1_table = _ensure_wip_table()
    s1 = [_wip_task_dict(e) for e in s1_table.list_entities()]

    # baを全走査し、threadId(=PartitionKey)ごとにスレッド全エントリを集める。
    # 同一スレッドはPartitionKeyが揃う設計なので、refを辿らずthreadIdで束ねられる。
    # 採番カウンタ(_meta)は除外。
    ba_table = function_app._table_client(BA_TABLE)
    threads = defaultdict(list)
    for e in ba_table.list_entities():
        if e["PartitionKey"] == BA_SEQ_PARTITION:
            continue
        d = _ba_entry_dict(e)
        threads[d["threadId"]].append(d)
    for tid in threads:
        threads[tid].sort(key=lambda d: str(d.get("createdAt", "")))

    def _title_of(tid):
        for d in threads.get(tid, []):
            if d.get("type") == "new" and d.get("title"):
                return d["title"]
        return "(タイトル未取得)"

    out = [
        "# WIP作業台（s1）ライブ",
        "",
        "★=重要 / ・=通常。各タスクに紐づくbaスレッド全体を時系列で載せる。",
        "",
    ]
    if not s1:
        out.append("_作業台は空です。_")
    else:
        # 依頼仕様: ★重要を上、その中は新しい順(createdAt降順)。
        for d in sorted(
            s1,
            key=lambda d: (bool(d.get("important")), str(d.get("createdAt", ""))),
            reverse=True,
        ):
            star = "★" if d.get("important") else "・"
            who = (d.get("assignee") or "").strip() or "未"
            due = f" / 予定:{d['plannedDate']}" if d.get("plannedDate") else ""
            reg = str(d.get("createdAt", ""))[:10]
            baId = d.get("baId")
            out.append(f"## {star} {_title_of(baId)}")
            out.append(f"担当:{who}{due} / 登録:{reg} / `{baId}`")
            out.append("")
            entries = threads.get(baId, [])
            if not entries:
                out.append("_(baスレッド未取得)_")
            for ent in entries:
                out.append(_render_entry(ent))
                out.append("")
    out += [f"_件数: {len(s1)}_"]
    return "\n".join(out) + "\n"


@bp.function_name(name="wip-tasks-md")
@bp.route(route="s1.md", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def wip_tasks_md(req: func.HttpRequest) -> func.HttpResponse:
    return func.HttpResponse(
        _render_s1_body(),
        mimetype="text/plain",
        headers={
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        },
    )


@bp.function_name(name="wip-tasks-html")
@bp.route(route="s1.html", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def wip_tasks_html(req: func.HttpRequest) -> func.HttpResponse:
    return func.HttpResponse(
        _render_s1_body(),
        mimetype="text/html",
        headers={
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        },
    )
