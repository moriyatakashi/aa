"""Google Drive(drive.fileスコープ)バックアップ用のrefresh tokenを取り直すためのローカル専用
スクリプト。backup-balog-to-drive.py(GitHub Actions、毎日4時JST)が使うGDRIVE_OAUTH_REFRESH_TOKEN
シークレットの再発行用。get_gcal_refresh_token.pyと同じOAuthクライアント(aapj-501407の
Desktopアプリ)・同じ形を使う(scopeだけdrive.fileに変えたもの)。

背景(2026-08-07): OAuth同意画面が「テスト」モードのままの個人プロジェクト(組織に属さない
GCPプロジェクトはIAP brands APIで公開ステータスを操作できない)だと、テストユーザーの
refresh tokenは発行から7日で失効する。2026-07-25発行のトークンが2026-08-01から
invalid_grant(Token has been expired or revoked)で失敗し始めたのはこれが原因。
恒久対策(Google Cloud Console → APIs & Services → OAuth consent screen → Publish App)を
していない限り、このスクリプトでの再発行は概ね7日おきに必要になる。

Takashi本人がブラウザで認可URLを開いてログイン・同意する必要がある(この場では
サーバーの待受とトークン交換までを行う)。

使い方:
  python scripts/get_drive_refresh_token.py
  表示されたURLをブラウザで開いて同意すると、このスクリプトがrefresh tokenを表示する。
  表示された値をGitHub Actionsのシークレット(GDRIVE_OAUTH_REFRESH_TOKEN, repo: moriyatakashi/aa)
  に反映すること(`gh secret set GDRIVE_OAUTH_REFRESH_TOKEN --repo moriyatakashi/aa`)。

前提: ローカルの C:\\Users\\takas\\.claude\\ba_backup_oauth_client.json に
既存のclient_id/client_secretがある(Calendar用取得スクリプトと共用)。
"""
import http.server
import json
import threading
import urllib.parse
import webbrowser
from pathlib import Path

import requests

CLIENT_FILE = r"C:\Users\takas\.claude\ba_backup_oauth_client.json"
TOKEN_FILE = Path(r"C:\Users\takas\.claude\ba_backup_refresh_token.json")
AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/drive.file"

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
    print("取得成功。")
    print("次のコマンドでGitHub Actionsシークレットに反映してください:")
    print("  gh secret set GDRIVE_OAUTH_REFRESH_TOKEN --repo moriyatakashi/aa")
    print("  (プロンプトが出たら refresh_token の値を貼り付けてEnter → Ctrl+ZやEnterで確定)")

    # ローカルのba_backup_refresh_token.json(get_access_tokenの動作確認用)も更新しておく。
    TOKEN_FILE.write_text(json.dumps({
        "token": tokens.get("access_token"),
        "refresh_token": tokens["refresh_token"],
        "token_uri": TOKEN_URI,
        "client_id": client_id,
        "client_secret": client_secret,
        "scopes": [SCOPE],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"(ローカル控え: {TOKEN_FILE} を更新しました)")


if __name__ == "__main__":
    main()
