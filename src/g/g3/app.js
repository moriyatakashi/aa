import { decodePassword } from "./decoder.js";

const SAMPLE_PASSWORD = "ふるいけや　かわずとびこむ　みずのおと　ばしや";

const el = {
  input: document.getElementById("password-input"),
  btnDecode: document.getElementById("btn-decode"),
  error: document.getElementById("error"),
  result: document.getElementById("result"),
  validity: document.getElementById("validity"),
  fields: document.getElementById("fields"),
  steps: document.getElementById("steps"),
  stepsBody: document.getElementById("steps-body"),
};

function fieldRow(label, value) {
  return `<div class="field-row"><span class="field-label">${label}</span><span class="field-value">${value}</span></div>`;
}

function renderResult(info) {
  el.validity.textContent = info.isValid ? "有効な呪文です" : "不正な呪文です(チェックコード不一致など)";
  el.validity.className = info.isValid ? "validity validity--ok" : "validity validity--ng";

  el.fields.innerHTML = [
    fieldRow("なまえ", info.name),
    fieldRow("ぶき", info.weapon),
    fieldRow("よろい", info.armor),
    fieldRow("たて", info.shield),
    fieldRow("どうぐ", info.items.join("、")),
    fieldRow("かぎの数", info.key),
    fieldRow("薬草の数", info.herb),
    fieldRow("経験値", info.exp),
    fieldRow("ゴールド", info.gold),
    fieldRow("りゅうのうろこ", info.scale ? "装備した" : "装備していない"),
    fieldRow("せんしのゆびわ", info.ring ? "装備した" : "装備していない"),
    fieldRow("ドラゴン", info.dragon ? "倒した" : "倒していない"),
    fieldRow("ゴーレム", info.golem ? "倒した" : "倒していない"),
    fieldRow("しのくびかざり", info.necklace ? "入手した" : "入手していない"),
    fieldRow("パターン", info.pattern),
  ].join("");

  el.result.style.display = "";
}

function renderSteps(steps) {
  el.stepsBody.textContent = [
    `変換後の文字列: ${steps.password}`,
    `10進数: [${steps.nums.join(", ")}]`,
    `2進数(6bitごと): [${steps.passwordBinary.join(", ")}]`,
    `差分計算後: [${steps.codes.join(", ")}]`,
    `並び替え後(8bitごと): [${steps.byte.join(", ")}]`,
    `チェックコード: ${steps.crc} (先頭バイト: ${steps.byte[0]})`,
  ].join("\n");
}

function doDecode() {
  el.error.textContent = "";
  el.result.style.display = "none";

  const r = decodePassword(el.input.value);
  if (!r.ok) {
    el.error.textContent = r.error;
    return;
  }
  renderResult(r.info);
  renderSteps(r.steps);
}

el.input.value = SAMPLE_PASSWORD;
el.btnDecode.addEventListener("click", doDecode);
el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doDecode();
});
