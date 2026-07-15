// bb/app.js — baの現在形ビューワ(読み取り専用の投影)。
// 恒久制約: baを読むだけで一切書かない(POSTコードを持たない)。正本はba。
// スレッド束ね・分類解決のロジックはba/app.js(ba-32/ba-33)と同じ規則に従う。
const BA_API = "https://ab-board-api.azurewebsites.net/api/ba";

const CLASSIFICATIONS = ["案件", "確定仕様", "気づき", "保留論点"];
const CLS_KEY = { "案件": "anken", "確定仕様": "shiyou", "気づき": "kizuki", "保留論点": "horyu" };
// 現在形ビューとしての並び順: 参照し続けるもの→動かすもの→考えるもの→ながめるもの
const SECTION_ORDER = ["確定仕様", "案件", "保留論点", "気づき", null];

// ba-29踏襲: innerHTMLへ流し込む前のHTMLエスケープ。
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// n4-5踏襲: createdAtはUTC保存のためJSTへ明示変換して表示する。
function fmtTs(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const jst = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return jst.replace(",", "") + " JST";
}

// スレッド化と現在形の計算(ba/app.jsのgroupThreadsと同じ規則+最新記述の抽出)。
function project(items) {
  const byThread = new Map();
  items.forEach((it) => {
    if (!byThread.has(it.threadId)) byThread.set(it.threadId, []);
    byThread.get(it.threadId).push(it);
  });

  const threads = [];
  byThread.forEach((entries, threadId) => {
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const root = entries.find((e) => e.id === threadId) || entries[0];

    const voidView = {};
    let status = "open";
    let displayTitle = root.title;
    let cls = null;
    let latestText = null; // 現在形 = 最新の実質記述(new/note/correctionのbody)
    entries.forEach((e) => {
      if (e.type === "void" && e.by) voidView[e.by.startsWith("claude") ? "claude" : "takashi"] = !!e.value;
      if (e.type === "status" && e.status) status = e.status;
      if (e.type === "correction" && e.title) displayTitle = e.title;
      if (e.type === "new" || e.type === "note" || e.type === "correction") {
        const found = (Array.isArray(e.tags) ? e.tags : []).find((t) => CLASSIFICATIONS.includes(t));
        if (found) cls = found;
        if (e.body) latestText = e.body;
      }
    });

    const hiddenVoid = voidView.claude === true && voidView.takashi === true;
    const lastAt = entries[entries.length - 1].createdAt;
    threads.push({ threadId, root, status, displayTitle, cls, hiddenVoid, latestText, lastAt, count: entries.length });
  });

  threads.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return threads;
}

function itemHtml(t) {
  const isOpen = t.status === "open";
  const tags = (Array.isArray(t.root.tags) ? t.root.tags : []).filter((x) => !CLASSIFICATIONS.includes(x));
  const excerpt = t.latestText ? esc(t.latestText.length > 120 ? t.latestText.slice(0, 120) + "…" : t.latestText) : "";
  return `
    <div class="bb-item">
      <div class="bb-item-top">
        ${t.root.seq ? `<span class="seq-chip">ba-${t.root.seq}</span>` : ""}
        <span class="pill ${isOpen ? "pill-open" : "pill-closed"}">${isOpen ? "open" : "closed"}</span>
        <span class="bb-item-title">${esc(t.displayTitle || "(無題)")}</span>
      </div>
      <div class="bb-item-sub">${tags.map((x) => `<span class="tag">#${esc(x)}</span>`).join(" ")} 最終更新 ${fmtTs(t.lastAt)} / ${t.count}件</div>
      ${excerpt ? `<div class="bb-latest">${excerpt}</div>` : ""}
    </div>`;
}

let showClosed = false;
let cached = [];

function render() {
  const threads = cached.filter((t) => !t.hiddenVoid);
  const visible = showClosed ? threads : threads.filter((t) => t.status === "open" || t.cls === "確定仕様");

  document.getElementById("statTotal").textContent = threads.length;
  document.getElementById("statOpen").textContent = threads.filter((t) => t.status === "open").length;
  document.getElementById("statShiyou").textContent = threads.filter((t) => t.cls === "確定仕様").length;
  const latest = threads[0];
  document.getElementById("statLatest").textContent = latest ? fmtTs(latest.lastAt).slice(5, 10) : "—";

  const closedCount = threads.filter((t) => t.status !== "open" && t.cls !== "確定仕様").length;
  const btn = document.getElementById("btnToggleClosed");
  btn.textContent = showClosed ? `closedを隠す(${closedCount})` : `closedも表示(${closedCount})`;

  const secEl = document.getElementById("sections");
  secEl.innerHTML = SECTION_ORDER.map((cls) => {
    const list = visible.filter((t) => t.cls === cls || (cls === null && !t.cls));
    if (!list.length) return "";
    const label = cls
      ? `<span class="cls-badge cls-badge--${CLS_KEY[cls]}">${cls}</span> ${list.length}件${cls === "確定仕様" ? "(closeせず参照し続ける)" : ""}`
      : `未分類 ${list.length}件`;
    return `<div class="sec-label">${label}</div>` + list.map(itemHtml).join("");
  }).join("") || `<p class="empty">表示できるスレッドがありません</p>`;
}

function renderRecent(items) {
  const rows = items
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8)
    .map((e) => {
      const t = cached.find((x) => x.threadId === e.threadId);
      const seq = t && t.root.seq ? `ba-${t.root.seq}` : "";
      const label = e.type === "status" ? `status → ${esc(e.status || "")}` : e.type;
      return `<div class="recent-row"><span class="entry-type">${label}</span>${seq ? `<span class="seq-chip">${seq}</span> ` : ""}${esc((t && t.displayTitle) || "")} <span style="color:var(--ink-soft);">${fmtTs(e.createdAt)} / ${esc(e.by)}</span></div>`;
    });
  document.getElementById("recent").innerHTML = rows.join("") || `<p class="empty">まだ動きがありません</p>`;
}

async function load() {
  const secEl = document.getElementById("sections");
  try {
    const res = await fetch(BA_API, { cache: "no-store", headers: { "X-Ba-Credential": window.__credential || "" } });
    if (!res.ok) throw new Error(`status=${res.status}`);
    const items = await res.json();
    cached = project(items);
    render();
    renderRecent(items);
  } catch (e) {
    secEl.innerHTML = `<p class="empty">読み込みエラー: ${esc(e.message)}</p>`;
  }
}

function onLoginSuccess() {
  document.getElementById("btnToggleClosed").addEventListener("click", () => {
    showClosed = !showClosed;
    render();
  });
  load();
}

if (window.__loginState && window.__loginState.loggedIn) {
  onLoginSuccess();
} else {
  window.addEventListener("bb-login-success", onLoginSuccess, { once: true });
}
