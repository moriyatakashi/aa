// ba-175: gist型(確定仕様スレッドの「今の結論」一言)の表示検証。
// baページ(.thread-gist)とbbページ(.bb-gist)の両方で、最新のgist textが表示されること、
// gist未投稿のスレッドでは何も表示されない(空でクラッシュしない)ことを確認する。
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

// A=確定仕様・gist複数回投稿(最新が勝つことを確認) / B=確定仕様・gist無し(表示自体が出ないこと確認)
const T = "2026-07-29T00:00:0";
const FIXTURE = [
  { id: "A", threadId: "A", by: "claude-pc", ref: null, type: "new", seq: 1, createdAt: `${T}1+00:00`, title: "スレッドA", body: "本文A", tags: ["確定仕様"] },
  { id: "A1", threadId: "A", by: "claude-pc", ref: "A", type: "gist", seq: null, createdAt: `${T}2+00:00`, text: "古い結論" },
  { id: "A2", threadId: "A", by: "takashi", ref: "A", type: "gist", seq: null, createdAt: `${T}3+00:00`, text: "最新の結論" },
  { id: "B", threadId: "B", by: "claude-pc", ref: null, type: "new", seq: 2, createdAt: `${T}4+00:00`, title: "スレッドB", body: "本文B", tags: ["確定仕様"] },
];

test("ba: gistは最新のtextが.thread-gistに表示され、未投稿スレッドには出ない", async () => {
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

    await page.goto(`http://localhost:${port}/src/ba/`);
    await page.evaluate(() => {
      document.getElementById("content").style.display = "block";
      window.__credential = "test";
      window.dispatchEvent(new Event("ba-login-success"));
    });
    await page.waitForSelector('[data-thread-id="A"]');

    const cardA = page.locator('[data-thread-id="A"]');
    assert.equal(await cardA.locator(".thread-gist").count(), 1);
    assert.equal((await cardA.locator(".thread-gist").textContent()).trim(), "最新の結論");

    const cardB = page.locator('[data-thread-id="B"]');
    assert.equal(await cardB.locator(".thread-gist").count(), 0, "gist未投稿のスレッドには.thread-gist自体が出ない");
  } finally {
    await browser.close();
    server.close();
  }
});

test("bb: gistは最新のtextが.bb-gistに表示され、未投稿スレッドには出ない", async () => {
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

    const sectionsText = await page.textContent("#sections");
    assert.ok(sectionsText.includes("最新の結論"));
    assert.ok(!sectionsText.includes("古い結論"), "最新のgistだけが勝ち、古いtextは出ない");

    assert.equal(await page.locator(".bb-gist").count(), 1, "gist未投稿のスレッドBには.bb-gistが増えない");
  } finally {
    await browser.close();
    server.close();
  }
});
