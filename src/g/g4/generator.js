// bf/generator.js — FC版ドラゴンクエスト2「ふっかつのじゅもん」生成ロジック(DOM非依存)。
// 元ネタ: https://colab.research.google.com/drive/14cuBLcPAXwyZLy8EgpcyiwKAy5qLCnIf (ミューズ, 2023, MIT License)
// Python(Colab #@paramフォーム)で書かれた元Notebookをそのまま素直にJSへ移植したもの。
// bd(ドラクエ1の解析器)とは対象タイトルが異なるため、文字テーブル等は共有しない。

// なまえに使われる文字と番号(0-62、DQ1と異なり長音「ー」を含まない)
export const NAME_CHARS = [
  "０", "１", "２", "３", "４", "５", "６", "７", "８", "９",
  "あ", "い", "う", "え", "お", "か", "き", "く", "け", "こ",
  "さ", "し", "す", "せ", "そ", "た", "ち", "つ", "て", "と",
  "な", "に", "ぬ", "ね", "の", "は", "ひ", "ふ", "へ", "ほ",
  "ま", "み", "む", "め", "も", "や", "ゆ", "よ", "ら", "り",
  "る", "れ", "ろ", "わ", "を", "ん", "っ", "ゃ", "ゅ", "ょ",
  "゛", "゜", "　",
];

// じゅもんに使われる文字と番号(0-63)
export const PASS_CHARS = [
  "あ", "い", "う", "え", "お", "か", "き", "く", "け", "こ",
  "さ", "し", "す", "せ", "そ", "た", "ち", "つ", "て", "と",
  "な", "に", "ぬ", "ね", "の", "は", "ひ", "ふ", "へ", "ほ",
  "ま", "み", "む", "め", "も", "や", "ゆ", "よ", "ら", "り",
  "る", "れ", "ろ", "わ", "が", "ぎ", "ぐ", "げ", "ご", "ざ",
  "じ", "ず", "ぜ", "ぞ", "ば", "び", "ぶ", "べ", "ぼ", "ぱ",
  "ぴ", "ぷ", "ぺ", "ぽ",
];

export const ITEM_NAMES = [
  "なし", "ひのきのぼう", "せいなるナイフ", "まどうしのつえ", "いかずちのつえ", "こんぼう", "どうのつるぎ", "くさりがま",
  "てつのやり", "はやぶさのけん", "はがねのつるぎ", "おおかなずち", "はかいのつるぎ", "ドラゴンキラー", "ひかりのつるぎ",
  "ロトのつるぎ", "いなずまのけん", "ぬののふく", "みかわしのふく", "みずのはごろも", "ミンクのコート", "かわのよろい",
  "くさりかたびら", "あくまのよろい", "まほうのよろい", "はがねのよろい", "ガイアのよろい", "ロトのよろい", "かわのたて",
  "ちからのたて", "はがねのたて", "しにがみのたて", "ロトのたて", "ふしぎなかぶと", "てつかぶと", "ロトのかぶと",
  "ロトのしるし", "ふねのざいほう", "つきのかけら", "ルビスのまもり", "じゃしんのぞう", "せかいじゅのは", "やまびこのふえ",
  "ラーのかがみ", "あまつゆのいと", "せいなるおりき", "かぜのマント", "あくまのしっぽ", "まよけのすず", "ふっかつのたま",
  "ゴールドカード", "ふくびきけん", "せいすい", "キメラのつばさ", "みみせん（使用不可）", "きんのかぎ", "ぎんのかぎ",
  "ろうやのかぎ", "すいもんのかぎ", "どくけしそう", "やくそう", "いのりのゆびわ", "しのオルゴール（使用不可）",
  "あぶないみずぎ（MSX専用）",
];

export const TOWN_NAMES = ["ローレシア", "サマルトリア", "ラダトーム", "デルコンダル", "ベラヌール", "ロンダルキア", "ムーンペタ", "（不正）"];
export const MOON_STATE_NAMES = ["使っていない", "使った"];
export const GATE_STATE_NAMES = ["開けていない", "開けた"];
export const PLUMAGE_STATE_NAMES = ["織ってもらっていない", "織ってもらった"];
export const SHIP_STATE_NAMES = ["何もしていない", "女の子を助けた", "船をもらった（通常プレイではありえない）", "船をもらった"];
export const PRINCE_STATE_NAMES = ["見つけていない", "探して、王様に会った", "探して、勇者の泉に行った", "見つけた"];

const NAME_CHAR_TO_NUM = new Map(NAME_CHARS.map((ch, i) => [ch, i]));

