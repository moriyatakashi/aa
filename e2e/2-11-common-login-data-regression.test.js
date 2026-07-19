// ba-9の残タスク(2): API_BASEをcommon/config.jsへ集約したリファクタ後、
// n1/n2/k2/baがクリーンな状態(localStorageなし)でログイン→config.js解決→
// データ取得まで通しで壊れていないかの回帰確認。
// config.jsの自己importが効いていない場合、AA_API_BASEがundefinedになり
// フェッチ先が".../undefined/..."になる(2026-07-16の表示不具合と同型)ため、
// そのパターンのリクエストが発生していないことも合わせて検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/json" };
const API_BASE = "https://ab-board-api.azurewebsites.net/api";

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

// btoa()はASCII専用のため、日本語などマルチバイト文字を含む名前は使わない
const FAKE_GOOGLE_CREDENTIAL = "header." + Buffer.from(JSON.stringify({ name: "Test User" })).toString("base64") + ".sig";

const BA_FIXTURE = [
  { id: "T1", threadId: "T1", by: "claude-pc", ref: null, type: "new", seq: 1, createdAt: "2026-07-14T00:00:01+00:00", title: "回帰確認用スレッド", tags: ["案件"], body: "本文" },
];

const PAGES = {
  n1: {
    routes: {
      [`${API_BASE}/scores`]: () => ({ status: 200, body: [{ date: "2026-07-18", score: 80, note: "test" }] }),
      [`${API_BASE}/visits`]: () => ({ status: 200, body: [{ id: "1", date: "2026-07-18", place: "Osaka", time: "10:00", memo: "m" }] }),
    },
    routeRegex: [[/\/api\/scores\/\d{4}-\d{2}-\d{2}$/, () => ({ status: 404, body: "" })]],
    async assertLoaded(page) {
      await page.waitForSelector(".day-card", { timeout: 5000 });
      assert.match(await page.textContent("#loadStatus"), /\d+ 日分/);
    },
  },
  n2: {
    routes: {
      [`${API_BASE}/visits`]: () => ({ status: 200, body: [{ id: "1", date: "2026-07-18", time: "10:00", place: "Osaka Castle", lat: 34.687, lng: 135.526 }] }),
    },
    async assertLoaded(page) {
      await page.waitForFunction(() => document.getElementById("statTotal")?.textContent === "1", null, { timeout: 5000 });
    },
  },
  k2: {
    routes: {
      [`${API_BASE}/ba`]: () => ({ status: 200, body: BA_FIXTURE }),
    },
    async assertLoaded(page) {
      await page.waitForFunction(() => document.querySelectorAll("#radarSvg polygon").length > 0, null, { timeout: 5000 });
    },
  },
  ba: {
    routes: {
      [`${API_BASE}/ba`]: () => ({ status: 200, body: BA_FIXTURE }),
    },
    async assertLoaded(page) {
      await page.waitForSelector('[data-thread-id="T1"]', { timeout: 5000 });
      assert.equal(await page.textContent(".thread-title"), "回帰確認用スレッド");
    },
  },
};

for (const [pageName, spec] of Object.entries(PAGES)) {
  test(`${pageName}: クリーンな状態からログイン→config.js解決→データ表示まで壊れていない(ba-9)`, async () => {
    const server = await serveStatic();
    const port = server.address().port;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext(); // localStorage等は常にクリーンな新規コンテキスト
      const page = await context.newPage();

      const brokenRequests = [];
      const consoleErrors = [];
      // console"error"にはscores/{today}未登録時の意図した404通知(ブラウザの
      // リソース読込ログ)も混じるため、実際のJS例外(pageerror)だけを見る。
      page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));
      page.on("request", (req) => {
        if (req.url().includes("/undefined")) brokenRequests.push(req.url());
      });

      await page.route("https://accounts.google.com/gsi/client", (route) =>
        route.fulfill({ contentType: "text/javascript", body: "" })
      );
      await page.route(`${API_BASE}/session`, (route) =>
        route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ sessionToken: "session:testid.testsig" }) })
      );
      for (const [url, handler] of Object.entries(spec.routes)) {
        await page.route(url, (route) => {
          const { status, body } = handler();
          route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
        });
      }
      for (const [regex, handler] of spec.routeRegex || []) {
        await page.route(regex, (route) => {
          const { status, body } = handler();
          route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
        });
      }

      await page.goto(`http://localhost:${port}/src/${pageName}/`);
      await page.evaluate((cred) => window.handleCredentialResponse({ credential: cred }), FAKE_GOOGLE_CREDENTIAL);
      await page.waitForSelector("#content", { state: "visible" });

      await spec.assertLoaded(page);

      assert.deepEqual(brokenRequests, [], "AA_API_BASEが未解決のリクエスト(.../undefined/...)が発生している");
      assert.deepEqual(consoleErrors, [], "ページ読み込み中にconsoleエラーが発生している");
    } finally {
      await browser.close();
      server.close();
    }
  });
}
