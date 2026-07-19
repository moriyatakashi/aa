// bd/decoder.js — FC版ドラゴンクエスト1「ふっかつのじゅもん」解析ロジック(DOM非依存)。
// 元ネタ: https://colab.research.google.com/drive/1T84BOO1lyjp7T_CHOVucBQQjPniH7sBH (ミューズ, 2022, MIT License)
// Python(mojimoji + 辞書逆引き)で書かれた元Notebookをそのまま素直にJSへ移植したもの。

export const PASSWORD_LENGTH = 20;

// じゅもんに使われる文字と番号(0-63)
export const PASS_CHARS = [
  "あ", "い", "う", "え", "お", "か", "き", "く", "け", "こ",
  "さ", "し", "す", "せ", "そ", "た", "ち", "つ", "て", "と",
  "な", "に", "ぬ", "ね", "の", "は", "ひ", "ふ", "へ", "ほ",
  "ま", "み", "む", "め", "も", "や", "ゆ", "よ", "ら", "り",
  "る", "れ", "ろ", "わ", "が", "ぎ", "ぐ", "げ", "ご", "ざ",
  "じ", "ず", "ぜ", "ぞ", "だ", "ぢ", "づ", "で", "ど", "ば",
  "び", "ぶ", "べ", "ぼ",
];

// なまえに使われる文字と番号(0-63)
export const NAME_CHARS = [
  "０", "１", "２", "３", "４", "５", "６", "７", "８", "９",
  "あ", "い", "う", "え", "お", "か", "き", "く", "け", "こ",
  "さ", "し", "す", "せ", "そ", "た", "ち", "つ", "て", "と",
  "な", "に", "ぬ", "ね", "の", "は", "ひ", "ふ", "へ", "ほ",
  "ま", "み", "む", "め", "も", "や", "ゆ", "よ",
  "ら", "り", "る", "れ", "ろ", "わ", "を", "ん",
  "っ", "ゃ", "ゅ", "ょ", "゛", "゜", "ー", "　",
];

export const WEAPON_NAMES = ["なし", "たけざお", "こんぼう", "どうのつるぎ", "てつのおの", "はがねのつるぎ", "ほのおのつるぎ", "ロトのつるぎ"];
export const ARMOR_NAMES = ["なし", "ぬののふく", "かわのふく", "くさりかたびら", "てつのよろい", "はがねのよろい", "まほうのよろい", "ロトのよろい"];
export const SHIELD_NAMES = ["なし", "かわのたて", "てつのたて", "みかがみのたて"];
export const ITEM_NAMES = [
  "なし", "たいまつ", "せいすい", "キメラのつばさ", "りゅうのうろこ", "ようせいのふえ",
  "せんしのゆびわ", "ロトのしるし", "おうじょのあい", "のろいのベルト", "ぎんのたてごと",
  "しのくびかざり", "たいようのいし", "あまぐものつえ", "にじのしずく",
];

const PASS_CHAR_TO_NUM = new Map(PASS_CHARS.map((ch, i) => [ch, i]));

