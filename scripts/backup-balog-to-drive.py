"""BaLogテーブル(Azure Table Storage)を全件JSONダンプし、Google Driveの
既存フォルダ(ba-backup)へ新規ファイルとして追加する。

追記のみを徹底するため、Drive側の呼び出しはfiles.create(新規作成)のみで、
files.update/files.deleteは一切呼ばない。認可はOAuth(drive.fileスコープ)の
リフレッシュトークンを使う想定(このスコープ自体、このスクリプトが作成した
ファイル以外には触れられない)。サービスアカウントは使わない
(個人Googleアカウントの共有フォルダには書き込めないため)。

必須環境変数:
  TABLE_CONNECTION_STRING   - BaLogテーブルへの接続文字列
  GDRIVE_OAUTH_CLIENT_ID
  GDRIVE_OAUTH_CLIENT_SECRET
  GDRIVE_OAUTH_REFRESH_TOKEN
  GDRIVE_FOLDER_ID          - アップロード先フォルダ(ba-backup)のID
"""
import json
import os
from datetime import datetime, timezone

import requests
from azure.data.tables import TableServiceClient

BA_TABLE = "BaLog"
TOKEN_URI = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"


def _fetch_balog_entities():
    conn_str = os.environ["TABLE_CONNECTION_STRING"]
    service = TableServiceClient.from_connection_string(conn_str)
    table = service.get_table_client(BA_TABLE)
    return [dict(e) for e in table.list_entities()]


def _get_access_token():
    resp = requests.post(TOKEN_URI, data={
        "client_id": os.environ["GDRIVE_OAUTH_CLIENT_ID"],
        "client_secret": os.environ["GDRIVE_OAUTH_CLIENT_SECRET"],
        "refresh_token": os.environ["GDRIVE_OAUTH_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    })
    resp.raise_for_status()
    return resp.json()["access_token"]


def _upload_to_drive(access_token, filename, content_bytes):
    boundary = "balog_backup_boundary"
    metadata = {"name": filename, "parents": [os.environ["GDRIVE_FOLDER_ID"]]}
    body = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        "Content-Type: application/json\r\n\r\n"
    ).encode("utf-8") + content_bytes + f"\r\n--{boundary}--".encode("utf-8")

    resp = requests.post(
        UPLOAD_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": f"multipart/related; boundary={boundary}",
        },
        data=body,
    )
    resp.raise_for_status()
    return resp.json()


def main():
    entities = _fetch_balog_entities()
    content = json.dumps(entities, ensure_ascii=False, default=str).encode("utf-8")

    filename = f"balog_full_{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H%M%SZ')}.json"
    access_token = _get_access_token()
    result = _upload_to_drive(access_token, filename, content)

    print(f"バックアップ完了: {len(entities)}件 -> {filename} (fileId={result['id']})")


if __name__ == "__main__":
    main()
