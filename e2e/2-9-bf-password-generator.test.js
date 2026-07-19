import test from "node:test";
import assert from "node:assert/strict";
import {
  generatePassword, ITEM_NAMES, TOWN_NAMES,
  MOON_STATE_NAMES, GATE_STATE_NAMES, PLUMAGE_STATE_NAMES, SHIP_STATE_NAMES, PRINCE_STATE_NAMES,
} from "../src/bf/generator.js";

// 元Notebook(Colab)のコードセルをPythonでそのまま動かして得た出力と突き合わせ済みの回帰テスト。
// (bd用のサンプルと違い、Notebook自体には検証済みサンプル入出力の記載がないため、
//  元コードの移植版をPython側で実行して基準値を作った上でJS版と比較している)

const idx = (list, name) => list.indexOf(name);
const itemsFrom = (names, equips) => names.map((n, i) => ({ item: idx(ITEM_NAMES, n), equip: equips[i] }));

test("3人パーティ・全員装備ありの入力から、元Notebook準拠のじゅもんが生成される", () => {
  const r = generatePassword({
    ro: {
      name: "ゆうしゃ",
      exp: 12345,
      items: itemsFrom(
        ["どうのつるぎ", "かわのよろい", "なし", "なし", "なし", "なし", "なし", "なし"],
        [true, true, false, false, false, false, false, false]
      ),
    },
    sa: {
      flag: true,
      exp: 6789,
      items: itemsFrom(["こんぼう", "なし", "なし", "なし", "なし", "なし", "なし", "なし"], [true, false, false, false, false, false, false, false]),
    },
    mu: {
      flag: true,
      exp: 3456,
      items: itemsFrom(["やくそう", "なし", "なし", "なし", "なし", "なし", "なし", "なし"], [false, false, false, false, false, false, false, false]),
    },
    gold: 54321,
    town: idx(TOWN_NAMES, "ラダトーム"),
    flagMoon: idx(MOON_STATE_NAMES, "使った"),
    flagGate: idx(GATE_STATE_NAMES, "開けた"),
    flagPlumage: idx(PLUMAGE_STATE_NAMES, "織ってもらった"),
    statShip: idx(SHIP_STATE_NAMES, "船をもらった"),
    statPrince: idx(PRINCE_STATE_NAMES, "見つけた"),
    crestLife: true, crestWater: false, crestMoon: true, crestStar: false, crestSun: true,
    pattern: 3,
  });
  assert.equal(r.ok, true);
  assert.equal(r.steps.jumon, "ぶまじくずねほつつかひさねふあえりぷぬすたごぷなふすせちせそ");
  assert.equal(r.jumon, "ぶまじ  くずね  ほつつか\nひさね  ふあえ  りぷぬす\nたごぷ  なふす  せちせそ\n");
});

