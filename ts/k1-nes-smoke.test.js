// k1(NESエミュレータ)のスモークテスト。
// CPU(6502)/PPU(2C02)はk1/index.html内の1つの<script>にべた書きで、
// importできるモジュールに分離されていないため、命令セット単位のユニットテストは
// 大掛かりなリファクタなしには書けない(bc/のように別ファイル化されていればできる)。
// ここでは「同梱ROMを選んだら実際にフレームが描画され、エラー表示が出ない」ことだけを
// 確認する低コストな回帰検知として置く。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".nes": "application/octet-stream" };

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

test("k1: 同梱ROM(hello_nes4)を選ぶとエラーなくフレームが描画される", async () => {
  const server = await serveStatic();
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto(`http://localhost:${port}/src/k1/`);
    await page.click('.rom-btn[data-rom="rom/hello_nes4.nes"]');

    await page.waitForFunction(
      () => {
        const s = document.getElementById("status").textContent;
        return s && s.includes("hello_nes4");
      },
      null,
      { timeout: 5000 }
    );
    // 数フレーム分回るのを待つ(requestAnimationFrameループ)
    await page.waitForTimeout(500);

    const statusText = await page.textContent("#status");
    assert.ok(!statusText.includes("エラー"), `status表示にエラーが出ている: ${statusText}`);

    const errorBoxVisible = await page.isVisible("#errorBox.show");
    assert.equal(errorBoxVisible, false, "エラーボックスが表示されている");

    const hasNonBlankPixel = await page.evaluate(() => {
      const canvas = document.getElementById("screen");
      const ctx = canvas.getContext("2d");
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) return true;
      }
      return false;
    });
    assert.ok(hasNonBlankPixel, "canvasに何も描画されていない(真っ黒のまま)");

    assert.deepEqual(pageErrors, [], `未捕捉の例外が発生した: ${pageErrors.join(", ")}`);
  } finally {
    await browser.close();
    server.close();
  }
});
