// k2(baレーダーチャート)の集計ロジックの検証。
// (1) 投稿者別タブ: スレッドに発言した投稿者(by)ごとの参加スレッド数(open/closed問わず)。
// (2) 分類別タブ: スレッド内で最後に見つかった分類タグ(4分類)がそのスレッドの分類になる
//     (同スレッド内で分類タグが後から上書きされた場合は新しい方を採用)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function serveStatic() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p.endsWith("/")) p += "index.html";
      fs.readFile(path.join(ROOT, p), (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, () => resolve(server));
  });
}

// T1: claude-pc(確定仕様タグ)→takashi(気づきタグで上書き)。参加=claude-pc,takashi。分類=気づき(最新)。
// T2: claude-mobile(案件タグ)のみ。参加=claude-mobile。分類=案件。
// T3: claude-pc(タグなし)→claude-mobile(保留論点タグ)。参加=claude-pc,claude-mobile。分類=保留論点。
const T = "2026-07-17T01:00:0";
const FIXTURE = [
  { id: "T1", threadId: "T1", by: "claude-pc", ref: null, type: "new", seq: 1, createdAt: `${T}1+00:00`, title: "T1", body: "a", tags: ["確定仕様"] },
  { id: "T1-1", threadId: "T1", by: "takashi", ref: "T1", type: "note", seq: null, createdAt: `${T}2+00:00`, body: "b", tags: ["気づき"] },
  { id: "T2", threadId: "T2", by: "claude-mobile", ref: null, type: "new", seq: 2, createdAt: `${T}3+00:00`, title: "T2", body: "c", tags: ["案件"] },
  { id: "T3", threadId: "T3", by: "claude-pc", ref: null, type: "new", seq: 3, createdAt: `${T}4+00:00`, title: "T3", body: "d" },
  { id: "T3-1", threadId: "T3", by: "claude-mobile", ref: "T3", type: "note", seq: null, createdAt: `${T}5+00:00`, body: "e", tags: ["保留論点"] },
];

test("k2: 投稿者別/分類別のスレッド集計が期待通りに出る", async () => {
  const server = await serveStatic();
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("https://accounts.google.com/gsi/client", (route) =>
      route.fulfill({ contentType: "text/javascript", body: "" })
    );
    await page.route("https://ab-board-api.azurewebsites.net/api/ba", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(FIXTURE) })
    );

    await page.goto(`http://localhost:${port}/src/k2/`);
    // ログインゲートは通さず、auth.jsが発火するのと同じイベントで直接開ける
    await page.evaluate(() => {
      document.getElementById("content").style.display = "block";
      window.__credential = "test";
      window.dispatchEvent(new Event("k2-login-success"));
    });
    await page.waitForSelector("#radarTableBody tr");

    const posterRows = await page.locator("#radarTableBody tr").allTextContents();
    assert.deepEqual(
      posterRows.map((r) => r.replace(/\s+/g, "")),
      ["claude-pc2", "takashi1", "claude-mobile2"],
      "投稿者別: claude-pc=T1,T3(2) / takashi=T1(1) / claude-mobile=T2,T3(2)"
    );

    await page.click('.view-tab[data-view="classification"]');
    await page.waitForFunction(() => document.getElementById("radarTableHead").textContent.includes("分類"));
    const clsRows = await page.locator("#radarTableBody tr").allTextContents();
    assert.deepEqual(
      clsRows.map((r) => r.replace(/\s+/g, "")),
      ["案件1", "確定仕様0", "気づき1", "保留論点1"],
      "分類別: T1は気づき(後から上書き)、T2は案件、T3は保留論点"
    );
  } finally {
    await browser.close();
    server.close();
  }
});
