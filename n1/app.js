// app.js — ab/src/main/m1(記録一覧)のロジックをaa向けに移植したもの。
// 画面側ログインゲートを通過した後にのみデータを取得・表示する(APIは無認証のまま)。
const API_BASE = "https://ab-board-api.azurewebsites.net/api";
const SCORES_API = `${API_BASE}/scores`;
const VISITS_API = `${API_BASE}/visits`;
const MEMOS_API  = `${API_BASE}/memos`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOW = ["日","月","火","水","木","金","土"];

function formatDate(s) {
  const [y, m, d] = s.split("-");
  const dow = DOW[new Date(s).getDay()];
  return { label: `${y}年${parseInt(m)}月${parseInt(d)}日`, dow };
}

async function load() {
  const loadStatus = document.getElementById("loadStatus");
  const listEl = document.getElementById("list");
  const emptyMsg = document.getElementById("emptyMsg");

  try {
    const [scoreRes, visitRes, memoRes] = await Promise.all([
      fetch(SCORES_API, { cache: "no-store" }),
      fetch(VISITS_API, { cache: "no-store" }),
      fetch(MEMOS_API, { cache: "no-store" })
    ]);
    const scoreRows = scoreRes.ok ? await scoreRes.json() : [];
    const visitRows = visitRes.ok ? await visitRes.json() : [];
    const memoRows = memoRes.ok ? await memoRes.json() : [];

    const memoMap = {};
    memoRows.forEach(data => {
      if (!data.date) return;
      if (!memoMap[data.date]) memoMap[data.date] = [];
      memoMap[data.date].push(data.memo);
    });

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

    const allDates = [...new Set([...Object.keys(scoreMap), ...Object.keys(visitMap), ...Object.keys(memoMap)])]
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
      const memos = memoMap[date] || [];

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
      memos.forEach(m => {
        addRow(`📝 ${m}`);
      });

      listEl.appendChild(card);
    });

    loadStatus.textContent = `${allDates.length} 日分`;
  } catch (e) {
    loadStatus.textContent = "エラー: " + e.message;
  }
}

window.addEventListener("n1-login-success", load, { once: true });
