// app.js — ab/src/main/m1(記録一覧)のロジックをaa向けに移植したもの。
// 画面側ログインゲートを通過した後にのみデータを取得・表示する。GETもcredentialヘッダで認証する(ba-16)。
// config.jsを自分でimportする(ba-9追補)。HTML側の<script>読込に依存しないため、
// 旧index.htmlがキャッシュされた端末でも壊れない(2026-07-16の表示不具合の恒久対策)。
import "../common/config.js";
import { todayStr, withCredential } from "../common/utils.js";
const API_BASE = window.AA_API_BASE; // common/config.js から(ba-9)
const SCORES_API = `${API_BASE}/scores`;
const VISITS_API = `${API_BASE}/visits`;
const POINTS_API = `${API_BASE}/points`;
const SCORE_EVENTS_API = `${API_BASE}/score-events`;
const STREAK_CHECKS_API = `${API_BASE}/streak-checks`;
const SCORING_RULES_API = `${API_BASE}/scoring-rules`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOW = ["日","月","火","水","木","金","土"];

// be(スコア推移グラフ)統合分(2026-07-29): n1が既に持つscoreMapを描画するだけで、
// 独自fetchは持たない。k2のページ構造・ログイン待ちパターンを踏襲していた元コードのまま移植。
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

function formatDate(s) {
  const [y, m, d] = s.split("-");
  const dow = DOW[new Date(s).getDay()];
  return { label: `${y}年${parseInt(m)}月${parseInt(d)}日`, dow };
}