// 半角カナ→全角カナ(濁点/半濁点の合成含む)
const HALF_KANA_MAP = {
  "ｶﾞ": "ガ", "ｷﾞ": "ギ", "ｸﾞ": "グ", "ｹﾞ": "ゲ", "ｺﾞ": "ゴ",
  "ｻﾞ": "ザ", "ｼﾞ": "ジ", "ｽﾞ": "ズ", "ｾﾞ": "ゼ", "ｿﾞ": "ゾ",
  "ﾀﾞ": "ダ", "ﾁﾞ": "ヂ", "ﾂﾞ": "ヅ", "ﾃﾞ": "デ", "ﾄﾞ": "ド",
  "ﾊﾞ": "バ", "ﾋﾞ": "ビ", "ﾌﾞ": "ブ", "ﾍﾞ": "ベ", "ﾎﾞ": "ボ",
  "ﾊﾟ": "パ", "ﾋﾟ": "ピ", "ﾌﾟ": "プ", "ﾍﾟ": "ペ", "ﾎﾟ": "ポ",
  "ｳﾞ": "ヴ",
  "ｱ": "ア", "ｲ": "イ", "ｳ": "ウ", "ｴ": "エ", "ｵ": "オ",
  "ｶ": "カ", "ｷ": "キ", "ｸ": "ク", "ｹ": "ケ", "ｺ": "コ",
  "ｻ": "サ", "ｼ": "シ", "ｽ": "ス", "ｾ": "セ", "ｿ": "ソ",
  "ﾀ": "タ", "ﾁ": "チ", "ﾂ": "ツ", "ﾃ": "テ", "ﾄ": "ト",
  "ﾅ": "ナ", "ﾆ": "ニ", "ﾇ": "ヌ", "ﾈ": "ネ", "ﾉ": "ノ",
  "ﾊ": "ハ", "ﾋ": "ヒ", "ﾌ": "フ", "ﾍ": "ヘ", "ﾎ": "ホ",
  "ﾏ": "マ", "ﾐ": "ミ", "ﾑ": "ム", "ﾒ": "メ", "ﾓ": "モ",
  "ﾔ": "ヤ", "ﾕ": "ユ", "ﾖ": "ヨ",
  "ﾗ": "ラ", "ﾘ": "リ", "ﾙ": "ル", "ﾚ": "レ", "ﾛ": "ロ",
  "ﾜ": "ワ", "ｦ": "ヲ", "ﾝ": "ン",
  "ｧ": "ァ", "ｨ": "ィ", "ｩ": "ゥ", "ｪ": "ェ", "ｫ": "ォ",
  "ｬ": "ャ", "ｭ": "ュ", "ｮ": "ョ", "ｯ": "ッ", "ｰ": "ー",
  "｡": "。", "｢": "「", "｣": "」", "､": "、", "･": "・", "ﾞ": "゛", "ﾟ": "゜",
};

// mojimoji.han_to_zen 相当: 半角カナ・半角英数字・半角記号を全角に変換する
export function hanToZen(str) {
  let s = str.replace(/[ｦ-ﾟ]ﾞ|[ｶ-ﾎ]ﾟ|[ｦ-ﾟ]/g, (m) => HALF_KANA_MAP[m] ?? m);
  s = s.replace(/[ -~]/g, (ch) =>
    ch === " " ? "　" : String.fromCharCode(ch.charCodeAt(0) + 0xfee0)
  );
  return s;
}

// 表記ゆれを正す(全角スペース除去・小さい文字を大きく・「を」→「お」)
const REPLACE_MAP = {
  "　": "", "ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お",
  "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "っ": "つ", "を": "お",
};

export function normalizePassword(raw) {
  const zen = hanToZen(raw);
  return Array.from(zen)
    .map((ch) => REPLACE_MAP[ch] ?? ch)
    .join("");
}

function toBits6(n) {
  return n.toString(2).padStart(6, "0");
}

// CRCを計算する(16bit多項式演算、byte[1]〜byte[14]の14バイト分)
function calculateCRC(byte) {
  let crc = 0;
  for (let i = 0; i < 14; i++) {
    let octet = parseInt(byte[i + 1], 2);
    for (let j = 0; j < 8; j++) {
      const carryBit = (((crc >> 8) ^ octet) & 0x80) !== 0;
      crc = (crc << 1) & 0xffff;
      octet = (octet << 1) & 0xff;
      if (carryBit) crc ^= 0x1021;
    }
  }
  return (crc & 0xff).toString(2).padStart(8, "0");
}

/**
 * ふっかつのじゅもん(文字列)を解析してステータス情報を返す。
 * 失敗時は { ok: false, error } を、成功時は { ok: true, info, steps } を返す。
 */
