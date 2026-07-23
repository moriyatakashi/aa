// app.js — k2(baレーダーチャート)。baの生ログを読み、
// (1)投稿者別: 投稿者3人を軸にした参加スレッド数、
// (2)分類別: ba-32規約の4分類(案件/確定仕様/気づき/保留論点)ごとのスレッド数
// をタブ切り替えでレーダーチャート表示する。読み取り専用。
// config.jsを自分でimportする(ba-9追補)。HTML側の<script>読込に依存しないため、
// 旧index.htmlがキャッシュされた端末でも壊れない(2026-07-16の表示不具合の恒久対策)。
import "../common/config.js";
import { CLASSIFICATIONS, findClassification } from "../common/utils.js";
const API_BASE = window.AA_API_BASE; // common/config.js から(ba-9)
const BA_API = `${API_BASE}/ba`;
const WEEKLY_API = `${API_BASE}/weekly-scores`;

// ba/app.jsのgroupThreadsを踏襲(status判定・PartitionKeyグルーピングのロジックを合わせるため)。
function groupThreads(items) {
  const byThread = new Map();
  items.forEach((it) => {
    if (!byThread.has(it.threadId)) byThread.set(it.threadId, []);
    byThread.get(it.threadId).push(it);
  });

  const threads = [];
  byThread.forEach((entries, threadId) => {
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const root = entries.find((e) => e.id === threadId) || entries[0];
    let status = "open";
    entries.forEach((e) => {
      if (e.type === "status" && e.status) status = e.status;
    });
    threads.push({ threadId, root, entries, status });
  });

  return threads;
}

// 投稿者3人の判定基準: 全エントリのby(発言したら参加扱い)。
// 値: そのby(投稿者)が関わったスレッド数(open/closed問わず全部含む)。
function computePosterCounts(threads) {
  const counts = new Map(); // by -> count

  threads.forEach((thread) => {
    const posters = new Set(thread.entries.map((e) => e.by).filter(Boolean));
    posters.forEach((by) => {
      counts.set(by, (counts.get(by) || 0) + 1);
    });
  });

  return counts;
}

// 分類別の判定基準: スレッド内のnoteエントリでtagsに4分類のいずれかが付いたもののうち、
// 最も新しいcreatedAtのものを「そのスレッドの現在の分類」とする
// (ba-32運用: 分類の訂正・バックフィルは新しいnoteの追記で上書きする方式のため)。
function computeClassificationCounts(threads) {
  const counts = new Map(CLASSIFICATIONS.map((c) => [c, 0]));

  threads.forEach((thread) => {
    let latest = null; // entriesはcreatedAt昇順ソート済みなので、最後に見つかったものが最新
    thread.entries.forEach((e) => {
      const found = findClassification(e.tags);
      if (found) latest = found;
    });
    if (latest) counts.set(latest, counts.get(latest) + 1);
  });

  return counts;
}

const COLOR = "#6cf";

// 軸=Mapのkey、頂点の値=Mapのvalue。多角形1つとして描画する(軸数は可変)。
function drawRadar(svg, counts) {
  const labels = Array.from(counts.keys());
  const cx = 160, cy = 150, r = 100;
  const maxVal = Math.max(1, ...labels.map((l) => counts.get(l)));

  const angleFor = (i) => (Math.PI * 2 * i) / labels.length - Math.PI / 2;
  const pointFor = (i, val) => {
    const a = angleFor(i);
    const dist = (val / maxVal) * r;
    return [cx + dist * Math.cos(a), cy + dist * Math.sin(a)];
  };

  let svgParts = [];

  // グリッド(同心の多角形、4分割)
  for (let ring = 1; ring <= 4; ring++) {
    const ringR = (r * ring) / 4;
    const pts = labels.map((_, i) => {
      const a = angleFor(i);
      return `${cx + ringR * Math.cos(a)},${cy + ringR * Math.sin(a)}`;
    }).join(" ");
    svgParts.push(`<polygon points="${pts}" fill="none" stroke="#444" stroke-width="1"/>`);
  }

  // 軸線とラベル(ラベル名+件数)
  labels.forEach((label, i) => {
    const a = angleFor(i);
    const x2 = cx + r * Math.cos(a), y2 = cy + r * Math.sin(a);
    svgParts.push(`<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="#444" stroke-width="1"/>`);
    const lx = cx + (r + 30) * Math.cos(a), ly = cy + (r + 30) * Math.sin(a);
    svgParts.push(`<text x="${lx}" y="${ly}" fill="#eee" font-size="13" text-anchor="middle" dominant-baseline="middle">${label} (${counts.get(label)})</text>`);
  });

  // 多角形(1つ)
  const pts = labels.map((label, i) => pointFor(i, counts.get(label)).join(",")).join(" ");
  svgParts.push(`<polygon points="${pts}" fill="${COLOR}" fill-opacity="0.25" stroke="${COLOR}" stroke-width="2"/>`);
  labels.forEach((label, i) => {
    const [px, py] = pointFor(i, counts.get(label));
    svgParts.push(`<circle cx="${px}" cy="${py}" r="3" fill="${COLOR}"/>`);
  });

  svg.innerHTML = svgParts.join("\n");
}