function bin(n, width) {
  return n.toString(2).padStart(width, "0");
}

function nameCharToBits(ch) {
  const n = NAME_CHAR_TO_NUM.get(ch);
  return n === undefined ? null : bin(n, 6);
}

// items(どうぐ番号の配列)のうち、最初に0(なし)が現れた地点より後ろは切り捨てる。
// 元Notebook同様、「なし」を間に挟んで後ろに道具を置くと、その道具は無視される。
function removeTrailingEmpty(items, equips) {
  const idx = items.indexOf(0);
  if (idx === -1) return [items, equips];
  return [items.slice(0, idx), equips.slice(0, idx)];
}

function itemsToBits(items, equips) {
  const [it, eq] = removeTrailingEmpty(items, equips);
  const bits = it.map((item, i) => (eq[i] ? "1" : "0") + bin(item, 6)).join("");
  return { bits, lenBits: bin(it.length, 4), count: it.length };
}

function splitBits8(bits) {
  const chunks = [];
  for (let i = 0; i < bits.length; i += 8) chunks.push(bits.slice(i, i + 8));
  const last = chunks.length - 1;
  if (chunks[last].length < 8) chunks[last] = chunks[last].padEnd(8, "0");
  return chunks;
}

// CRC-16(多項式0x1021)を計算する(初期値はバイト数×0x0101、元Notebookのcalculate_crcそのまま)
function calculateCrc(byteBits) {
  let crc = (byteBits.length * 0x0101) & 0xffff;
  for (let i = byteBits.length - 1; i >= 0; i--) {
    let octet = parseInt(byteBits[i], 2);
    for (let j = 0; j < 8; j++) {
      const carryBit = (((crc >> 8) ^ octet) & 0x80) !== 0;
      crc = (crc << 1) & 0xffff;
      octet = (octet << 1) & 0xff;
      if (carryBit) crc ^= 0x1021;
    }
  }
  return bin(crc & 0x07ff, 11);
}

// 10文字ごとに3-3-4で改行しつつ整形する。i===50の特殊分岐は元Notebookのshape_jumonをそのまま踏襲
// (6行目にあたる末尾の端数を、改行を挟まず5行目の末尾に連結する)。
function shapeJumon(str) {
  let result = "";
  for (let i = 0; i < str.length; i += 10) {
    const line = str.slice(i, i + 10);
    if (i === 50) {
      result = result.slice(0, -1) + "  " + line;
    } else {
      result += [line.slice(0, 3), line.slice(3, 6), line.slice(6)].join("  ") + "\n";
    }
  }
  return result;
}

const EXP_MAX = 1000000;
const GOLD_MAX = 65535;

function validateExp(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > EXP_MAX) {
    return `${label}の経験値は0〜${EXP_MAX.toLocaleString()}の整数で入力してください`;
  }
  return null;
}

/**
 * 入力値からドラクエ2の「ふっかつのじゅもん」を生成する。
 * items配列は各キャラ8要素で、{ item: どうぐ番号(0=なし), equip: 装備しているか } の形。
 * 失敗時は { ok: false, error } を、成功時は { ok: true, jumon, steps } を返す。
 */