export function decodePassword(rawPassword) {
  const password = normalizePassword(rawPassword ?? "");
  if (password.length !== PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `じゅもんが現在${password.length}文字ですが、${PASSWORD_LENGTH}文字である必要があります`,
    };
  }

  const nums = [];
  for (const ch of password) {
    const n = PASS_CHAR_TO_NUM.get(ch);
    if (n === undefined) {
      return { ok: false, error: `じゅもんに使えない文字が含まれています: 「${ch}」` };
    }
    nums.push(n);
  }

  const passwordBinary = nums.map(toBits6);

  // 4と一つ前の文字を引く
  const codes = new Array(PASSWORD_LENGTH);
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    const prevCode = i !== 0 ? parseInt(passwordBinary[i - 1], 2) : 0;
    let diff = parseInt(passwordBinary[i], 2) - prevCode - 4;
    if (diff < -64) diff += 128;
    else if (diff < 0) diff += 64;
    codes[i] = toBits6(diff);
  }

  // 4文字(6bit×4)ずつ24bitにまとめ、8bitずつ後ろから並べ直す
  const byte = [];
  for (let i = 0; i < PASSWORD_LENGTH; i += 4) {
    const bit24 = codes[i + 3] + codes[i + 2] + codes[i + 1] + codes[i];
    byte.push(bit24.slice(16, 24));
    byte.push(bit24.slice(8, 16));
    byte.push(bit24.slice(0, 8));
  }

  const crc = calculateCRC(byte);

  const name = [
    parseInt(byte[5].slice(0, 6), 2),
    parseInt(byte[13].slice(1, 7), 2),
    parseInt(byte[2].slice(2), 2),
    parseInt(byte[7].slice(2), 2),
  ];

  const items = [
    parseInt(byte[14].slice(4), 2),
    parseInt(byte[14].slice(0, 4), 2),
    parseInt(byte[3].slice(4), 2),
    parseInt(byte[3].slice(0, 4), 2),
    parseInt(byte[11].slice(4), 2),
    parseInt(byte[11].slice(0, 4), 2),
    parseInt(byte[6].slice(4), 2),
    parseInt(byte[6].slice(0, 4), 2),
  ];

  const weaponIdx = parseInt(byte[8].slice(0, 3), 2);
  const armorIdx = parseInt(byte[8].slice(3, 6), 2);
  const shieldIdx = parseInt(byte[8].slice(6), 2);
  const key = parseInt(byte[10].slice(0, 4), 2);
  const herb = parseInt(byte[10].slice(4), 2);
  const exp = parseInt(byte[12] + byte[1], 2);
  const gold = parseInt(byte[9] + byte[4], 2);
  const scale = parseInt(byte[13][0], 2);
  const ring = parseInt(byte[13][7], 2);
  // 元Notebook通り、dragon/golemはどちらもbyte[7][1]を参照する(移植元の仕様のまま)
  const dragon = parseInt(byte[7][1], 2);
  const golem = parseInt(byte[7][1], 2);
  const necklace = parseInt(byte[5][6], 2);
  const checkCodeSame = crc === byte[0];
  const pattern = parseInt(byte[7][0] + byte[5][7] + byte[2][0], 2);

  const isValid = checkCodeSame && key <= 6 && herb <= 6 && !items.some((it) => it >= 15);

  const info = {
    nameNums: name,
    name: name.map((n) => NAME_CHARS[n] ?? String(n)).join(""),
    weaponIdx,
    weapon: WEAPON_NAMES[weaponIdx] ?? String(weaponIdx),
    armorIdx,
    armor: ARMOR_NAMES[armorIdx] ?? String(armorIdx),
    shieldIdx,
    shield: SHIELD_NAMES[shieldIdx] ?? String(shieldIdx),
    itemNums: items,
    items: items.map((it) => ITEM_NAMES[it] ?? String(it)),
    key,
    herb,
    exp,
    gold,
    scale: scale === 1,
    ring: ring === 1,
    dragon: dragon === 1,
    golem: golem === 1,
    necklace: necklace === 1,
    checkCodeSame,
    pattern,
    isValid,
  };

  return {
    ok: true,
    info,
    steps: { password, nums, passwordBinary, codes, byte, crc },
  };
}