function renderTable(theadRow, tbody, counts, labelHeader, valueHeader) {
  theadRow.innerHTML = `<th>${labelHeader}</th><th>${valueHeader}</th>`;
  const labels = Array.from(counts.keys());
  tbody.innerHTML = labels.map((label) => {
    return `<tr><td>${label}</td><td>${counts.get(label)}</td></tr>`;
  }).join("");
}

// --- 週次得点(ba-53のweekly-scores API)------------------------------------
// レーダーは複数軸のバランス用なので、単一値の時系列である週次得点は棒グラフで描く。
// 日次スコアとクローズ得点は性質が異なるため積み上げで内訳が見える形にする。
const WEEK_COUNT = 8;
const C_DAILY = "#6cf";
const C_CLOSE = "#5aa06a";

function isoWeeksBack(n) {
  // 今週(JSTの月曜起点)からn週分さかのぼったISO年・週の一覧
  const now = new Date();
  const jst = new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60000);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(jst.getTime() - i * 7 * 86400000);
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
    out.push({ year: t.getUTCFullYear(), week });
  }
  return out;
}

// 週の表示は月曜のM/d(5文字以内)
function weekLabel(weekStart) {
  const [, m, d] = weekStart.split("-");
  return `${Number(m)}/${Number(d)}`;
}

async function fetchWeeklyScores() {
  const weeks = isoWeeksBack(WEEK_COUNT);
  const results = await Promise.all(weeks.map(async ({ year, week }) => {
    try {
      const key = `${year}-W${String(week).padStart(2, "0")}`;
      const res = await fetch(`${WEEKLY_API}/${key}`, { cache: "no-store" });
      return res.ok ? await res.json() : null;
    } catch (e) {
      return null;
    }
  }));
  return results.filter((r) => r && r.weekStart);
}

function drawWeeklyBars(svg, weeks) {
  const W = 320, H = 320;
  const left = 34, right = 10, top = 16, bottom = 46;
  const plotW = W - left - right, plotH = H - top - bottom;
  const maxVal = Math.max(1, ...weeks.map((w) => w.weekScore));
  const step = plotW / weeks.length;
  const barW = Math.min(26, step * 0.6);
  const parts = [];

  // 目盛り(4本)
  for (let i = 0; i <= 4; i++) {
    const v = Math.round((maxVal * i) / 4);
    const y = top + plotH - (plotH * i) / 4;
    parts.push(`<line x1="${left}" y1="${y}" x2="${W - right}" y2="${y}" stroke="#888" stroke-opacity="0.25"/>`);
    parts.push(`<text x="${left - 5}" y="${y + 3}" font-size="8" fill="currentColor" opacity="0.65" text-anchor="end">${v}</text>`);
  }

  weeks.forEach((w, i) => {
    const cx = left + step * i + step / 2;
    const x = cx - barW / 2;
    const hDaily = (w.dailyScoreSum / maxVal) * plotH;
    const hClose = (w.closeValue / maxVal) * plotH;
    const yDaily = top + plotH - hDaily;
    const yClose = yDaily - hClose;
    parts.push(`<rect x="${x}" y="${yDaily}" width="${barW}" height="${hDaily}" fill="${C_DAILY}"/>`);
    if (w.closeValue > 0) {
      parts.push(`<rect x="${x}" y="${yClose}" width="${barW}" height="${hClose}" fill="${C_CLOSE}"/>`);
    }
    parts.push(`<text x="${cx}" y="${yClose - 4}" font-size="8" fill="currentColor" text-anchor="middle">${w.weekScore}</text>`);
    parts.push(`<text x="${cx}" y="${H - bottom + 14}" font-size="9" fill="currentColor" opacity="0.75" text-anchor="middle">${weekLabel(w.weekStart)}</text>`);
  });

  // 凡例
  parts.push(`<rect x="${left}" y="${H - 20}" width="9" height="9" fill="${C_DAILY}"/>`);
  parts.push(`<text x="${left + 13}" y="${H - 12}" font-size="9" fill="currentColor">日次スコア</text>`);
  parts.push(`<rect x="${left + 78}" y="${H - 20}" width="9" height="9" fill="${C_CLOSE}"/>`);
  parts.push(`<text x="${left + 91}" y="${H - 12}" font-size="9" fill="currentColor">クローズ得点</text>`);

  svg.innerHTML = parts.join("\n");
}

