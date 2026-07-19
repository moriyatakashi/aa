// ba-35残課題(2): ログイン無しで閲覧できる「公開閲覧モード」(common/auth.jsのAA_PUBLIC_VIEW)を
// 検証する。ログインイベントを一切発火させずに#contentが表示され、データも取得できることを
// 確認する(k2・beは元々書き込みUIを持たないため、閲覧のみのシンプルなケース)。
// n1・n2は書き込みフォームを持つため、未ログインで書き込みボタンを押すと通信(401)せずに
// ログインへ誘導される(window.aaShowLoginGate)ことも検証する。
// Stage2はk2のみが対象(パイロット)、Stage4でbe、Stage5でn1/n2を追加。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
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

const BA_FIXTURE = [
  { id: "T1", threadId: "T1", by: "claude-pc", ref: null, type: "new", seq: 1, createdAt: "2026-07-14T00:00:01+00:00", title: "公開閲覧テスト用", tags: ["案件"], body: "本文" },
];

const PAGES = {
  k2: {
    routes: { [`${API_BASE}/ba`]: () => ({ status: 200, body: BA_FIXTURE }) },
    async assertLoaded(page) {
      await page.waitForFunction(() => document.querySelectorAll("#radarSvg polygon").length > 0, null, { timeout: 5000 });
    },
  },
  be: {
    routes: { [`${API_BASE}/scores`]: () => ({ status: 200, body: [{ date: "2026-07-18", score: 80, note: "" }] }) },
    async assertLoaded(page) {
      await page.waitForFunction(() => document.getElementById("statLatest")?.textContent === "80", null, { timeout: 5000 });
    },
  },
  n1: {
    routes: {
      [`${API_BASE}/scores`]: () => ({ status: 200, body: [] }),
      [`${API_BASE}/visits`]: () => ({ status: 200, body: [{ id: "1", date: "2026-07-18", place: "Osaka", time: "10:00", memo: "m" }] }),
    },
    routeRegex: [[/\/api\/scores\/\d{4}-\d{2}-\d{2}$/, () => ({ status: 404, body: "" })]],
    async assertLoaded(page) {
      await page.waitForSelector(".day-card", { timeout: 5000 });
    },
    async assertWriteRequiresLogin(page) {
      await page.click("#btnSaveScore");
      assert.equal(await page.textContent("#scoreSaved"), "保存にはログインが必要です");
      assert.equal(await page.isVisible("#login-gate"), true, "書き込み試行後はログインゲートが表示されるはず");
    },
  },
  n2: {
    routes: {
      [`${API_BASE}/visits`]: () => ({ status: 200, body: [{ id: "1", date: "2026-07-18", time: "10:00", place: "Osaka Castle", lat: 34.687, lng: 135.526 }] }),
    },
    async assertLoaded(page) {
      await page.waitForFunction(() => document.getElementById("statTotal")?.textContent === "1", null, { timeout: 5000 });
    },
    async assertWriteRequiresLogin(page) {
      await page.fill("#placeInput", "テスト地点");
      await page.click("#btnAddVisit");
      assert.equal(await page.textContent("#visitInputStatus"), "追加にはログインが必要です");
      assert.equal(await page.isVisible("#login-gate"), true, "書き込み試行後はログインゲートが表示されるはず");
    },
  },
};

for (const [pageName, spec] of Object.entries(PAGES)) {
  test(`${pageName}: ログインイベントを一切発火させずに#contentが表示されデータも見える(AA_PUBLIC_VIEW)`, async () => {
    const server = await serveStatic();
    const port = server.address().port;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext(); // localStorageなしの新規コンテキスト
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));

      await page.route("https://accounts.google.com/gsi/client", (route) =>
        route.fulfill({ contentType: "text/javascript", body: "" })
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

      // 意図的にhandleCredentialResponse等のログイン操作は一切行わない
      await page.goto(`http://localhost:${port}/src/${pageName}/`);
      await spec.assertLoaded(page);

      assert.equal(await page.isVisible("#content"), true, "ログイン無しで#contentが表示されるはず(AA_PUBLIC_VIEW)");
      assert.equal(await page.isHidden("#login-gate"), true, "ログイン無しではフルゲートは隠れているはず");
      assert.equal(await page.isVisible("#aa-login-link"), true, "ログイン無し時は小さな「ログイン」リンクが出るはず");

      if (spec.assertWriteRequiresLogin) await spec.assertWriteRequiresLogin(page);

      assert.deepEqual(pageErrors, [], "ページ読み込み中にJS例外が発生している");
    } finally {
      await browser.close();
      server.close();
    }
  });
}
