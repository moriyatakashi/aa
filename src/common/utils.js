// common/utils.js — ba/bb共通のユーティリティ関数・定数

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

// ba-32: tagの予約語による分類。「旧仕様」はba-32の語彙追加(ba-16の見直しで新設、
// 確定仕様だったが対象システム消滅/後継スレッドへの委譲で現役でなくなったもの用)。
// 「記録」はba-181(第2版ドラフト、2026-07-30)で追加。活動側(気づき/案件/保留論点、
// いつか閉じる) × 参照側(確定仕様/旧仕様/記録、閉じずに残る)の2軸モデルにおける、
// 「ただの情報(独り言・報告・解説など"だから次こうする"が無いもの)」の置き場。
// まだ確定仕様(ba-32の後継として)には昇格していない試運転中の分類だが、
// 分類の予約語自体はここで先に6つに拡張しておく(ba-181残タスク)。
export const CLASSIFICATIONS = ["案件", "確定仕様", "気づき", "保留論点", "旧仕様", "記録"];
export const CLS_KEY = {
  "案件": "anken",
  "確定仕様": "shiyou",
  "気づき": "kizuki",
  "保留論点": "horyu",
  "旧仕様": "kyuushiyou",
  "記録": "kiroku"
};

// by(claude-pc/claude-mobile/takashi)の表示名。react等、誰の反応かを画面に出す時に使う。
export const BY_LABEL = { "claude-pc": "利尻", "claude-mobile": "すまさん", "takashi": "takashi" };

// tagsから予約語を抽出
export function findClassification(tags) {
  const tagArray = Array.isArray(tags) ? tags : [];
  return tagArray.find((t) => CLASSIFICATIONS.includes(t)) || null;
}

// n1/n2共通: 今日の日付をYYYY-MM-DD形式で返す
export function todayStr() {
  return new Date().toLocaleDateString("sv-SE");
}

// ba/n1/n2共通: POST bodyに認証情報(auth.jsがwindow.__credentialへ格納)を付与する
export function withCredential(body = {}) {
  return { ...body, credential: window.__credential };
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
