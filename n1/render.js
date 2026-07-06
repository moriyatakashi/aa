// render.js
// 描画層: scores.js のロジック関数を呼び出し、結果をDOMに反映するだけ。
// ここにはテストを書かない(ロジックはscores.js側でテスト済み)。

import {
  dummyScoresEmpty,
  dummyScoresOne,
  dummyScoresThree,
  sortScoresByDate,
  summarize,
  formatScore,
} from "./scores.js";

const datasets = {
  empty: dummyScoresEmpty,
  one: dummyScoresOne,
  three: dummyScoresThree,
};

function render(key) {
  const scores = sortScoresByDate(datasets[key]);
  const summary = summarize(scores);

  const summaryEl = document.getElementById("scores-summary");
  summaryEl.textContent =
    summary.count === 0
      ? "0件"
      : `${summary.count}件 / 平均 ${summary.avg.toFixed(1)}`;

  const listEl = document.getElementById("scores-list");
  listEl.innerHTML = "";
  scores.forEach((s) => {
    const li = document.createElement("li");
    li.textContent = `${s.date}: ${formatScore(s)}`;
    listEl.appendChild(li);
  });
}

document.querySelectorAll("[data-dataset]").forEach((btn) => {
  btn.addEventListener("click", () => render(btn.dataset.dataset));
});

// 初期表示は3件パターン
render("three");