function renderWeeklyTable(theadRow, tbody, weeks) {
  theadRow.innerHTML = "<th>週(月曜)</th><th>日次</th><th>クローズ</th><th>合計</th>";
  tbody.innerHTML = weeks.slice().reverse().map((w) => (
    `<tr><td>${weekLabel(w.weekStart)}</td><td>${w.dailyScoreSum}</td>` +
    `<td>${w.closeValue}<span style="opacity:.6;font-size:.8em"> (${w.closeCount}件)</span></td>` +
    `<td>${w.weekScore}</td></tr>`
  )).join("");
}

const VIEWS = {
  poster: {
    compute: computePosterCounts,
    labelHeader: "投稿者",
    valueHeader: "投稿数(スレッド数・クローズ含む)",
  },
  classification: {
    compute: computeClassificationCounts,
    labelHeader: "分類",
    valueHeader: "スレッド数",
  },
};

let currentThreads = [];
let weeklyScores = [];
let currentView = "poster";

function render() {
  const svg = document.getElementById("radarSvg");
  const tbody = document.getElementById("radarTableBody");
  const theadRow = document.getElementById("radarTableHead");
  const emptyEl = document.getElementById("radarEmpty");

  if (!currentThreads.length && currentView !== "weekly") {
    emptyEl.style.display = "";
    svg.innerHTML = "";
    tbody.innerHTML = "";
    return;
  }
  emptyEl.style.display = "none";

  if (currentView === "weekly") {
    if (!weeklyScores.length) {
      emptyEl.textContent = "週次得点をまだ取得できていません";
      emptyEl.style.display = "";
      svg.innerHTML = "";
      tbody.innerHTML = "";
      return;
    }
    drawWeeklyBars(svg, weeklyScores);
    renderWeeklyTable(theadRow, tbody, weeklyScores);
    return;
  }

  const view = VIEWS[currentView];
  const counts = view.compute(currentThreads);

  drawRadar(svg, counts);
  renderTable(theadRow, tbody, counts, view.labelHeader, view.valueHeader);
}

function setupTabs() {
  const tabs = document.querySelectorAll(".view-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      currentView = tab.dataset.view;
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      render();
    });
  });
}

async function load() {
  const emptyEl = document.getElementById("radarEmpty");

  try {
    const res = await fetch(BA_API, { cache: "no-store" });
    const items = res.ok ? await res.json() : [];
    currentThreads = groupThreads(items);
    render();
    weeklyScores = await fetchWeeklyScores();
    if (currentView === "weekly") render();
  } catch (e) {
    emptyEl.textContent = `読み込みエラー: ${e.message}`;
    emptyEl.style.display = "";
  }
}

function onLoginSuccess() {
  setupTabs();
  load();
}

if (window.__loginState && window.__loginState.loggedIn) {
  onLoginSuccess();
} else {
  window.addEventListener("k2-login-success", onLoginSuccess, { once: true });
}
