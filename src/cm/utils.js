// cm/utils.js — ba/bb共通のユーティリティ関数・定数

// ba-29: HTMLエスケープ
export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// n4-5対応: createdAtはUTC保存のためJSTへ明示変換して表示する
export function fmtTs(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const jst = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return jst.replace(",", "") + " JST";
}

// ba-32: tagの予約語4種による分類
export const CLASSIFICATIONS = ["案件", "確定仕様", "気づき", "保留論点"];
export const CLS_KEY = {
  "案件": "anken",
  "確定仕様": "shiyou",
  "気づき": "kizuki",
  "保留論点": "horyu"
};

// tagsから予約語を抽出
export function findClassification(tags) {
  const tagArray = Array.isArray(tags) ? tags : [];
  return tagArray.find((t) => CLASSIFICATIONS.includes(t)) || null;
}

// tagsから自由タグ(予約語以外)を抽出
export function filterFreeTags(tags) {
  const tagArray = Array.isArray(tags) ? tags : [];
  return tagArray.filter((t) => !CLASSIFICATIONS.includes(t));
}

// タグ文字列をパース(スペース・カンマ・読点で区切る)
export function parseTags(text) {
  return text
    .split(/[\s,、]+/)
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);
}