export function generatePassword(input) {
  const roNameChars = Array.from(input.ro?.name ?? "");
  if (roNameChars.length !== 4) {
    return { ok: false, error: "ローレシア王子のなまえは、全角4文字(空白を含む)で入力してください" };
  }
  const roNameBits = roNameChars.map(nameCharToBits);
  const badNameChar = roNameChars.find((_, i) => roNameBits[i] === null);
  if (badNameChar !== undefined) {
    return { ok: false, error: `なまえに使えない文字が含まれています: 「${badNameChar}」` };
  }

  const roExpErr = validateExp(input.ro.exp, "ローレシア王子");
  if (roExpErr) return { ok: false, error: roExpErr };

  const saFlag = !!input.sa?.flag;
  const muFlag = !!input.mu?.flag;
  if (saFlag) {
    const saExpErr = validateExp(input.sa.exp, "サマルトリア王子");
    if (saExpErr) return { ok: false, error: saExpErr };
  }
  if (saFlag && muFlag) {
    const muExpErr = validateExp(input.mu.exp, "ムーンブルク王女");
    if (muExpErr) return { ok: false, error: muExpErr };
  }

  if (!Number.isInteger(input.gold) || input.gold < 0 || input.gold > GOLD_MAX) {
    return { ok: false, error: `ゴールドは0〜${GOLD_MAX.toLocaleString()}の整数で入力してください` };
  }
  if (!Number.isInteger(input.pattern) || input.pattern < 0 || input.pattern > 7) {
    return { ok: false, error: "パターンは0〜7で入力してください" };
  }

  const ro = itemsToBits(
    input.ro.items.map((it) => it.item),
    input.ro.items.map((it) => it.equip)
  );
  const sa = itemsToBits(
    (input.sa?.items ?? []).map((it) => it.item),
    (input.sa?.items ?? []).map((it) => it.equip)
  );
  const mu = itemsToBits(
    (input.mu?.items ?? []).map((it) => it.item),
    (input.mu?.items ?? []).map((it) => it.equip)
  );

  const BIroName = roNameBits;
  const BIgold = bin(input.gold, 16);
  const BItown = bin(input.town, 3);
  const BIpattern = bin(input.pattern, 4);
  const BIflagMoon = bin(input.flagMoon, 1);
  const BIflagGate = bin(input.flagGate, 1);
  const BIflagPlumage = bin(input.flagPlumage, 1);
  const BIstatShip = bin(input.statShip, 2);
  const BIstatPrince = bin(input.statPrince, 2);
  const BIcrestLife = bin(input.crestLife ? 1 : 0, 1);
  const BIcrestWater = bin(input.crestWater ? 1 : 0, 1);
  const BIcrestMoon = bin(input.crestMoon ? 1 : 0, 1);
  const BIcrestStar = bin(input.crestStar ? 1 : 0, 1);
  const BIcrestSun = bin(input.crestSun ? 1 : 0, 1);
  const BIroExp = bin(input.ro.exp, 20);
  const BIsaFlag = bin(saFlag ? 1 : 0, 1);
  const BIsaExp = bin(saFlag ? input.sa.exp : 0, 20);
  const BImuFlag = bin(muFlag ? 1 : 0, 1);
  const BImuExp = bin(saFlag && muFlag ? input.mu.exp : 0, 20);

  let bytesStr =
    "00000" + BItown +
    BIroName[2] + BIroName[1].slice(0, 2) +
    BIgold.slice(0, 8) +
    BIroName[1].slice(3, 5) + BIroName[0] +
    BIgold.slice(8) +
    BIroName[1][5] + BIroName[3] + BIroName[1][2] +
    BIpattern[3] + BIflagMoon + BIflagGate + BIflagPlumage + BIstatShip + BIstatPrince +
    BIpattern.slice(0, 3) + BIcrestLife + BIcrestWater + BIcrestMoon + BIcrestStar + BIcrestSun +
    "00000000" +
    BIroExp.slice(4) +
    BIroExp.slice(0, 4) + ro.lenBits +
    ro.bits +
    BIsaFlag;

  if (saFlag) {
    bytesStr += BIsaExp.slice(4) + BIsaExp.slice(0, 4) + sa.lenBits + sa.bits + BImuFlag;
    if (muFlag) {
      bytesStr += BImuExp.slice(4) + BImuExp.slice(0, 4) + mu.lenBits + mu.bits;
    }
  }

  const byte = splitBits8(bytesStr);

  // 313/314ビットの時は、byte[8]をbyte[39]で上書きしてbyte[39]を捨て、312ビット相当に圧縮する
  if (byte.length === 40) {
    byte[8] = byte[39];
    byte.length = 39;
  }

  const crc = calculateCrc(byte);
  byte[0] = crc.slice(6) + byte[0].slice(5);
  byte[8] = byte[8].slice(0, 2) + crc.slice(0, 6);

  const combined = byte.join("");
  const remainder = combined.length % 6;
  const padded = remainder > 0 ? combined + "0".repeat(6 - remainder) : combined;
  const passwordBits = [];
  for (let i = 0; i < padded.length; i += 6) passwordBits.push(padded.slice(i, i + 6));

  // 直前の文字とシフト量を加算しながら連鎖的に複雑化する(先頭の文字だけは変化しない)
  const nShift = (parseInt(passwordBits[0].slice(3, 5), 2) + 1) & 0x3f;
  for (let i = 1; i < passwordBits.length; i++) {
    passwordBits[i] = bin(
      (parseInt(passwordBits[i], 2) + parseInt(passwordBits[i - 1], 2) + nShift) & 0x3f,
      6
    );
  }

  const jumon = passwordBits.map((bits) => PASS_CHARS[parseInt(bits, 2)]).join("");
  const shaped = shapeJumon(jumon);

  return {
    ok: true,
    jumon: shaped,
    steps: { bytesStr, byte, crc, passwordBits, jumon },
  };
}
