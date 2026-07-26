"""Google Calendar読み取り用のrefresh tokenを1回限り取得するためのローカル専用スクリプト
(ba-160)。backup-balog-to-drive.pyと同じOAuthクライアント(aapj-501407のDesktopアプリ)を
使うが、drive.fileスコープの既存refresh tokenでは足りない(スコープは同意時に固定される)ため、
calendar.readonlyスコープで新しくrefresh tokenを取り直す。

Takashi本人がブラウザで認可URLを開いてログイン・同意する必要がある(この場では
サーバーの待受とトークン交換までを行う)。

使い方:
  python scripts/get_gcal_refresh_token.py
  表示されたURLをブラウザで開いて同意すると、このスクリプトがrefresh tokenを表示する。

前提: ローカルの C:\\Users\\takas\\.claude\\ba_backup_oauth_client.json に
既存のclient_id/client_secretがある(Driveバックアップと共用)。
"""
import http.server
import json
import threading
import urllib.parse
import webbrowser

import requests

CLIENT_FILE = r"C:\Users\takas\.claude\ba_backup_oauth_client.json"
AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/calendar.readonly"

_result = {}


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        _result["code"] = qs.get("code", [None])[0]
        _result["error"] = qs.get("error", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        msg = "認可コードを受け取りました。このタブは閉じて構いません。" if _result["code"] else f"エラー: {_result['error']}"
        self.wfile.write(msg.encode("utf-8"))

    def log_message(self, format, *args):
        pass  # 標準出力を汚さない


def main():
    with open(CLIENT_FILE, encoding="utf-8") as f:
        client = json.load(f)["installed"]
    client_id = client["client_id"]
    client_secret = client["client_secret"]

    server = http.server.HTTPServer(("127.0.0.1", 0), _CallbackHandler)
    port = server.server_address[1]
    redirect_uri = f"http://localhost:{port}"

    auth_url = AUTH_URI + "?" + urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
    })

    print("以下のURLをブラウザで開き、takashi.moriya@gmail.comでログイン・同意してください:")
    print(auth_url)
    print()
    print(f"(ローカルの{redirect_uri}で認可コードの受信を待っています...)")
    try:
        webbrowser.open(auth_url)
    except Exception:
        pass

    server.handle_request()  # 1回だけリクエストを受けて終了

    if not _result.get("code"):
        print(f"失敗: {_result.get('error') or '認可コードを受け取れませんでした'}")
        return

    resp = requests.post(TOKEN_URI, data={
        "client_id": client_id,
        "client_secret": client_secret,
        "code": _result["code"],
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    })
    resp.raise_for_status()
    tokens = resp.json()

    print()
    print("取得成功。refresh_token(Azure Function Appの設定 GCAL_OAUTH_REFRESH_TOKEN に使う):")
    print(tokens["refresh_token"])


if __name__ == "__main__":
    main()
