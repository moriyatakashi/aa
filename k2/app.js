// app.js — k2(baリーダーチャート)。baの生ログを読み、投稿者ごとの参加スレッド数を
// 「合計/open/closed」の3軸レーダーチャートで可視化する。書き込みは行わない(読み取り専用)。
const API_BASE = "https://ab-board-api.azurewebsites.net/api";
const BA_API = `${API_BASE}/ba`;

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
function computePosterStats(threads) {
  const stats = new Map(); // by -> { total, open, closed }

  threads.forEach((thread) => {
    const posters = new Set(thread.entries.map((e) => e.by).filter(Boolean));
    posters.forEach((by) => {
      if (!stats.has(by)) stats.set(by, { total: 0, open: 0, closed: 0 });
      const s = stats.get(by);
      s.total += 1;
      if (thread.status === "open") s.open += 1;
      else s.closed += 1;
    });
  });

  return stats;
}

const PALETTE = ["#6cf", "#f8b400", "#ff6b6b", "#8ee08e", "#c17bff"];

function drawRadar(svg, posterStats) {
  const posters = Array.from(posterStats.keys());
  const axes = ["合計", "open", "closed"];
  const keys = ["total", "open", "closed"];

  const cx = 160, cy = 150, r = 100;
  const maxVal = Math.max(1, ...posters.flatMap((p) => keys.map((k) => posterStats.get(p)[k])));

  const angleFor = (i) => (Math.PI * 2 * i) / axes.length - Math.PI / 2;
  const pointFor = (i, val) => {
    const a = angleFor(i);
    const dist = (val / maxVal) * r;
    return [cx + dist * Math.cos(a), cy + dist * Math.sin(a)];
  };

  let svgParts = [];

  // グリッド(同心の多角形、4分割)
  for (let ring = 1; ring <= 4; ring++) {
    const ringR = (r * ring) / 4;
    const pts = axes.map((_, i) => {
      const a = angleFor(i);
      return `${cx + ringR * Math.cos(a)},${cy + ringR * Math.sin(a)}`;
    }).join(" ");
    svgParts.push(`<polygon points="${pts}" fill="none" stroke="#444" stroke-width="1"/>`);
  }

  // 軸線とラベル
  axes.forEach((label, i) => {
    const a = angleFor(i);
    const x2 = cx + r * Math.cos(a), y2 = cy + r * Math.sin(a);
    svgParts.push(`<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="#444" stroke-width="1"/>`);
    const lx = cx + (r + 22) * Math.cos(a), ly = cy + (r + 22) * Math.sin(a);
    svgParts.push(`<text x="${lx}" y="${ly}" fill="#eee" font-size="13" text-anchor="middle" dominant-baseline="middle">${label}</text>`);
  });

  // 投稿者ごとのポリゴン
  posters.forEach((by, idx) => {
    const color = PALETTE[idx % PALETTE.length];
    const s = posterStats.get(by);
    const pts = keys.map((k, i) => pointFor(i, s[k]).join(",")).join(" ");
    svgParts.push(`<polygon points="${pts}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2"/>`);
    keys.forEach((k, i) => {
      const [px, py] = pointFor(i, s[k]);
      svgParts.push(`<circle cx="${px}" cy="${py}" r="3" fill="${color}"/>`);
    });
  });

  svg.innerHTML = svgParts.join("\n");
}

function renderLegend(el, posters) {
  el.innerHTML = posters.map((by, idx) => {
    const color = PALETTE[idx % PALETTE.length];
    return `<span class="radar-legend-item"><span class="radar-swatch" style="background:${color};"></span>${by}</span>`;
  }).join("");
}

function renderTable(tbody, posterStats) {
  const posters = Array.from(posterStats.keys());
  tbody.innerHTML = posters.map((by) => {
    const s = posterStats.get(by);
    return `<tr><td>${by}</td><td>${s.total}</td><td>${s.open}</td><td>${s.closed}</td></tr>`;
  }).join("");
}

async function load() {
  const svg = document.getElementById("radarSvg");
  const legendEl = document.getElementById("radarLegend");
  const tbody = document.getElementById("radarTableBody");
  const emptyEl = document.getElementById("radarEmpty");

  try {
    const res = await fetch(BA_API, { cache: "no-store", headers: { "X-Ba-Credential": window.__credential || "" } });
    const items = res.ok ? await res.json() : [];
    const threads = groupThreads(items);

    if (!threads.length) {
      emptyEl.style.display = "";
      svg.innerHTML = "";
      legendEl.innerHTML = "";
      tbody.innerHTML = "";
      return;
    }
    emptyEl.style.display = "none";

    const posterStats = computePosterStats(threads);
    const posters = Array.from(posterStats.keys());

    drawRadar(svg, posterStats);
    renderLegend(legendEl, posters);
    renderTable(tbody, posterStats);
  } catch (e) {
    emptyEl.textContent = `読み込みエラー: ${e.message}`;
    emptyEl.style.display = "";
  }
}

function onLoginSuccess() {
  load();
}

if (window.__loginState && window.__loginState.loggedIn) {
  onLoginSuccess();
} else {
  window.addEventListener("k2-login-success", onLoginSuccess, { once: true });
}
