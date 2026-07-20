// bb/app.js — baの現在形ビューワ(読み取り専用の投影)。
// 恒久制約: baを読むだけで一切書かない(POSTコードを持たない)。正本はba。
// スレッド束ね・分類解決のロジックはba/app.js(ba-32/ba-33)と同じ規則に従う。
// config.jsを自分でimportする(ba-9追補)。HTML側の<script>読込に依存しないため、
// 旧index.htmlがキャッシュされた端末でも壊れない(2026-07-16の表示不具合の恒久対策)。
import "../common/config.js";
import { esc, fmtTs, CLASSIFICATIONS, CLS_KEY, filterFreeTags } from "../common/utils.js";
import { projectThreads } from "../common/thread-logic.js";

const BA_API = `${window.AA_API_BASE}/ba`; // common/config.js から(ba-9)

// 現在形ビューとしての並び順: 参照し続けるもの→動かすもの→考えるもの→ながめるもの
const SECTION_ORDER = ["確定仕様", "案件", "保留論点", "気づき", null];

function itemHtml(t) {
  const isOpen = t.status === "open";
  const tags = filterFreeTags(t.root.tags);
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
    const list = visible
      .filter((t) => t.cls === cls || (cls === null && !t.cls))
      .sort((a, b) => (b.root.seq || 0) - (a.root.seq || 0));
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
      return `<div class="recent-row"><span class="entry-type">${label}</span>${seq ? `<span class="seq-chip">${seq}</span> ` : ""}${esc((t && t.displayTitle) || "")} <span style="color:var(--ink-soft);">${fmtTs(e.createdAt)}</span></div>`;
    });
  document.getElementById("recent").innerHTML = rows.join("") || `<p class="empty">まだ動きがありません</p>`;
}

async function load() {
  const secEl = document.getElementById("sections");
  try {
    // GETは無認証で公開(2026-07-15、ba-16一部撤回)。credentialヘッダーは送らない。
    const res = await fetch(BA_API, { cache: "no-store" });
    if (!res.ok) throw new Error(`status=${res.status}`);
    const items = await res.json();
    cached = projectThreads(items);
    render();
    renderRecent(items);
  } catch (e) {
    secEl.innerHTML = `<p class="empty">読み込みエラー: ${esc(e.message)}</p>`;
  }
}

document.getElementById("btnToggleClosed").addEventListener("click", () => {
  showClosed = !showClosed;
  render();
});
load();
