// n1_login.spec.js
// 「2系列」テスト: window.handleCredentialResponseを直接叩き、実際のGoogleログイン画面は経由しない。
// あえて .test.js にはしていない(node --testが拾ってCIで壊れるのを避けるため)。
// .spec.js はPlaywrightのデフォルトtestMatchに一致し、node --testの既定パターンには一致しない。
// 実行方法: npx playwright test boltz/n1_login.spec.js
import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = (name) => "file://" + path.join(__dirname, name).replace(/\\/g, "/");

function makeFakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("handleCredentialResponseを直接叩くとログイン中の表示になる", async ({ page }) => {
  await page.goto(pageUrl("index.html"));
  const fakeCredential = makeFakeJwt({ name: "テスト太郎" });
  await page.evaluate((cred) => {
    window.handleCredentialResponse({ credential: cred });
  }, fakeCredential);
  await expect(page.locator("#status")).toHaveText("ログイン中: テスト太郎");
});

test("nameが無いcredentialだと名前未取得の表示になる", async ({ page }) => {
  await page.goto(pageUrl("index.html"));
  const fakeCredential = makeFakeJwt({});
  await page.evaluate((cred) => {
    window.handleCredentialResponse({ credential: cred });
  }, fakeCredential);
  await expect(page.locator("#status")).toHaveText("ログイン中: (名前未取得)");
});

test("不正なcredentialだとログイン失敗の表示になる", async ({ page }) => {
  await page.goto(pageUrl("index.html"));
  await page.evaluate(() => {
    window.handleCredentialResponse({ credential: "not-a-valid-jwt" });
  });
  await expect(page.locator("#status")).toHaveText("ログインに失敗しました");
});

// ここから: issue #8(自動復元時のデータ読み込みスタック)の再現・比較テスト。
// localStorageに有効な30分キャッシュを事前に仕込んだ状態でページを開き、
// 自動復元パスを通してから#loadStatusの最終表示を確認する。

function seedCacheInitScript(fakeCredential) {
  return (cred) => {
    const cache = { credential: cred, expiresAt: Date.now() + 30 * 60 * 1000 };
    localStorage.setItem("boltz_login_cache", JSON.stringify(cache));
  };
}

test("[バグ再現] baseline版はlocalStorage自動復元でデータ読み込みがスタックする", async ({ page }) => {
  const fakeCredential = makeFakeJwt({ name: "テスト太郎" });
  await page.addInitScript(seedCacheInitScript(fakeCredential), fakeCredential);
  await page.goto(pageUrl("index.html"));
  await page.waitForTimeout(300); // ダミーのデータ読み込み(50ms)より十分長く待つ
  await expect(page.locator("#status")).toHaveText("ログイン中: テスト太郎");
  // 既知バグ: イベントを取りこぼすため、読み込みが完了せず「(未ログイン)」のまま止まる
  await expect(page.locator("#loadStatus")).toHaveText("(未ログイン)");
});

test("[案A] auth.js/app.jsをtype=moduleに揃え、app.jsを先読みすると自動復元でも読み込みが完了する", async ({ page }) => {
  const fakeCredential = makeFakeJwt({ name: "テスト太郎" });
  await page.addInitScript(seedCacheInitScript(fakeCredential), fakeCredential);
  await page.goto(pageUrl("index-optionA.html"));
  await page.waitForTimeout(300);
  await expect(page.locator("#status")).toHaveText("ログイン中: テスト太郎");
  await expect(page.locator("#loadStatus")).toHaveText("データ読み込み完了");
});

test("[案B] app.js側でwindow.__loginStateを直接チェックすると自動復元でも読み込みが完了する", async ({ page }) => {
  const fakeCredential = makeFakeJwt({ name: "テスト太郎" });
  await page.addInitScript(seedCacheInitScript(fakeCredential), fakeCredential);
  await page.goto(pageUrl("index-optionB.html"));
  await page.waitForTimeout(300);
  await expect(page.locator("#status")).toHaveText("ログイン中: テスト太郎");
  await expect(page.locator("#loadStatus")).toHaveText("データ読み込み完了");
});
