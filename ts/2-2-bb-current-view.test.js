// bbフロント(baの現在形ビューワ)の集計・表示ロジックの検証。
// (1) 両視点voidのスレッドはtoggleしても常に非表示(bb/app.jsのrender()冒頭でフィルタ済み)。
// (2) 既定表示はopenまたは確定仕様のスレッドのみ、closedかつ非確定仕様は「closedも表示」トグルで現れる。
// (3) 統計(スレッド数/オープン数/確定仕様数)がフィルタ前の総数を反映する。
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

// A=未分類・open / B=確定仕様・closed(既定でも表示され続ける) /
// C=非確定仕様・closed(既定で隠れ、トグルで表示) / D=両視点void(トグルしても常に非表示)
const T = "2026-07-17T00:00:0";
const FIXTURE = [
  { id: "A", threadId: "A", by: "claude-pc", ref: null, type: "new", seq: 1, createdAt: `${T}1+00:00`, title: "スレッドA", body: "本文A" },
  { id: "B", threadId: "B", by: "claude-pc", ref: null, type: "new", seq: 2, createdAt: `${T}2+00:00`, title: "スレッドB", body: "本文B", tags: ["確定仕様"] },
  { id: "B1", threadId: "B", by: "takashi", ref: "B", type: "status", seq: null, createdAt: `${T}3+00:00`, status: "closed" },
  { id: "C", threadId: "C", by: "claude-mobile", ref: null, type: "new", seq: 3, createdAt: `${T}4+00:00`, title: "スレッドC", body: "本文C" },
  { id: "C1", threadId: "C", by: "takashi", ref: "C", type: "status", seq: null, createdAt: `${T}5+00:00`, status: "closed" },
  { id: "D", threadId: "D", by: "claude-pc", ref: null, type: "new", seq: 4, createdAt: `${T}6+00:00`, title: "スレッドD", body: "本文D" },
  { id: "D1", threadId: "D", by: "claude-pc", ref: "D", type: "void", seq: null, createdAt: `${T}7+00:00`, value: true },
  { id: "D2", threadId: "D", by: "takashi", ref: "D", type: "void", seq: null, createdAt: `${T}8+00:00`, value: true },
];

test("bb: 確定仕様はclosedでも既定表示、非確定仕様closedはトグルで表示、両視点voidは常に非表示", async () => {
  const server = await serveStatic();
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("https://ab-board-api.azurewebsites.net/api/ba", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(FIXTURE) })
    );

    await page.goto(`http://localhost:${port}/src/bb/`);
    await page.waitForSelector("#sections .bb-item");

    // 統計は両視点voidのDを除いた3スレッド分(A/B/C)
    assert.equal(await page.textContent("#statTotal"), "3");
    assert.equal(await page.textContent("#statOpen"), "1", "openはAのみ(B/Cはclosed)");
    assert.equal(await page.textContent("#statShiyou"), "1", "確定仕様はBのみ");

    // 既定表示: A(open)とB(確定仕様、closedでも表示され続ける)、Cは隠れる、Dは常に隠れる
    const sectionsText = await page.textContent("#sections");
    assert.ok(sectionsText.includes("スレッドA"));
    assert.ok(sectionsText.includes("スレッドB"));
    assert.ok(!sectionsText.includes("スレッドC"), "非確定仕様のclosedは既定で隠れる");
    assert.ok(!sectionsText.includes("スレッドD"), "両視点voidは既定で隠れる");
    assert.equal(await page.textContent("#btnToggleClosed"), "closedも表示(1)");

    // トグルON: Cが現れる、Dは依然として隠れたまま
    await page.click("#btnToggleClosed");
    const afterToggle = await page.textContent("#sections");
    assert.ok(afterToggle.includes("スレッドC"), "トグルで非確定仕様のclosedが現れる");
    assert.ok(!afterToggle.includes("スレッドD"), "両視点voidはトグルしても現れない");
    assert.equal(await page.textContent("#btnToggleClosed"), "closedを隠す(1)");

    // トグルOFF: 再び隠れる
    await page.click("#btnToggleClosed");
    assert.ok(!(await page.textContent("#sections")).includes("スレッドC"));
  } finally {
    await browser.close();
    server.close();
  }
});
