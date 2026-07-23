// common/last-updated.js — 「更新: ...」表示を、そのページのファイルの最新コミット日時から
// 動的に取得して書き換える共通ロジック。n2(ba-50)で個別実装されていたものを共通化した
// (ba-67/ba-68)。手動での日付ハードコード・書き換え忘れを構造的に無くすのが狙い。
//
// GitHub APIには直接アクセスしない(ba-69)。GitHubトークンをクライアント側JSに
// 埋め込むとページソースから誰でも読める状態になり漏洩になるため、代わりに
// ab-board-api(Azure Functions)のlast-updatedエンドポイントを経由する。
// サーバー側がトークン付きでGitHub APIを叩き、結果だけをクライアントへ返す
// (未認証60req/時/IPの制限を、サーバー側の認証済み枠5000req/時に寄せる)。
//
// 取得に失敗した場合(オフライン・API側の不調等)は、HTML側に書いてある
// 静的なフォールバック表記をそのまま残す(フェイルセーフ)。

import { fmtTs } from "./utils.js";

const API_BASE = "https://ab-board-api.azurewebsites.net/api";

// filePath: リポジトリルートからの相対パス(例: "src/k1"、ルートページは"nav.yml"を渡す想定)。
// elementId: 書き換え対象要素のid(既定 "lastUpdated")。
// label: 表示ラベル(既定 "更新"。既存ページの「最終更新」表記はそのまま保つために指定可能)。
export async function applyLastUpdated(filePath, elementId = "lastUpdated", label = "更新") {
  const el = document.getElementById(elementId);
  if (!el) return;
  try {
    const res = await fetch(`${API_BASE}/last-updated?path=${encodeURIComponent(filePath)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.date) return;
    el.textContent = `${label}: ${fmtTs(data.date)}`;
  } catch (e) {
    // ネットワークエラー等。静的表記のまま維持。
  }
}
