"""指定テーブル(Azure Table Storage)を全件JSONダンプし、Google Driveの
既存フォルダ(ba-backup)へ新規ファイルとして追加する。

対象テーブルはscripts/backup_tables.ymlが正(2026-07-31、ハードコードのリストから
切り出し)。ここに追記すればコード変更なしで次回実行から対象に入る
(rbook run yml listにも自動的に載る)。テーブルごとに1ファイル、同じ実行の
中で順番にアップロードする。

追記のみを徹底するため、Drive側の呼び出しはfiles.create(新規作成)のみで、
files.update/files.deleteは一切呼ばない。認可はOAuth(drive.fileスコープ)の
リフレッシュトークンを使う想定(このスコープ自体、このスクリプトが作成した
ファイル以外には触れられない)。サービスアカウントは使わない
(個人Googleアカウントの共有フォルダには書き込めないため)。

必須環境変数:
  TABLE_CONNECTION_STRING   - 対象テーブルへの接続文字列(同一ストレージアカウント)
  GDRIVE_OAUTH_CLIENT_ID
  GDRIVE_OAUTH_CLIENT_SECRET
  GDRIVE_OAUTH_REFRESH_TOKEN
  GDRIVE_FOLDER_ID          - アップロード先フォルダ(ba-backup)のID
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import requests
import yaml
from azure.data.tables import TableServiceClient

BACKUP_TABLES_YML = Path(__file__).resolve().parent / "backup_tables.yml"
TOKEN_URI = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"


def _load_backup_tables():
    with open(BACKUP_TABLES_YML, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return [t["name"] for t in data["tables"]]


def _fetch_table_entities(table_name):
    conn_str = os.environ["TABLE_CONNECTION_STRING"]
    service = TableServiceClient.from_connection_string(conn_str)
    table = service.get_table_client(table_name)
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
    access_token = _get_access_token()
    timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H%M%SZ')

    for table_name in _load_backup_tables():
        entities = _fetch_table_entities(table_name)
        content = json.dumps(entities, ensure_ascii=False, default=str).encode("utf-8")
        filename = f"{table_name.lower()}_full_{timestamp}.json"
        result = _upload_to_drive(access_token, filename, content)
        print(f"バックアップ完了: {table_name} {len(entities)}件 -> {filename} (fileId={result['id']})")


if __name__ == "__main__":
    main()
