import {
  generatePassword, ITEM_NAMES, TOWN_NAMES,
  MOON_STATE_NAMES, GATE_STATE_NAMES, PLUMAGE_STATE_NAMES, SHIP_STATE_NAMES, PRINCE_STATE_NAMES,
} from "./generator.js";

const ITEM_SLOTS = 8;

const el = {
  roName: document.getElementById("ro-name"),
  roNameCount: document.getElementById("ro-name-count"),
  roExp: document.getElementById("ro-exp"),
  roItems: document.getElementById("ro-items"),
  saFlag: document.getElementById("sa-flag"),
  saBody: document.getElementById("sa-body"),
  saExp: document.getElementById("sa-exp"),
  saItems: document.getElementById("sa-items"),
  muFlag: document.getElementById("mu-flag"),
  muBody: document.getElementById("mu-body"),
  muExp: document.getElementById("mu-exp"),
  muItems: document.getElementById("mu-items"),
  gold: document.getElementById("gold"),
  town: document.getElementById("town"),
  flagMoon: document.getElementById("flag-moon"),
  flagGate: document.getElementById("flag-gate"),
  flagPlumage: document.getElementById("flag-plumage"),
  statShip: document.getElementById("stat-ship"),
  statPrince: document.getElementById("stat-prince"),
  pattern: document.getElementById("pattern"),
  crestLife: document.getElementById("crest-life"),
  crestWater: document.getElementById("crest-water"),
  crestMoon: document.getElementById("crest-moon"),
  crestStar: document.getElementById("crest-star"),
  crestSun: document.getElementById("crest-sun"),
  btnGenerate: document.getElementById("btn-generate"),
  error: document.getElementById("error"),
  result: document.getElementById("result"),
  jumonOutput: document.getElementById("jumon-output"),
  stepsBody: document.getElementById("steps-body"),
};

function fillSelect(select, names) {
  select.innerHTML = names.map((name, i) => `<option value="${i}">${name}</option>`).join("");
}

function buildItemRows(container) {
  container.innerHTML = "";
  const rows = [];
  for (let i = 0; i < ITEM_SLOTS; i++) {
    const row = document.createElement("div");
    row.className = "item-row";
    const select = document.createElement("select");
    select.innerHTML = ITEM_NAMES.map((name, idx) => `<option value="${idx}">${name}</option>`).join("");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode("装備"));
    row.appendChild(select);
    row.appendChild(label);
    container.appendChild(row);
    rows.push({ select, checkbox });
  }
  return rows;
}

fillSelect(el.town, TOWN_NAMES);
fillSelect(el.flagMoon, MOON_STATE_NAMES);
fillSelect(el.flagGate, GATE_STATE_NAMES);
fillSelect(el.flagPlumage, PLUMAGE_STATE_NAMES);
fillSelect(el.statShip, SHIP_STATE_NAMES);
fillSelect(el.statPrince, PRINCE_STATE_NAMES);

const roItemRows = buildItemRows(el.roItems);
const saItemRows = buildItemRows(el.saItems);
const muItemRows = buildItemRows(el.muItems);

function readItems(rows) {
  return rows.map(({ select, checkbox }) => ({ item: Number(select.value), equip: checkbox.checked }));
}

function updateNameCount() {
  const len = Array.from(el.roName.value).length;
  el.roNameCount.textContent = `${len}/4文字`;
}

// サマルトリア王子が仲間でないと、ムーンブルク王女のデータはじゅもんに一切反映されない
// (元Notebookの仕様どおり)。混乱を避けるため、UI上でも連動して無効化する。
function updateMemberToggles() {
  el.saBody.disabled = !el.saFlag.checked;
  el.muFlag.disabled = !el.saFlag.checked;
  if (!el.saFlag.checked) el.muFlag.checked = false;
  el.muBody.disabled = !(el.saFlag.checked && el.muFlag.checked);
}

function readForm() {
  return {
    ro: { name: el.roName.value, exp: Number(el.roExp.value), items: readItems(roItemRows) },
    sa: { flag: el.saFlag.checked, exp: Number(el.saExp.value), items: readItems(saItemRows) },
    mu: { flag: el.muFlag.checked, exp: Number(el.muExp.value), items: readItems(muItemRows) },
    gold: Number(el.gold.value),
    town: Number(el.town.value),
    flagMoon: Number(el.flagMoon.value),
    flagGate: Number(el.flagGate.value),
    flagPlumage: Number(el.flagPlumage.value),
    statShip: Number(el.statShip.value),
    statPrince: Number(el.statPrince.value),
    crestLife: el.crestLife.checked,
    crestWater: el.crestWater.checked,
    crestMoon: el.crestMoon.checked,
    crestStar: el.crestStar.checked,
    crestSun: el.crestSun.checked,
    pattern: Number(el.pattern.value),
  };
}

function renderSteps(steps) {
  el.stepsBody.textContent = [
    `ビット列(${steps.bytesStr.length}bit): ${steps.bytesStr}`,
    `8bitごと(${steps.byte.length}バイト): [${steps.byte.join(", ")}]`,
    `チェックコード: ${steps.crc}`,
    `6bitごと(${steps.passwordBits.length}文字分): [${steps.passwordBits.join(", ")}]`,
    `じゅもん(整形前): ${steps.jumon}`,
  ].join("\n");
}

function doGenerate() {
  el.error.textContent = "";
  el.result.style.display = "none";

  const r = generatePassword(readForm());
  if (!r.ok) {
    el.error.textContent = r.error;
    return;
  }
  el.jumonOutput.textContent = r.jumon.trimEnd();
  renderSteps(r.steps);
  el.result.style.display = "";
}

el.roName.addEventListener("input", updateNameCount);
el.saFlag.addEventListener("change", updateMemberToggles);
el.muFlag.addEventListener("change", updateMemberToggles);
el.btnGenerate.addEventListener("click", doGenerate);

updateNameCount();
updateMemberToggles();
