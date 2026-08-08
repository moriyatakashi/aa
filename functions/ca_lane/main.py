# ca-lane -- Claudeレーン専用の最小HTTPSエンドポイント(P4、ba-242参照)。
#
# 役割はclaude_keyの照合とFirestore(caThreads)へのAdmin SDK書き込みだけ。
# 読み取り・人間の書き込みはこのFunctionを経由しない(ca.htmlからFirestoreへ直接、
# Security Rules(../../firestore.rules)が認可を担う)。
#
# ba(aa/api/function_app.py の _ba_claude_lane)と同じ判定パターン:
# CA_CLAUDE_KEY_PC / CA_CLAUDE_KEY_MOBILE のどちらと一致したかでby(claude-pc/claude-mobile)を決める。

import os
import json
from datetime import datetime, timezone

import functions_framework
import firebase_admin
from firebase_admin import firestore

if not firebase_admin._apps:
    firebase_admin.initialize_app()

db = firestore.client()

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


def _json_response(payload, status=200):
    headers = {"Content-Type": "application/json", **CORS_HEADERS}
    return (json.dumps(payload, ensure_ascii=False), status, headers)


def _claude_lane(claude_key):
    """渡された鍵がPC用/スマホ用のどちらと一致するかを判定する。
    一致しなければNone(ba-244で指摘されたクライアント側の偏りは、
    サーバー側はba同様もとから両方チェックしているので踏襲するだけでよい)。"""
    if not claude_key:
        return None
    pc_key = os.environ.get("CA_CLAUDE_KEY_PC", "")
    mobile_key = os.environ.get("CA_CLAUDE_KEY_MOBILE", "")
    if pc_key and claude_key == pc_key:
        return "claude-pc"
    if mobile_key and claude_key == mobile_key:
        return "claude-mobile"
    return None


@functions_framework.http
def ca_lane(request):
    if request.method == "OPTIONS":
        return ("", 204, CORS_HEADERS)

    if request.method != "POST":
        return _json_response({"error": "POST only"}, 405)

    body = request.get_json(silent=True) or {}

    by = _claude_lane(body.get("claude_key", ""))
    if not by:
        return _json_response({"error": "invalid or missing claude_key"}, 403)

    action = body.get("action")
    # c1.html設計方針「書き込みは--dry-run標準搭載」(ba-242 note)。dry_run=trueは
    # 検証(必須項目・rootless防止チェック)だけ行い、実際のset()は呼ばない。
    dry_run = bool(body.get("dry_run"))
    now = datetime.now(timezone.utc).isoformat()

    if action == "new":
        title = (body.get("title") or "").strip()
        if not title:
            return _json_response({"error": "title required"}, 400)
        if dry_run:
            return _json_response({"ok": True, "dry_run": True, "by": by, "title": title})
        doc_ref = db.collection("caThreads").document()
        doc_ref.set({
            "title": title,
            "body": body.get("body", ""),
            "class": body.get("class", ""),
            "by": by,
            "createdAt": now,
            "status": "open",
        })
        return _json_response({"ok": True, "threadId": doc_ref.id, "by": by})

    if action == "note-add":
        thread_id = body.get("threadId")
        note_body = (body.get("body") or "").strip()
        if not thread_id or not note_body:
            return _json_response({"error": "threadId and body required"}, 400)
        thread_ref = db.collection("caThreads").document(thread_id)
        if not thread_ref.get().exists:
            # rootless防止(ba-72/ba-101と同じ考え方)。dry_runでも実データで確認する
            # (存在チェックまでが検証の一部、これをスキップすると事故防止にならない)。
            return _json_response({"error": "thread not found (rootless防止)", "threadId": thread_id}, 400)
        if dry_run:
            return _json_response({"ok": True, "dry_run": True, "by": by, "threadId": thread_id})
        note_ref = thread_ref.collection("notes").document()
        note_ref.set({
            "body": note_body,
            "by": by,
            "createdAt": now,
        })
        return _json_response({"ok": True, "noteId": note_ref.id, "by": by})

    return _json_response({"error": f"unknown action: {action}"}, 400)
