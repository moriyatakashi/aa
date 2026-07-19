import test from "node:test";
import assert from "node:assert/strict";
import { decodePassword, hanToZen, normalizePassword } from "../src/bd/decoder.js";

// 元Notebookで実際に検証済みの入出力(ドラクエ1「ふっかつのじゅもん」)
const SAMPLE_PASSWORD = "ふるいけや　かわずとびこむ　みずのおと　ばしや";

test("sample password decodes to the notebook's known status", () => {
  const r = decodePassword(SAMPLE_PASSWORD);
  assert.equal(r.ok, true);
  const { info } = r;
  assert.equal(info.name, "４ひえた");
  assert.equal(info.weapon, "こんぼう");
  assert.equal(info.armor, "くさりかたびら");
  assert.equal(info.shield, "なし");
  assert.deepEqual(info.items, [
    "なし", "ようせいのふえ", "ロトのしるし", "のろいのベルト",
    "せいすい", "ぎんのたてごと", "たいようのいし", "ようせいのふえ",
  ]);
  assert.equal(info.key, 1);
  assert.equal(info.herb, 4);
  assert.equal(info.exp, 2898);
  assert.equal(info.gold, 15143);
  assert.equal(info.scale, true);
  assert.equal(info.ring, true);
  assert.equal(info.dragon, false);
  assert.equal(info.golem, false);
  assert.equal(info.necklace, true);
  assert.equal(info.pattern, 4);
  assert.equal(info.isValid, true);
});

test("wrong length password is rejected with a length error", () => {
  const r = decodePassword("ふるいけやかわず");
  assert.equal(r.ok, false);
  assert.match(r.error, /8文字/);
});

test("corrupting a single character breaks the CRC check", () => {
  const chars = Array.from(SAMPLE_PASSWORD.replace(/　/g, ""));
  chars[0] = chars[0] === "あ" ? "い" : "あ";
  const r = decodePassword(chars.join(""));
  assert.equal(r.ok, true);
  assert.equal(r.info.isValid, false);
});

test("normalizePassword removes spaces and expands small kana", () => {
  assert.equal(normalizePassword("ふぁ　を"), "ふあお");
});

test("hanToZen converts half-width katakana to full-width", () => {
  assert.equal(hanToZen("ｶﾞﾝﾊﾞﾚ"), "ガンバレ");
});
