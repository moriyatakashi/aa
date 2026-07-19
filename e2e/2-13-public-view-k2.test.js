// ba-35残課題(2) Stage2: k2をパイロットに、ログイン無しで閲覧できる「公開閲覧モード」
// (common/auth.jsのAA_PUBLIC_VIEW)を検証する。ログインイベントを一切発火させずに
// #contentが表示され、データも取得できることを確認する(bb・k2・beは元々書き込みUIを
// 持たないため、閲覧のみのシンプルなケース)。
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

test("k2: ログインイベントを一切発火させずに#contentが表示されデータも見える(AA_PUBLIC_VIEW)", async () => {
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
    await page.route(`${API_BASE}/ba`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BA_FIXTURE) })
    );

    // 意図的にhandleCredentialResponse等のログイン操作は一切行わない
    await page.goto(`http://localhost:${port}/src/k2/`);
    await page.waitForFunction(() => document.querySelectorAll("#radarSvg polygon").length > 0, null, { timeout: 5000 });

    assert.equal(await page.isVisible("#content"), true, "ログイン無しで#contentが表示されるはず(AA_PUBLIC_VIEW)");
    assert.equal(await page.isHidden("#login-gate"), true, "ログイン無しではフルゲートは隠れているはず");
    assert.equal(await page.isVisible("#aa-login-link"), true, "ログイン無し時は小さな「ログイン」リンクが出るはず");
    assert.deepEqual(pageErrors, [], "ページ読み込み中にJS例外が発生している");
  } finally {
    await browser.close();
    server.close();
  }
});
