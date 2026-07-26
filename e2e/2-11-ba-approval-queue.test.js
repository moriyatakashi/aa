// ba-77: 承認キュー。claudeがproposeFor:"takashi"付きで投函した提案は「承認待ち」バッジ+ボタンで
// 表示され、クリックするとtype:"approval"/approvesIdをそのエントリのidにしてPOSTされることを確認する。
// 既にapprovalが存在するエントリは「承認済み」バッジのみでボタンは出ない。
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

// D: 承認待ち(proposeForのみ) / E: 承認済み(approvalエントリあり)
const T = "2026-07-26T00:00:0";
const FIXTURE = [
  { id: "D", threadId: "D", by: "claude-pc", ref: null, type: "new", seq: 1, createdAt: `${T}1+00:00`, title: "承認待ちスレッド", body: "本文D", proposeFor: "takashi" },
  { id: "E", threadId: "E", by: "claude-pc", ref: null, type: "new", seq: 2, createdAt: `${T}2+00:00`, title: "承認済みスレッド", body: "本文E", proposeFor: "takashi" },
  { id: "E1", threadId: "E", by: "takashi", ref: "E", type: "approval", seq: null, createdAt: `${T}3+00:00`, approvesId: "E" },
];

test("ba: 承認待ち提案にはバッジ+ボタン、承認済みはバッジのみ、ボタンクリックでapprovalがPOSTされる", async () => {
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
    await page.waitForSelector('[data-thread-id="D"]');

    const cardD = page.locator('[data-thread-id="D"]');
    assert.equal(await cardD.locator(".approval-badge--pending").count(), 1, "承認待ちバッジが出る");
    assert.equal(await cardD.locator(".btn-approve").count(), 1, "承認待ちには承認ボタンが出る");

    const cardE = page.locator('[data-thread-id="E"]');
    assert.equal(await cardE.locator(".approval-badge--approved").count(), 1, "承認済みバッジが出る");
    assert.equal(await cardE.locator(".btn-approve").count(), 0, "承認済みにはボタンを出さない");

    const [postRequest] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("/api/ba") && req.method() === "POST"),
      cardD.locator(".btn-approve").click(),
    ]);
    const sent = JSON.parse(postRequest.postData());
    assert.equal(sent.type, "approval");
    assert.equal(sent.ref, "D");
    assert.equal(sent.approvesId, "D");
    assert.equal(sent.credential, "test");
  } finally {
    await browser.close();
    server.close();
  }
});
