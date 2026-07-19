// bf(ふっかつのじゅもん生成器)のUI配線スモークテスト。
// generator.jsのロジック自体は2-9で網羅済みなので、ここでは「実際の画面操作で
// フォーム入力→ボタン押下→表示」まで通ることだけを確認する(要素id不一致などの
// 配線バグはユニットテストでは検知できないため)。
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

test("bf: 初期値のまま生成ボタンを押すと、2-9で検証済みの最小構成のじゅもんが表示される", async () => {
  const server = await serveStatic();
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto(`http://localhost:${port}/src/bf/`);
    await page.click("#btn-generate");

    await page.waitForSelector("#result", { state: "visible" });
    const jumon = (await page.textContent("#jumon-output")).trim();
    assert.equal(jumon, "ぼぴぺ  あうお  きけさす\nそおき  けさす  そち");

    const errorText = await page.textContent("#error");
    assert.equal(errorText.trim(), "");
    assert.deepEqual(pageErrors, [], `未捕捉の例外が発生した: ${pageErrors.join(", ")}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test("bf: なまえを3文字にすると生成せずエラーメッセージが出る", async () => {
  const server = await serveStatic();
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}/src/bf/`);

    await page.fill("#ro-name", "あいう");
    await page.click("#btn-generate");

    const errorText = await page.textContent("#error");
    assert.match(errorText, /4文字/);
    const resultVisible = await page.isVisible("#result");
    assert.equal(resultVisible, false);
  } finally {
    await browser.close();
    server.close();
  }
});

test("bf: サマルトリア王子のチェックを外すとムーンブルク王女の欄も無効化される", async () => {
  const server = await serveStatic();
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}/src/bf/`);

    assert.equal(await page.isDisabled("#mu-flag"), true, "サマルトリア未加入時はムーンブルクのチェックボックス自体が無効のはず");

    await page.check("#sa-flag");
    assert.equal(await page.isDisabled("#mu-flag"), false);

    await page.check("#mu-flag");
    assert.equal(await page.isDisabled("#mu-exp"), false);

    await page.uncheck("#sa-flag");
    assert.equal(await page.isDisabled("#mu-flag"), true);
    assert.equal(await page.isDisabled("#mu-exp"), true, "サマルトリアが外れたらムーンブルクの入力欄も無効化されるはず");
  } finally {
    await browser.close();
    server.close();
  }
});
