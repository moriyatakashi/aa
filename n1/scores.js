// scores.js
// ロジック層: DOM操作は一切行わない、純粋関数のみ。
// Node.js標準テストランナー(node --test)でテスト可能。

// --- ダミーデータ(スタブ段階のテスト用) ---
export const dummyScoresEmpty = [];

export const dummyScoresOne = [
  { id: "s1", date: "2026-07-01", value: 80 },
];

export const dummyScoresThree = [
  { id: "s1", date: "2026-07-01", value: 80 },
  { id: "s2", date: "2026-07-03", value: 65 },
  { id: "s3", date: "2026-07-05", value: 92 },
];

// --- ロジック関数 ---

// スコア1件を表示用文字列にフォーマット
export function formatScore(score) {
  return score.value.toFixed(1);
}

// 日付の新しい順にソート(元配列は破壊しない)
export function sortScoresByDate(scores) {
  return [...scores].sort((a, b) => new Date(b.date) - new Date(a.date));
}

// 件数・平均値を集計。0件の場合はavgをnullにする
export function summarize(scores) {
  if (scores.length === 0) {
    return { count: 0, avg: null };
  }
  const total = scores.reduce((sum, s) => sum + s.value, 0);
  return { count: scores.length, avg: total / scores.length };
}
