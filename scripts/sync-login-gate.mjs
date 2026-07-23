// n1/n2/be/k2/baのindex.htmlに一字一句同一のGoogle One Tapログインゲート
// (id="login-gate"の中身、data-client_idの設定行まで含む)がコピペされていたのを
// src/common/login-gate.template.htmlへ集約し、このスクリプトで各ページへ書き戻す。
// build-index.mjs(トップページのnav.yml化)と同じ「テンプレート+生成」方式だが、
// あちらと違い出力(各index.html)はgitignoreせず引き続きコミットする
// (root以外のindex.htmlは手書き部分が大半を占め、ページ全体をビルド生成物にはしないため)。
// ステータスメッセージを変えたい時は、このAPPSと各index.htmlのLOGIN_GATEマーカーの
// 間の中身を直接編集せず、ここを書き換えて再実行すること。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const APPS = {
  n1: "未ログイン(ログインすると記録一覧が表示されます)",
  n2: "未ログイン(ログインすると訪問地図が表示されます)",
  be: "未ログイン(ログインするとグラフが表示されます)",
  k2: "未ログイン(ログインするとチャートが表示されます)",
  ba: "未ログイン(ログインするとログが表示されます)",
};

const START = "<!-- LOGIN_GATE:START -->";
const END = "<!-- LOGIN_GATE:END -->";

const template = readFileSync(path.join(rootDir, "src/common/login-gate.template.html"), "utf8");

for (const [app, statusMessage] of Object.entries(APPS)) {
  const file = path.join(rootDir, "src", app, "index.html");
  const html = readFileSync(file, "utf8");
  const startIdx = html.indexOf(START);
  const endIdx = html.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`src/${app}/index.html: ${START}〜${END}マーカーが見つかりません`);
  }
  const block = template.replace("{{STATUS_MESSAGE}}", statusMessage);
  const before = html.slice(0, startIdx + START.length);
  const after = html.slice(endIdx);
  writeFileSync(file, `${before}\n${block}${after}`);
}
console.log(`login-gateを同期しました: ${Object.keys(APPS).join(", ")}`);