test("初期状態(全て未入力)からも生成でき、ローレシア王子だけの最小構成になる", () => {
  const r = generatePassword({
    ro: { name: "００００", exp: 0, items: itemsFrom(Array(8).fill("なし"), Array(8).fill(false)) },
    sa: { flag: false, exp: 0, items: itemsFrom(Array(8).fill("なし"), Array(8).fill(false)) },
    mu: { flag: false, exp: 0, items: itemsFrom(Array(8).fill("なし"), Array(8).fill(false)) },
    gold: 0,
    town: idx(TOWN_NAMES, "ローレシア"),
    flagMoon: idx(MOON_STATE_NAMES, "使っていない"),
    flagGate: idx(GATE_STATE_NAMES, "開けていない"),
    flagPlumage: idx(PLUMAGE_STATE_NAMES, "織ってもらっていない"),
    statShip: idx(SHIP_STATE_NAMES, "何もしていない"),
    statPrince: idx(PRINCE_STATE_NAMES, "見つけていない"),
    crestLife: false, crestWater: false, crestMoon: false, crestStar: false, crestSun: false,
    pattern: 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.steps.jumon, "ぼぴぺあうおきけさすそおきけさすそち");
  assert.equal(r.steps.byte.length, 13);
});

test("3人×アイテム8個ずつのフル構成で、313/314ビット圧縮(40→39バイト)分岐を通る", () => {
  const allItems = ITEM_NAMES.filter((n) => n !== "なし").slice(0, 8);
  const r = generatePassword({
    ro: { name: "さくらこ", exp: 999999, items: itemsFrom(allItems, [true, false, true, false, true, false, true, false]) },
    sa: { flag: true, exp: 999999, items: itemsFrom(allItems, [false, true, false, true, false, true, false, true]) },
    mu: { flag: true, exp: 999999, items: itemsFrom(allItems, [true, true, false, false, true, true, false, false]) },
    gold: 65535,
    town: idx(TOWN_NAMES, "ムーンペタ"),
    flagMoon: idx(MOON_STATE_NAMES, "使った"),
    flagGate: idx(GATE_STATE_NAMES, "開けた"),
    flagPlumage: idx(PLUMAGE_STATE_NAMES, "織ってもらった"),
    statShip: idx(SHIP_STATE_NAMES, "船をもらった"),
    statPrince: idx(PRINCE_STATE_NAMES, "見つけた"),
    crestLife: true, crestWater: true, crestMoon: true, crestStar: true, crestSun: true,
    pattern: 7,
  });
  assert.equal(r.ok, true);
  assert.equal(r.steps.byte.length, 39, "40バイトになるはずが圧縮されず39バイトになっていない");
  assert.equal(r.steps.jumon, "つぺききすへふううぼびうとびびごつじふぜくてはぷむわごちちつのほめおきみちげいてばばげちいもぱそひめよけ");
});

test("なまえが4文字でないとエラーになる", () => {
  const r = generatePassword({
    ro: { name: "ゆう", exp: 0, items: itemsFrom(Array(8).fill("なし"), Array(8).fill(false)) },
    sa: { flag: false, items: [] },
    mu: { flag: false, items: [] },
    gold: 0, town: 0, flagMoon: 0, flagGate: 0, flagPlumage: 0, statShip: 0, statPrince: 0,
    crestLife: false, crestWater: false, crestMoon: false, crestStar: false, crestSun: false,
    pattern: 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /4文字/);
});

test("経験値が範囲外だとエラーになる", () => {
  const r = generatePassword({
    ro: { name: "００００", exp: 1000001, items: itemsFrom(Array(8).fill("なし"), Array(8).fill(false)) },
    sa: { flag: false, items: [] },
    mu: { flag: false, items: [] },
    gold: 0, town: 0, flagMoon: 0, flagGate: 0, flagPlumage: 0, statShip: 0, statPrince: 0,
    crestLife: false, crestWater: false, crestMoon: false, crestStar: false, crestSun: false,
    pattern: 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /経験値/);
});

test("「なし」を挟んだ後ろのどうぐは、元Notebook通り切り捨てられる", () => {
  const withGap = generatePassword({
    ro: {
      name: "００００", exp: 0,
      items: itemsFrom(
        ["こんぼう", "なし", "やくそう", "なし", "なし", "なし", "なし", "なし"],
        [true, false, false, false, false, false, false, false]
      ),
    },
    sa: { flag: false, items: [] },
    mu: { flag: false, items: [] },
    gold: 0, town: 0, flagMoon: 0, flagGate: 0, flagPlumage: 0, statShip: 0, statPrince: 0,
    crestLife: false, crestWater: false, crestMoon: false, crestStar: false, crestSun: false,
    pattern: 0,
  });
  const withoutGap = generatePassword({
    ro: {
      name: "００００", exp: 0,
      items: itemsFrom(["こんぼう", "なし", "なし", "なし", "なし", "なし", "なし", "なし"], [true, false, false, false, false, false, false, false]),
    },
    sa: { flag: false, items: [] },
    mu: { flag: false, items: [] },
    gold: 0, town: 0, flagMoon: 0, flagGate: 0, flagPlumage: 0, statShip: 0, statPrince: 0,
    crestLife: false, crestWater: false, crestMoon: false, crestStar: false, crestSun: false,
    pattern: 0,
  });
  assert.equal(withGap.ok, true);
  assert.equal(withoutGap.ok, true);
  assert.equal(withGap.steps.jumon, withoutGap.steps.jumon, "「なし」の後ろのやくそうは無視され、こんぼうだけの構成と同じ結果になるはず");
});
