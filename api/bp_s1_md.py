import azure.functions as func

import function_app
from bp_s1 import _ensure_wip_table, _wip_task_dict
from bp_ba import BA_TABLE, BA_SEQ_PARTITION, _ba_entry_dict

bp = func.Blueprint()

# /api/s1.md (ba-XX): WIP作業台(s1)をJS不要・認証不要のMarkdownで外部AIに公開する。
# 外部のfetch系AI(M365 Copilot等)はJSを実行しないため、s1.htmlの生HTMLは
# 「読み込み中…」の殻しか読めない。ここでサーバ側でs1とbaを結合し、タイトル付きの
# Markdownを1回のfetchで返す。既存のGET /api/s1・/api/ba(いずれも公開)と同じ
# テーブル読み取り関数を使い回し、自己HTTPは挟まない(HTTP一往復を省く)。


@bp.function_name(name="wip-tasks-md")
@bp.route(route="s1.md", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def wip_tasks_md(req: func.HttpRequest) -> func.HttpResponse:
    # s1(WipTasks)とba(BaLog)を既存関数でそのまま読む。s1のGETと同じ_wip_task_dict、
    # baのGETと同じ_ba_entry_dictを使うので、公開APIと同じ見え方になる。
    s1_table = _ensure_wip_table()
    s1 = [_wip_task_dict(e) for e in s1_table.list_entities()]

    ba_table = function_app._table_client(BA_TABLE)
    # titleはthreadの type:"new" に付く。id->title の索引だけ作れれば十分なので
    # 採番カウンタ(_meta)は除外し、titleを持つ行だけ拾う。
    title = {}
    for e in ba_table.list_entities():
        if e["PartitionKey"] == BA_SEQ_PARTITION:
            continue
        d = _ba_entry_dict(e)
        t = d.get("title")
        if t:
            title[d["id"]] = t

    out = ["# WIP作業台（s1）ライブ", "", "★=重要 / ・=通常。", ""]
    if not s1:
        out.append("_作業台は空です。_")
    else:
        # 依頼仕様: ★重要を上、その中は新しい順(createdAt降順)。
        # not important でFalse(重要)が先、createdAtは降順にするため reverse=True。
        # (importantも降順で「重要=True」が先に来るので、キー全体をreverseできる)
        for d in sorted(
            s1,
            key=lambda d: (bool(d.get("important")), str(d.get("createdAt", ""))),
            reverse=True,
        ):
            star = "★" if d.get("important") else "・"
            who = (d.get("assignee") or "").strip() or "未"
            due = f" / 予定:{d['plannedDate']}" if d.get("plannedDate") else ""
            reg = str(d.get("createdAt", ""))[:10]
            t = title.get(d.get("baId"), "(タイトル未取得)")
            out.append(f"- {star} **{t}** — 担当:{who}{due} / 登録:{reg}  `{d.get('baId')}`")
    out += ["", f"_件数: {len(s1)}_"]

    # mimetypeにcharsetを含めるとAzure Functions側が更にcharsetを付け足し、
    # `text/markdown; charset=utf-8; charset=utf-8` と二重になる。mimetypeは
    # 素の`text/markdown`にし、charsetはContent-Typeヘッダで明示する。
    return func.HttpResponse(
        "\n".join(out) + "\n",
        mimetype="text/markdown",
        headers={
            "Content-Type": "text/markdown; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
        },
    )
