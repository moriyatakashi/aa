// react: 3レーン(takashi/claude-pc/claude-mobile)それぞれの軽い反応(参考程度、判断根拠にしない)。
// レーンごとに反応チップが独立して表示され(voidと違い集約しない)、takashi自身の反応は
// レーンフォームのボタンでトグルでき、クリックするとtype:"react"がPOSTされることを確認する。
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

// F: claude-pcとtakashiが反応済み、claude-mobileは未反応
const T = "2026-07-26T01:00:0";
const FIXTURE = [
  { id: "F", threadId: "F", by: "claude-pc", ref: null, type: "new", seq: 1, createdAt: `${T}1+00:00`, title: "反応チップの検証用スレッド", body: "本文F" },
  { id: "F1", threadId: "F", by: "claude-pc", ref: "F", type: "react", seq: null, createdAt: `${T}2+00:00`, value: true },
  { id: "F2", threadId: "F", by: "takashi", ref: "F", type: "react", seq: null, createdAt: `${T}3+00:00`, value: true },
];

test("ba: レーン別の反応チップが独立して表示され、takashi自身の反応ボタンでtype:reactがPOSTされる", async () => {
  const server = await serveStatic();
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("https://accounts.google.com/gsi/client", (route) =>
      route.fulfill({ contentType: "text/javascript", body: "" })
    );
    await page.route("https://ab-board-api.azurewebsites.net/api/ba", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ contentType: "application/json", status: 201, body: "{}" });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(FIXTURE) });
    });

    await page.goto(`http://localhost:${port}/src/ba/`);
    await page.evaluate(() => {
      document.getElementById("content").style.display = "block";
      window.__credential = "test";
      window.dispatchEvent(new Event("ba-login-success"));
    });
    await page.waitForSelector('[data-thread-id="F"]');

    const cardF = page.locator('[data-thread-id="F"]');
    const chips = cardF.locator(".react-chip");
    assert.equal(await chips.count(), 3, "3レーン分のチップが出る");
    assert.equal(await chips.nth(0).innerText(), "利尻✓", "claude-pcは反応済み");
    assert.equal(await chips.nth(1).innerText(), "すまさん", "claude-mobileは未反応(チェック無し)");
    assert.equal(await chips.nth(2).innerText(), "takashi✓", "takashiは反応済み");
    assert.equal(await chips.nth(1).getAttribute("class"), "react-chip", "未反応のチップに--onは付かない");

    assert.equal(await cardF.locator(".btn-toggle-react").innerText(), "反応を取り消す", "takashiは既に反応済みなので取り消す表記");

    const [postRequest] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("/api/ba") && req.method() === "POST"),
      cardF.locator(".btn-toggle-react").click(),
    ]);
    const sent = JSON.parse(postRequest.postData());
    assert.equal(sent.type, "react");
    assert.equal(sent.ref, "F");
    assert.equal(sent.value, false, "既にtakashiが反応済みなのでクリックで取り消し(false)になる");
    assert.equal(sent.credential, "test");
  } finally {
    await browser.close();
    server.close();
  }
});
