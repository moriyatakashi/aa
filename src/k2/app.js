// app.js — k2(baレーダーチャート)。baの生ログを読み、
// (1)投稿者別: 投稿者3人を軸にした参加スレッド数、
// (2)分類別: ba-32規約の4分類(案件/確定仕様/気づき/保留論点)ごとのスレッド数
// をタブ切り替えでレーダーチャート表示する。読み取り専用。
// config.jsを自分でimportする(ba-9追補)。HTML側の<script>読込に依存しないため、
// 旧index.htmlがキャッシュされた端末でも壊れない(2026-07-16の表示不具合の恒久対策)。
import "../cm/config.js";
const API_BASE = window.AA_API_BASE; // cm/config.js から(ba-9)
const BA_API = `${API_BASE}/ba`;

const CLASSIFICATIONS = ["案件", "確定仕様", "気づき", "保留論点"];

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
      const tags = e.tags || [];
      const found = tags.find((t) => CLASSIFICATIONS.includes(t));
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
let currentView = "poster";

function render() {
  const svg = document.getElementById("radarSvg");
  const tbody = document.getElementById("radarTableBody");
  const theadRow = document.getElementById("radarTableHead");
  const emptyEl = document.getElementById("radarEmpty");

  if (!currentThreads.length) {
    emptyEl.style.display = "";
    svg.innerHTML = "";
    tbody.innerHTML = "";
    return;
  }
  emptyEl.style.display = "none";

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
    const res = await fetch(BA_API, { cache: "no-store", headers: { "X-Ba-Credential": window.__credential || "" } });
    const items = res.ok ? await res.json() : [];
    currentThreads = groupThreads(items);
    render();
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
