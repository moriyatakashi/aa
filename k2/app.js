// app.js — k2(baリーダーチャート)。baの生ログを読み、投稿者3人を軸にした
// レーダーチャート(三角形)で「参加スレッド数(クローズ含む)」を可視化する。読み取り専用。
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

const COLOR = "#6cf";

// 軸=投稿者3人、頂点の値=投稿数(スレッド数)。1つの三角形として描画する。
function drawRadar(svg, posterCounts) {
  const posters = Array.from(posterCounts.keys());
  const cx = 160, cy = 150, r = 100;
  const maxVal = Math.max(1, ...posters.map((p) => posterCounts.get(p)));

  const angleFor = (i) => (Math.PI * 2 * i) / posters.length - Math.PI / 2;
  const pointFor = (i, val) => {
    const a = angleFor(i);
    const dist = (val / maxVal) * r;
    return [cx + dist * Math.cos(a), cy + dist * Math.sin(a)];
  };

  let svgParts = [];

  // グリッド(同心の多角形、4分割)
  for (let ring = 1; ring <= 4; ring++) {
    const ringR = (r * ring) / 4;
    const pts = posters.map((_, i) => {
      const a = angleFor(i);
      return `${cx + ringR * Math.cos(a)},${cy + ringR * Math.sin(a)}`;
    }).join(" ");
    svgParts.push(`<polygon points="${pts}" fill="none" stroke="#444" stroke-width="1"/>`);
  }

  // 軸線とラベル(投稿者名+件数)
  posters.forEach((by, i) => {
    const a = angleFor(i);
    const x2 = cx + r * Math.cos(a), y2 = cy + r * Math.sin(a);
    svgParts.push(`<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="#444" stroke-width="1"/>`);
    const lx = cx + (r + 30) * Math.cos(a), ly = cy + (r + 30) * Math.sin(a);
    svgParts.push(`<text x="${lx}" y="${ly}" fill="#eee" font-size="13" text-anchor="middle" dominant-baseline="middle">${by} (${posterCounts.get(by)})</text>`);
  });

  // 三角形(1つ)
  const pts = posters.map((by, i) => pointFor(i, posterCounts.get(by)).join(",")).join(" ");
  svgParts.push(`<polygon points="${pts}" fill="${COLOR}" fill-opacity="0.25" stroke="${COLOR}" stroke-width="2"/>`);
  posters.forEach((by, i) => {
    const [px, py] = pointFor(i, posterCounts.get(by));
    svgParts.push(`<circle cx="${px}" cy="${py}" r="3" fill="${COLOR}"/>`);
  });

  svg.innerHTML = svgParts.join("\n");
}

function renderTable(tbody, posterCounts) {
  const posters = Array.from(posterCounts.keys());
  tbody.innerHTML = posters.map((by) => {
    return `<tr><td>${by}</td><td>${posterCounts.get(by)}</td></tr>`;
  }).join("");
}

async function load() {
  const svg = document.getElementById("radarSvg");
  const tbody = document.getElementById("radarTableBody");
  const emptyEl = document.getElementById("radarEmpty");

  try {
    const res = await fetch(BA_API, { cache: "no-store", headers: { "X-Ba-Credential": window.__credential || "" } });
    const items = res.ok ? await res.json() : [];
    const threads = groupThreads(items);

    if (!threads.length) {
      emptyEl.style.display = "";
      svg.innerHTML = "";
      tbody.innerHTML = "";
      return;
    }
    emptyEl.style.display = "none";

    const posterCounts = computePosterCounts(threads);

    drawRadar(svg, posterCounts);
    renderTable(tbody, posterCounts);
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
