// n1/n2は自前でログイン状態をlocalStorageに60分保持し、期限内なら再ログインを省略する
// (auth.jsのrestoreSession)。しかしGoogle Identity Services(GSI)側のOne Tap自動プロンプトは
// このアプリ独自のセッション状態を一切見ないため、セッション復元済みでもGoogleへ
// 「今回は自動サインインを出さないで」と伝える処理(disableAutoSelect等)がなければ、
// 毎回ログインを尋ねられうる。現状のauth.js/index.htmlにはその指示が存在しないため、
// このテストは意図的に赤くなる(既知の未修正バグを可視化するためのテスト)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".geojson": "application/json" };

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

// 実際のGoogleサーバーには問い合わせず、initialize/prompt/disableAutoSelectの
// 呼び出し回数だけを記録するスタブに差し替える(実アカウント状態に依存させないため)。
const GSI_STUB = `
  window.google = { accounts: { id: {
    initialize: () => { window.__gsiInitCalled = (window.__gsiInitCalled || 0) + 1; },
    prompt: () => { window.__gsiPromptCalled = (window.__gsiPromptCalled || 0) + 1; },
    renderButton: () => {},
    disableAutoSelect: () => { window.__disableAutoSelectCalled = (window.__disableAutoSelectCalled || 0) + 1; }
  } } };
`;

for (const pageName of ["n1", "n2"]) {
  test(`${pageName}: 60分以内の復元セッションがあるときはGoogle One Tapの自動プロンプトを止めるべき`, async () => {
    const server = await serveStatic();
    const port = server.address().port;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.route("https://accounts.google.com/gsi/client", (route) =>
        route.fulfill({ contentType: "text/javascript", body: GSI_STUB })
      );
      await page.addInitScript(() => {
        // btoa()はASCII専用のため、日本語などマルチバイト文字を含む名前は使わない
        const cred = "header." + btoa(JSON.stringify({ name: "Test User" })) + ".sig";
        localStorage.setItem("aa_credential", JSON.stringify({ credential: cred, savedAt: Date.now() }));
      });

      await page.goto(`http://localhost:${port}/${pageName}/`);
      await page.waitForFunction(() => window.google !== undefined);
      await page.waitForTimeout(300);

      const contentVisible = await page.isVisible("#content");
      assert.equal(contentVisible, true, "アプリ自前のセッション復元(localStorage)自体は機能しているはず");

      const disableCalled = await page.evaluate(() => window.__disableAutoSelectCalled || 0);
      assert.ok(
        disableCalled > 0,
        "セッション復元済みなのに、GoogleのOne Tap自動プロンプトを止める指示(disableAutoSelect等)が一度も送られていない"
      );
    } finally {
      await browser.close();
      server.close();
    }
  });
}
