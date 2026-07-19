// app.js — be(スコア推移)。n1が記録するスコア(ab-board-api /scores)を折れ線グラフで見せる読み取り専用ページ。
// k2(baレーダーチャート)のページ構造・ログイン待ちパターンを踏襲する。
// config.jsを自分でimportする(ba-9追補)。HTML側の<script>読込に依存しないため、
// 旧index.htmlがキャッシュされた端末でも壊れない。
import "../common/config.js";
const API_BASE = window.AA_API_BASE;
const SCORES_API = `${API_BASE}/scores`;

const Y_MIN = 60;
const Y_MAX = 100;
const VB_W = 680, VB_H = 300;
const MARGIN = { top: 16, right: 16, bottom: 32, left: 34 };
const PLOT_W = VB_W - MARGIN.left - MARGIN.right;
const PLOT_H = VB_H - MARGIN.top - MARGIN.bottom;

function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function xFor(i, n) {
  return MARGIN.left + (n === 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W);
}
function yFor(v) {
  return MARGIN.top + PLOT_H - ((v - Y_MIN) / (Y_MAX - Y_MIN)) * PLOT_H;
}

function drawChart(svg, rows) {
  svg.innerHTML = "";
  const n = rows.length;

  const yTicks = [];
  for (let t = Y_MIN; t <= Y_MAX; t += 10) yTicks.push(t);
  yTicks.forEach((t) => {
    svg.appendChild(svgEl("line", {
      class: t === Y_MIN ? "baseline" : "gridline",
      x1: MARGIN.left, x2: MARGIN.left + PLOT_W, y1: yFor(t), y2: yFor(t),
    }));
    const label = svgEl("text", { class: "axis-label", x: MARGIN.left - 8, y: yFor(t) + 4, "text-anchor": "end" });
    label.textContent = t;
    svg.appendChild(label);
  });

  const labelStep = Math.max(1, Math.ceil(n / 8));
  rows.forEach((r, i) => {
    if (i % labelStep === 0 || i === n - 1) {
      const label = svgEl("text", { class: "axis-label", x: xFor(i, n), y: VB_H - 8, "text-anchor": "middle" });
      label.textContent = r.date.slice(5).replace("-", "/");
      svg.appendChild(label);
    }
  });

  let areaD = `M ${xFor(0, n)} ${yFor(Y_MIN)} `;
  rows.forEach((r, i) => { areaD += `L ${xFor(i, n)} ${yFor(r.score)} `; });
  areaD += `L ${xFor(n - 1, n)} ${yFor(Y_MIN)} Z`;
  svg.appendChild(svgEl("path", { class: "score-area", d: areaD }));

  let lineD = "";
  rows.forEach((r, i) => { lineD += (i === 0 ? "M" : "L") + ` ${xFor(i, n)} ${yFor(r.score)} `; });
  svg.appendChild(svgEl("path", { class: "score-line", d: lineD }));

  const dots = rows.map((r, i) => {
    const dot = svgEl("circle", { class: "score-dot", cx: xFor(i, n), cy: yFor(r.score), r: 4 });
    svg.appendChild(dot);
    return dot;
  });

  const crosshair = svgEl("line", { class: "crosshair", y1: MARGIN.top, y2: MARGIN.top + PLOT_H });
  svg.appendChild(crosshair);

  const tooltip = document.getElementById("scoreTooltip");
  const hitArea = svgEl("rect", { class: "hit-area", x: MARGIN.left, y: MARGIN.top, width: PLOT_W, height: PLOT_H });
  svg.appendChild(hitArea);

  function showTooltip(i) {
    const r = rows[i];
    dots.forEach((dot, j) => dot.setAttribute("r", j === i ? 6 : 4));
    crosshair.setAttribute("x1", xFor(i, n));
    crosshair.setAttribute("x2", xFor(i, n));
    crosshair.style.opacity = 1;
    tooltip.innerHTML = `<div class="t-date">${r.date}</div><div class="t-score">${r.score} 点${r.note ? " — " + r.note : ""}</div>`;
    tooltip.style.opacity = 1;
    const rect = svg.getBoundingClientRect();
    const scaleX = rect.width / VB_W;
    tooltip.style.left = (rect.left + xFor(i, n) * scaleX + 12 + window.scrollX) + "px";
    tooltip.style.top = (rect.top + yFor(r.score) * scaleX - 36 + window.scrollY) + "px";
  }
  function hideTooltip() {
    dots.forEach((dot) => dot.setAttribute("r", 4));
    crosshair.style.opacity = 0;
    tooltip.style.opacity = 0;
  }

  hitArea.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = rect.width / VB_W;
    const mx = (e.clientX - rect.left) / scaleX;
    let closest = 0, minDist = Infinity;
    rows.forEach((r, i) => {
      const dist = Math.abs(xFor(i, n) - mx);
      if (dist < minDist) { minDist = dist; closest = i; }
    });
    showTooltip(closest);
  });
  hitArea.addEventListener("mouseleave", hideTooltip);
}

function renderStats(rows) {
  const scores = rows.map((r) => r.score);
  const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
  document.getElementById("statLatest").textContent = scores[scores.length - 1];
  document.getElementById("statAvg").textContent = avg;
  document.getElementById("statMax").textContent = Math.max(...scores);
  document.getElementById("statMin").textContent = Math.min(...scores);
}

async function load() {
  const svg = document.getElementById("scoreSvg");
  const emptyMsg = document.getElementById("emptyMsg");
  const summaryBar = document.querySelector(".summary-bar");

  try {
    const res = await fetch(SCORES_API, { cache: "no-store", headers: { "X-Scores-Credential": window.__credential || "" } });
    const items = res.ok ? await res.json() : [];
    const rows = items
      .filter((r) => typeof r.score === "number")
      .sort((a, b) => a.date.localeCompare(b.date));

    if (rows.length === 0) {
      emptyMsg.style.display = "block";
      summaryBar.style.display = "none";
      return;
    }

    drawChart(svg, rows);
    renderStats(rows);
  } catch (e) {
    emptyMsg.textContent = `読み込みエラー: ${e.message}`;
    emptyMsg.style.display = "block";
    summaryBar.style.display = "none";
  }
}

function onLoginSuccess() {
  load();
}

if (window.__loginState && window.__loginState.loggedIn) {
  onLoginSuccess();
} else {
  window.addEventListener("be-login-success", onLoginSuccess, { once: true });
}
