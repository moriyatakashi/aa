// ba-130: 分類はnew投稿時にしか選べなかった問題への対応。レーンフォームに分類変更用の
// セレクト+ボタンを追加し、選択してクリックするとtype:"note"にtagsを載せてPOSTされることを確認する。
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

const T = "2026-07-26T02:00:0";
const FIXTURE = [
  { id: "G", threadId: "G", by: "takashi", ref: null, type: "new", seq: 1, createdAt: `${T}1+00:00`, title: "分類変更の検証用スレッド", tags: ["気づき"], body: "本文G" },
];

test("ba: 分類変更セレクトで選んでボタンを押すと、tagsを載せたtype:noteがPOSTされる", async () => {
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
    await page.waitForSelector('[data-thread-id="G"]');

    const cardG = page.locator('[data-thread-id="G"]');
    await cardG.locator(".reclass-select").selectOption("確定仕様");

    const [postRequest] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("/api/ba") && req.method() === "POST"),
      cardG.locator(".btn-reclassify").click(),
    ]);
    const sent = JSON.parse(postRequest.postData());
    assert.equal(sent.type, "note");
    assert.equal(sent.ref, "G");
    assert.deepEqual(sent.tags, ["確定仕様"]);
    assert.equal(sent.credential, "test");
  } finally {
    await browser.close();
    server.close();
  }
});
