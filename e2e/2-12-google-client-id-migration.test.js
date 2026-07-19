// ba-9残タスク①: GoogleクライアントIDのハードコード解消。
// data-client_idはcommon/config.jsのAA_GOOGLE_CLIENT_IDから、各ページのdiv直後の
// 小さな<script>でJS的に書き戻す方式にした(GSIの宣言的init方式・async defer・
// scriptタグの位置は一切変更しない)。
//
// GSIの<script async defer>は外部ネットワーク取得後に実行されるため、
// 「非同期scriptが実際にg_id_onloadを読みに来た時点で値が正しく入っているか」
// が本質的な検証ポイント。ここでは、GSIスタブ自身の実行時点でdata-client_id属性を
// 読み取って記録することで、この非同期タイミングを模擬する
// (m14ログイン事故の教訓: 宣言的初期化の順序に触れる変更は、事後のDOM確認だけでは
// 不十分で、実際に非同期scriptが読む瞬間の値を見る必要がある)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const EXPECTED_CLIENT_ID = "550466095352-50h92anfullp137l4gq4gdi7ogjk0auc.apps.googleusercontent.com";

// Stage 2はk2のみが対象(パイロット)、Stage 4で残り4ページを追加。
const PAGES = ["k2", "n1", "n2", "ba", "be"];

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

// 実際のGSIスクリプトの代わりに、自分自身の実行時点でdata-client_id属性を読み取り
// window.__observedClientIdへ記録するスタブ。
//
// 実機ではGSIは実際のネットワーク越しの取得後に実行されるため、同期scriptである
// data-client_id書き戻しは必ず先に終わっている。だがこのテストではPlaywrightの
// page.routeでレスポンスを即時返すため、setTimeout(0)程度の遅延だと、システム負荷が
// 高い瞬間にCDP経由のroute解決がたまたま同期script実行より先に走ってしまうことがある
// (2026-07-20、n1/n2でこの原因によるflakyな失敗を実際に観測)。windowのloadイベントは
// DOMContentLoaded(deferred/module scriptを含む全scriptの評価完了後)よりさらに後に
// 発火するため、同期scriptとの競合が原理的に起こり得ない、より確実な待ち方にする。
const GSI_TIMING_STUB = `
  window.addEventListener('load', () => {
    const el = document.getElementById('g_id_onload');
    window.__observedClientId = el ? el.getAttribute('data-client_id') : null;
    window.google = { accounts: { id: {
      initialize: () => {}, prompt: () => {}, renderButton: () => {}, disableAutoSelect: () => {}
    } } };
  });
`;

for (const pageName of PAGES) {
  test(`${pageName}: GSIスタブが実行される時点でdata-client_idがAA_GOOGLE_CLIENT_IDと一致する`, async () => {
    const server = await serveStatic();
    const port = server.address().port;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));

      await page.route("https://accounts.google.com/gsi/client", (route) =>
        route.fulfill({ contentType: "text/javascript", body: GSI_TIMING_STUB })
      );

      await page.goto(`http://localhost:${port}/src/${pageName}/`);
      await page.waitForFunction(() => window.__observedClientId !== undefined, null, { timeout: 5000 });

      const observed = await page.evaluate(() => window.__observedClientId);
      assert.equal(observed, EXPECTED_CLIENT_ID, "GSI(スタブ)実行時点でdata-client_idが正しく設定されていない");
      assert.deepEqual(pageErrors, [], "ページ読み込み中にJS例外が発生している");
    } finally {
      await browser.close();
      server.close();
    }
  });
}
