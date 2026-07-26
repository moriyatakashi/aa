// app.js — n3(予定)。ba-160: 宣言(先の週の予定を書いて、達成したら加点)と、
// Googleカレンダーの直近予定(読み取り専用、認証必須)を表示する。
// config.jsを自分でimportする(ba-9追補、旧index.htmlキャッシュ対策)。
import "../common/config.js";
import { esc, withCredential } from "../common/utils.js";
const API_BASE = window.AA_API_BASE;
const DECLARATIONS_API = `${API_BASE}/declarations`;
const CALENDAR_API = `${API_BASE}/calendar-events`;

// ISO 8601週番号(月曜始まり)。バックエンドのPythonのdate.isocalendar()と同じ定義。
function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function mondayOf(d) {
  const day = d.getDay() || 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - day + 1);
  return monday;
}

function initTargetWeekOptions() {
  const sel = document.getElementById("targetWeek");
  const thisMonday = mondayOf(new Date());
  for (let i = 1; i <= 6; i++) {
    const monday = new Date(thisMonday);
    monday.setDate(thisMonday.getDate() + i * 7);
    const key = isoWeekKey(monday);
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = `${key}(${monday.getMonth() + 1}/${monday.getDate()}週, ${i}週先)`;
    sel.appendChild(opt);
  }
}

async function achieveDeclaration(id) {
  if (!window.__credential) {
    if (window.aaShowLoginGate) window.aaShowLoginGate();
    return;
  }
  const res = await fetch(`${DECLARATIONS_API}/${id}/achieve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withCredential({})),
  });
  if (!res.ok) { alert("達成の記録に失敗しました"); return; }
  const result = await res.json();
  alert(`達成しました。+${result.awardedPoints}点を記録しました。`);
  loadDeclarations();
}

async function loadDeclarations() {
  const openList = document.getElementById("openDeclList");
  const doneList = document.getElementById("doneDeclList");
  const openEmpty = document.getElementById("openDeclEmpty");
  try {
    const res = await fetch(DECLARATIONS_API, { cache: "no-store" });
    const items = res.ok ? await res.json() : [];
    items.sort((a, b) => a.targetWeek.localeCompare(b.targetWeek));

    const open = items.filter((d) => !d.achieved);
    const done = items.filter((d) => d.achieved).reverse();

    openEmpty.style.display = open.length ? "none" : "block";
    openList.innerHTML = open.map((d) => (
      `<div class="decl-row" data-id="${esc(d.id)}">` +
      `<span>${esc(d.text)}(${esc(d.targetWeek)})</span>` +
      `<button type="button" class="btn-achieve" data-id="${esc(d.id)}">達成</button>` +
      `</div>`
    )).join("");
    openList.querySelectorAll(".btn-achieve").forEach((btn) => {
      btn.addEventListener("click", () => achieveDeclaration(btn.dataset.id));
    });

    doneList.innerHTML = done.map((d) => (
      `<div class="decl-row decl-row--done"><span>✓ ${esc(d.text)}(${esc(d.targetWeek)})</span></div>`
    )).join("");
  } catch (e) {
    openList.innerHTML = `<p class="empty">読み込みエラー: ${esc(e.message)}</p>`;
  }
}

function initDeclarationForm() {
  const elText = document.getElementById("declText");
  const elWeek = document.getElementById("targetWeek");
  const elBtn = document.getElementById("btnAddDecl");
  const elStatus = document.getElementById("declStatus");

  elBtn.addEventListener("click", async () => {
    if (!window.__credential) {
      elStatus.textContent = "追加にはログインが必要です";
      if (window.aaShowLoginGate) window.aaShowLoginGate();
      return;
    }
    const text = elText.value.trim();
    if (!text) { elText.focus(); return; }
    try {
      const res = await fetch(DECLARATIONS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withCredential({ text, targetWeek: elWeek.value })),
      });
      if (!res.ok) { elStatus.textContent = "エラー: 追加に失敗しました"; return; }
      elText.value = "";
      elStatus.textContent = "✓ 追加しました";
      setTimeout(() => elStatus.textContent = "", 2000);
      loadDeclarations();
    } catch (e) {
      elStatus.textContent = "エラー: " + e.message;
    }
  });
}

async function loadCalendar() {
  const listEl = document.getElementById("calendarList");
  const statusEl = document.getElementById("calendarStatus");
  if (!window.__credential) {
    statusEl.textContent = "ログインすると予定が表示されます";
    listEl.innerHTML = "";
    return;
  }
  try {
    const url = `${CALENDAR_API}?credential=${encodeURIComponent(window.__credential)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      statusEl.textContent = res.status === 503 ? "カレンダー連携が未設定です" : "予定の取得に失敗しました";
      listEl.innerHTML = "";
      return;
    }
    const items = await res.json();
    statusEl.textContent = "";
    listEl.innerHTML = items.map((ev) => {
      const start = (ev.start || "").replace("T", " ").slice(0, 16);
      return `<div class="cal-row"><div class="cal-summary">${esc(ev.summary || "(無題)")}</div>` +
        `<div class="cal-meta">${esc(start)}${ev.location ? " — " + esc(ev.location) : ""}</div></div>`;
    }).join("") || `<p class="empty">直近の予定はありません</p>`;
  } catch (e) {
    statusEl.textContent = "エラー: " + e.message;
  }
}

function onLoginSuccess() {
  initTargetWeekOptions();
  initDeclarationForm();
  loadDeclarations();
  loadCalendar();
}

if (window.__loginState && window.__loginState.loggedIn) {
  onLoginSuccess();
} else {
  window.addEventListener("n3-login-success", onLoginSuccess, { once: true });
}