// スコア入力(ab/src/main/n1のスコア機能を移植)
function initScoreInput() {
  const today = todayStr();
  const elScoreDate = document.getElementById("scoreDate");
  const elSlider = document.getElementById("slider");
  const elScoreNum = document.getElementById("scoreNum");
  const elNoteInput = document.getElementById("noteInput");
  const elBtnSaveScore = document.getElementById("btnSaveScore");
  const elScoreSaved = document.getElementById("scoreSaved");

  elScoreDate.textContent = today;

  function setScore(val) {
    const v = Math.min(100, Math.max(0, Number(val)));
    elSlider.value = v;
    elScoreNum.textContent = v;
  }

  elSlider.addEventListener("input", () => {
    elScoreNum.textContent = elSlider.value;
  });

  async function loadTodayScore() {
    try {
      const res = await fetch(`${SCORES_API}/${today}`, { cache: "no-store", headers: { "X-Scores-Credential": window.__credential || "" } });
      const data = res.ok ? await res.json() : null;
      if (data) {
        setScore(data.score);
        elNoteInput.value = data.note || "";
        elBtnSaveScore.textContent = "更新";
      } else {
        setScore(80);
        elBtnSaveScore.textContent = "保存";
      }
    } catch (e) {
      setScore(80);
    }
  }

  elBtnSaveScore.addEventListener("click", async () => {
    // ba-35残課題(2): 公開閲覧モードでは未ログインでも閲覧できるため、書き込み時に
    // credentialの有無を確認し、無ければ通信(401)ではなくログインへ誘導する。
    if (!window.__credential) {
      elScoreSaved.textContent = "保存にはログインが必要です";
      if (window.aaShowLoginGate) window.aaShowLoginGate();
      return;
    }
    const score = Number(elSlider.value);
    const note = elNoteInput.value.trim();
    try {
      const res = await fetch(`${SCORES_API}/${today}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withCredential({ score, note })),
      });
      if (!res.ok) { elScoreSaved.textContent = "エラー: 保存に失敗しました"; return; }
      elBtnSaveScore.textContent = "更新";
      elScoreSaved.textContent = "✓ 保存しました";
      setTimeout(() => elScoreSaved.textContent = "", 2000);
      load();
    } catch (e) {
      elScoreSaved.textContent = "エラー: " + e.message;
    }
  });

  loadTodayScore();
}

// ba-165①(2026-07-29): 加点軸を固定選択肢化。GET /score-eventsのカタログをプルダウンに
// 反映し、「その他」選択時だけ自由入力欄(軸の名前)を出す。点数は引き続き自己申告のまま
// (difficultyから機械的に決め打ちしない)。
async function initPointInput() {
  const elAxis = document.getElementById("pointAxis");
  const elAxisLabel = document.getElementById("pointAxisLabel");
  const elValue = document.getElementById("pointValue");
  const elNote = document.getElementById("pointNote");
  const elBtn = document.getElementById("btnSavePoint");
  const elSaved = document.getElementById("pointSaved");

  try {
    const res = await fetch(SCORE_EVENTS_API, { cache: "no-store" });
    const data = res.ok ? await res.json() : { catalog: [] };
    (data.catalog || []).forEach(item => {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = `${item.label}(${item.cat}/${item.period === "month" ? "月次" : "週次"}/${item.difficulty})`;
      elAxis.appendChild(opt);
    });
    const otherOpt = document.createElement("option");
    otherOpt.value = "other";
    otherOpt.textContent = "その他(自由入力)";
    elAxis.appendChild(otherOpt);
  } catch (e) {
    elSaved.textContent = "カタログ取得エラー: " + e.message;
  }

  elAxis.addEventListener("change", () => {
    elAxisLabel.style.display = elAxis.value === "other" ? "" : "none";
  });

  elBtn.addEventListener("click", async () => {
    if (!window.__credential) {
      elSaved.textContent = "記録にはログインが必要です";
      if (window.aaShowLoginGate) window.aaShowLoginGate();
      return;
    }
    const axis = elAxis.value;
    const points = Number(elValue.value);
    if (!axis) { elSaved.textContent = "軸を選択してください"; return; }
    if (axis === "other" && !elAxisLabel.value.trim()) { elSaved.textContent = "その他の軸名を入力してください"; return; }
    if (!Number.isInteger(points)) { elSaved.textContent = "点数は整数で入力してください"; return; }
    try {
      const res = await fetch(POINTS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withCredential({
          axis, points, note: elNote.value.trim(),
          axisLabel: axis === "other" ? elAxisLabel.value.trim() : undefined,
        })),
      });
      if (!res.ok) { elSaved.textContent = "エラー: 記録に失敗しました"; return; }
      elAxis.value = "";
      elAxisLabel.value = "";
      elAxisLabel.style.display = "none";
      elValue.value = "";
      elNote.value = "";
      elSaved.textContent = "✓ 記録しました";
      setTimeout(() => elSaved.textContent = "", 2000);
    } catch (e) {
      elSaved.textContent = "エラー: " + e.message;
    }
  });
}

// ba-165④(2026-07-29): streak(連続作業)チェックイン。同じ作業名を毎日押すだけで、
// サーバー側が連続日数を数えて5日ごとに自動加点する(週1回まで)。
function initStreakInput() {
  const elTask = document.getElementById("streakTask");
  const elDate = document.getElementById("streakDate");
  const elBtn = document.getElementById("btnStreakCheck");
  const elSaved = document.getElementById("streakSaved");

  elDate.value = todayStr();

  elBtn.addEventListener("click", async () => {
    if (!window.__credential) {
      elSaved.textContent = "記録にはログインが必要です";
      if (window.aaShowLoginGate) window.aaShowLoginGate();
      return;
    }
    const task = elTask.value.trim();
    if (!task) { elSaved.textContent = "作業名を入力してください"; return; }
    try {
      const res = await fetch(STREAK_CHECKS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withCredential({ task, date: elDate.value })),
      });
      if (!res.ok) { elSaved.textContent = "エラー: 記録に失敗しました"; return; }
      const data = await res.json();
      elSaved.textContent = data.awarded
        ? `✓ ${data.streakLength}日連続達成、加点しました`
        : `✓ 記録しました(${data.streakLength}日連続)`;
      setTimeout(() => elSaved.textContent = "", 3000);
    } catch (e) {
      elSaved.textContent = "エラー: " + e.message;
    }
  });
}

// ba-159: イカサマ対策(基準ずらし記録)。クローズ配点(low/normal/high)の変更は
// 頻度が低い前提なので、専用UIは作らず素朴な3つの数値入力+発効日+理由だけにする。
function initRuleInput() {
  const elLow = document.getElementById("rulePointsLow");
  const elNormal = document.getElementById("rulePointsNormal");
  const elHigh = document.getElementById("rulePointsHigh");
  const elEffectiveFrom = document.getElementById("ruleEffectiveFrom");
  const elNote = document.getElementById("ruleNote");
  const elBtn = document.getElementById("btnSaveRule");
  const elSaved = document.getElementById("ruleSaved");

  elBtn.addEventListener("click", async () => {
    if (!window.__credential) {
      elSaved.textContent = "変更にはログインが必要です";
      if (window.aaShowLoginGate) window.aaShowLoginGate();
      return;
    }
    const low = Number(elLow.value), normal = Number(elNormal.value), high = Number(elHigh.value);
    if (![low, normal, high].every(Number.isInteger)) {
      elSaved.textContent = "low/normal/highはすべて整数で入力してください";
      return;
    }
    try {
      const res = await fetch(SCORING_RULES_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withCredential({
          difficultyPoints: { low, normal, high },
          effectiveFrom: elEffectiveFrom.value || undefined,
          note: elNote.value.trim(),
        })),
      });
      if (!res.ok) { elSaved.textContent = "エラー: 変更に失敗しました"; return; }
      elEffectiveFrom.value = "";
      elNote.value = "";
      elSaved.textContent = "✓ 新しいルールを追加しました";
      setTimeout(() => elSaved.textContent = "", 2000);
    } catch (e) {
      elSaved.textContent = "エラー: " + e.message;
    }
  });
}

async function load() {
  const loadStatus = document.getElementById("loadStatus");
  const listEl = document.getElementById("list");
  const emptyMsg = document.getElementById("emptyMsg");
  const chartSection = document.getElementById("scoreChartSection");
  listEl.innerHTML = "";
  emptyMsg.style.display = "none";
  chartSection.style.display = "none";

  try {
    const [scoreRes, visitRes] = await Promise.all([
      fetch(SCORES_API, { cache: "no-store", headers: { "X-Scores-Credential": window.__credential || "" } }),
      fetch(VISITS_API, { cache: "no-store", headers: { "X-Visits-Credential": window.__credential || "" } })
    ]);
    const scoreRows = scoreRes.ok ? await scoreRes.json() : [];
    const visitRows = visitRes.ok ? await visitRes.json() : [];

    const scoreMap = {};
    scoreRows.forEach(r => {
      if (DATE_RE.test(r.date) && typeof r.score === "number") {
        scoreMap[r.date] = { score: r.score, note: r.note || "" };
      }
    });

    const chartRows = Object.entries(scoreMap)
      .map(([date, v]) => ({ date, score: v.score, note: v.note }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (chartRows.length > 0) {
      chartSection.style.display = "block";
      drawChart(document.getElementById("scoreSvg"), chartRows);
      renderStats(chartRows);
    }

    const visitMap = {};
    visitRows.forEach(d => {
      if (!d.date) return;
      if (!visitMap[d.date]) visitMap[d.date] = [];
      visitMap[d.date].push({ place: d.place || "—", time: d.time || "", memo: d.memo || "" });
    });

    const allDates = [...new Set([...Object.keys(scoreMap), ...Object.keys(visitMap)])]
      .sort((a, b) => b.localeCompare(a));

    if (allDates.length === 0) {
      emptyMsg.style.display = "block";
      loadStatus.textContent = "記録なし";
      return;
    }

    allDates.forEach(date => {
      const { label, dow } = formatDate(date);
      const score = scoreMap[date];
      const visits = (visitMap[date] || []).slice().sort((a, b) => a.time.localeCompare(b.time));

      const card = document.createElement("div");
      card.className = "day-card";

      const dateRow = document.createElement("div");
      dateRow.className = "day-date";
      dateRow.textContent = `${label}(${dow}曜)`;
      card.appendChild(dateRow);

      function addRow(text) {
        const row = document.createElement("div");
        row.className = "row";
        row.textContent = text;
        card.appendChild(row);
      }

      if (score) {
        addRow(`スコア: ${score.score}${score.note ? " — " + score.note : ""}`);
      }
      visits.forEach(v => {
        addRow(`📍 ${v.place}${v.time ? " " + v.time : ""}${v.memo ? " — " + v.memo : ""}`);
      });

      listEl.appendChild(card);
    });

    loadStatus.textContent = `${allDates.length} 日分`;
  } catch (e) {
    loadStatus.textContent = "エラー: " + e.message;
  }
}

// issue #8対応(案B): auth.jsの実行順は変えず、起動時にwindow.__loginStateを直接チェックする。
// auth.js(通常script)はHTML解析中に同期実行されるため、このモジュール(type="module"でdefer)が
// 動く時点では既にwindow.__loginStateがセット済みの可能性がある。その場合はイベントを待たずに即実行し、
// まだ未ログインならこれまで通りn1-login-successイベントを待つ(通常のログインボタン操作に対応)。
function onLoginSuccess() {
  initScoreInput();
  initPointInput();
  initStreakInput();
  initRuleInput();
  load();
}

if (window.__loginState && window.__loginState.loggedIn) {
  onLoginSuccess();
} else {
  window.addEventListener("n1-login-success", onLoginSuccess, { once: true });
}
