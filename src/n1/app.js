// app.js — ab/src/main/m1(記録一覧)のロジックをaa向けに移植したもの。
// 画面側ログインゲートを通過した後にのみデータを取得・表示する。GETもcredentialヘッダで認証する(ba-16)。
// config.jsを自分でimportする(ba-9追補)。HTML側の<script>読込に依存しないため、
// 旧index.htmlがキャッシュされた端末でも壊れない(2026-07-16の表示不具合の恒久対策)。
import "../common/config.js";
import { todayStr, withCredential } from "../common/utils.js";
const API_BASE = window.AA_API_BASE; // common/config.js から(ba-9)
const SCORES_API = `${API_BASE}/scores`;
const VISITS_API = `${API_BASE}/visits`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOW = ["日","月","火","水","木","金","土"];

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

async function load() {
  const loadStatus = document.getElementById("loadStatus");
  const listEl = document.getElementById("list");
  const emptyMsg = document.getElementById("emptyMsg");
  listEl.innerHTML = "";
  emptyMsg.style.display = "none";

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
  load();
}

if (window.__loginState && window.__loginState.loggedIn) {
  onLoginSuccess();
} else {
  window.addEventListener("n1-login-success", onLoginSuccess, { once: true });
}
