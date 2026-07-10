// n1_login.spec.js
// 「2系列」テスト: window.handleCredentialResponseを直接叩き、実際のGoogleログイン画面は経由しない。
// あえて .test.js にはしていない(node --testが拾ってCIで壊れるのを避けるため)。
// .spec.js はPlaywrightのデフォルトtestMatchに一致し、node --testの既定パターンには一致しない。
// 実行方法: npx playwright test boltz/n1_login.spec.js
import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = "file://" + path.join(__dirname, "index.html").replace(/\\/g, "/");

function makeFakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("handleCredentialResponseを直接叩くとログイン中の表示になる", async ({ page }) => {
  await page.goto(pageUrl);
  const fakeCredential = makeFakeJwt({ name: "テスト太郎" });
  await page.evaluate((cred) => {
    window.handleCredentialResponse({ credential: cred });
  }, fakeCredential);
  await expect(page.locator("#status")).toHaveText("ログイン中: テスト太郎");
});

test("nameが無いcredentialだと名前未取得の表示になる", async ({ page }) => {
  await page.goto(pageUrl);
  const fakeCredential = makeFakeJwt({});
  await page.evaluate((cred) => {
    window.handleCredentialResponse({ credential: cred });
  }, fakeCredential);
  await expect(page.locator("#status")).toHaveText("ログイン中: (名前未取得)");
});

test("不正なcredentialだとログイン失敗の表示になる", async ({ page }) => {
  await page.goto(pageUrl);
  await page.evaluate(() => {
    window.handleCredentialResponse({ credential: "not-a-valid-jwt" });
  });
  await expect(page.locator("#status")).toHaveText("ログインに失敗しました");
});
