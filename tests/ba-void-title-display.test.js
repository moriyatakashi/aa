// baフロントの表示ルール2点の検証。
// (1) 無効フラグはclaude視点(PC/スマホ合算)とtakashi視点の両方がvoid=trueのときだけ
//     既定で一覧から隠れ、「無効スレッドも表示」トグルで薄色表示できる。
//     片方の視点だけvoid=認識が食い違っているスレッドは隠れない(齟齬を拾えなくなるため)。
// (2) titleを持つcorrectionエントリで見出し表示だけが上書きされる(タイトル訂正、有事用)。
//     上書きはtitleに限定し、元のタイトルはスレッド内の起点エントリに残って読める。
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

// APIの生データを模したフィクスチャ。A=通常 / B=claude視点のみvoid(隠れない) /
// C=両視点void+タイトル訂正(既定で隠れ、トグルで薄色表示)
const T = "2026-07-14T00:00:0";
const FIXTURE = [
  { id: "A", threadId: "A", by: "claude-pc", ref: null, type: "new", seq: 1, createdAt: `${T}1+00:00`, title: "通常のスレッド", body: "本文A" },
  { id: "B", threadId: "B", by: "claude-pc", ref: null, type: "new", seq: 2, createdAt: `${T}2+00:00`, title: "claude視点だけ無効のスレッド", body: "本文B" },
  { id: "B1", threadId: "B", by: "claude-pc", ref: "B", type: "void", seq: null, createdAt: `${T}3+00:00`, value: true },
  { id: "C", threadId: "C", by: "claude-mobile", ref: null, type: "new", seq: 3, createdAt: `${T}4+00:00`, title: "誤字のある旧タイトル", body: "本文C" },
  { id: "C1", threadId: "C", by: "claude-mobile", ref: "C", type: "correction", seq: null, createdAt: `${T}5+00:00`, title: "訂正後のタイトル" },
  { id: "C2", threadId: "C", by: "claude-mobile", ref: "C", type: "void", seq: null, createdAt: `${T}6+00:00`, value: true },
  { id: "C3", threadId: "C", by: "takashi", ref: "C", type: "void", seq: null, createdAt: `${T}7+00:00`, value: true },
];

test("ba: 両視点voidの既定非表示/トグル表示と、correctionによるタイトル訂正表示", async () => {
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

    await page.goto(`http://localhost:${port}/ba/`);
    // ログインゲートは通さず、auth.jsが発火するのと同じイベントで直接開ける
    await page.evaluate(() => {
      document.getElementById("content").style.display = "block";
      window.__credential = "test";
      window.dispatchEvent(new Event("ba-login-success"));
    });
    await page.waitForSelector('[data-thread-id="A"]');

    // 既定: Cだけ隠れる(Bは片方の視点だけvoidなので残る)
    assert.equal(await page.isVisible('[data-thread-id="A"]'), true);
    assert.equal(await page.isVisible('[data-thread-id="B"]'), true, "片方の視点だけvoidのスレッドは隠さない(齟齬を拾うため)");
    assert.equal(await page.locator('[data-thread-id="C"]').count(), 0, "両視点voidのスレッドは既定で隠れる");
    assert.equal(await page.textContent("#btnToggleVoid"), "無効スレッドも表示(1)");

    // トグルON: Cが薄色スタイル+訂正後タイトル+訂正済みチップで現れる
    await page.click("#btnToggleVoid");
    const cardC = page.locator('[data-thread-id="C"]');
    assert.equal(await cardC.count(), 1);
    assert.ok((await cardC.getAttribute("class")).includes("thread-card--void"));
    assert.equal((await cardC.locator(".thread-title").textContent()).trim(), "訂正後のタイトル");
    assert.equal(await cardC.locator(".title-corrected-chip").count(), 1);
    assert.ok((await cardC.textContent()).includes("誤字のある旧タイトル"), "元のタイトルはスレッド内に残って読める");
    assert.equal(await page.textContent("#btnToggleVoid"), "無効スレッドを隠す(1)");

    // トグルOFF: 再び隠れる
    await page.click("#btnToggleVoid");
    assert.equal(await page.locator('[data-thread-id="C"]').count(), 0);
  } finally {
    await browser.close();
    server.close();
  }
});
