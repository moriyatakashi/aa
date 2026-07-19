// 永続認証移行(ba-XX, 2026-07-19)。ログイン成功時に生のGoogle IDトークンを
// サーバー発行の無期限セッショントークンに交換し、localStorageにkind:"session"で
// 保存すること。/api/sessionが使えない(未対応・通信不可)場合は、従来どおり
// 生のGoogleトークンをkind:"google"で保存するフォールバックに倒れること。
// ログアウトはDELETE /api/sessionを呼んでからlocalStorageを消し、ログインゲートに戻すこと。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript" };

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

async function triggerLogin(page) {
  await page.evaluate((cred) => window.handleCredentialResponse({ credential: cred }), FAKE_GOOGLE_CREDENTIAL);
  await page.waitForSelector("#content", { state: "visible" });
}

test("ba: ログイン成功時にセッショントークンへ交換し、無期限として保存する", async () => {
  const server = await serveStatic();
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("https://accounts.google.com/gsi/client", (route) =>
      route.fulfill({ contentType: "text/javascript", body: "" })
    );
    let sessionCreateCalls = 0;
    let sessionDeleteCalls = 0;
    await page.route("https://ab-board-api.azurewebsites.net/api/session", (route) => {
      const method = route.request().method();
      if (method === "POST") {
        sessionCreateCalls++;
        route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ sessionToken: "session:testid.testsig" }),
        });
      } else if (method === "DELETE") {
        sessionDeleteCalls++;
        route.fulfill({ status: 204, body: "" });
      } else {
        route.fulfill({ status: 404, body: "" });
      }
    });

    await page.goto(`http://localhost:${port}/src/ba/`);
    await triggerLogin(page);

    assert.equal(sessionCreateCalls, 1, "ログイン成功時にPOST /api/sessionで交換されるはず");

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("aa_credential")));
    assert.equal(stored.kind, "session");
    assert.equal(stored.credential, "session:testid.testsig");

    // ログアウトリンクが表示され、押すとDELETEが呼ばれてlocalStorageが消え、ログインゲートに戻る
    await page.waitForSelector("#aa-logout-link", { state: "visible" });
    await page.click("#aa-logout-link");
    await page.waitForSelector("#login-gate", { state: "visible" });

    assert.equal(sessionDeleteCalls, 1, "ログアウト時にDELETE /api/sessionが呼ばれるはず");
    const afterLogout = await page.evaluate(() => localStorage.getItem("aa_credential"));
    assert.equal(afterLogout, null, "ログアウト後はlocalStorageの認証情報が消えているはず");
  } finally {
    await browser.close();
    server.close();
  }
});

test("ba: /api/sessionが使えない場合は生のGoogleトークンにフォールバックする", async () => {
  const server = await serveStatic();
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("https://accounts.google.com/gsi/client", (route) =>
      route.fulfill({ contentType: "text/javascript", body: "" })
    );
    // SESSION_SECRET未設定のサーバーを模し、503を返す
    await page.route("https://ab-board-api.azurewebsites.net/api/session", (route) =>
      route.fulfill({ status: 503, body: "session feature not configured" })
    );

    await page.goto(`http://localhost:${port}/src/ba/`);
    await triggerLogin(page);

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("aa_credential")));
    assert.equal(stored.kind, "google", "交換に失敗したら従来どおり生のGoogleトークンで保存されるはず");
    assert.equal(stored.credential, FAKE_GOOGLE_CREDENTIAL);

    const contentVisible = await page.isVisible("#content");
    assert.equal(contentVisible, true, "セッション交換に失敗してもログイン自体は成立するはず");
  } finally {
    await browser.close();
    server.close();
  }
});
