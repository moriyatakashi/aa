// cm/thread-logic.js — ba/bb共通のスレッド処理ロジック

import { CLASSIFICATIONS, findClassification } from "./utils.js";

// スレッド化: PartitionKey(threadId)でグルーピングし、id===threadIdの行を起点(new)とみなす
export function groupThreads(items) {
  const byThread = new Map();
  items.forEach((it) => {
    if (!byThread.has(it.threadId)) byThread.set(it.threadId, []);
    byThread.get(it.threadId).push(it);
  });

  const threads = [];
  byThread.forEach((entries, threadId) => {
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const root = entries.find((e) => e.id === threadId) || entries[0];
    const children = entries.filter((e) => e.id !== threadId);

    // 無効フラグはclaude視点/takashi視点の2視点で持つ。claudeはPC/スマホの2レーン
    // あるが視点としては1つに合算する(時系列で最新のvoid値が勝つ)。
    const voidView = {};
    const priorityByLane = {};
    let status = "open";
    let displayTitle = root.title;
    let titleCorrected = false;
    entries.forEach((e) => {
      if (e.type === "void" && e.by) voidView[e.by.startsWith("claude") ? "claude" : "takashi"] = !!e.value;
      if (e.type === "priority" && e.by) priorityByLane[e.by] = e.value;
      if (e.type === "status" && e.status) status = e.status;
      // タイトル訂正(有事用): titleを持つcorrectionが見出し表示だけを上書きする(最新優先)
      if (e.type === "correction" && e.title) { displayTitle = e.title; titleCorrected = true; }
    });

    // 分類(ba-32/ba-33): new/noteのtagsから予約語を拾い、時系列で最新を採用
    let cls = null;
    let clsVia = null;
    entries.forEach((e) => {
      if (e.type !== "new" && e.type !== "note") return;
      const found = findClassification(e.tags);
      if (found) { cls = found; clsVia = e.type; }
    });

    // 両視点そろって無効のときだけ既定で隠す
    const hiddenVoid = voidView.claude === true && voidView.takashi === true;

    threads.push({ threadId, root, children, entries, voidView, priorityByLane, status, displayTitle, titleCorrected, hiddenVoid, cls, clsVia });
  });

  threads.sort((a, b) => b.root.createdAt.localeCompare(a.root.createdAt));
  return threads;
}

// bb用: スレッド化と現在形の計算
export function projectThreads(items) {
  const byThread = new Map();
  items.forEach((it) => {
    if (!byThread.has(it.threadId)) byThread.set(it.threadId, []);
    byThread.get(it.threadId).push(it);
  });

  const threads = [];
  byThread.forEach((entries, threadId) => {
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const root = entries.find((e) => e.id === threadId) || entries[0];

    const voidView = {};
    let status = "open";
    let displayTitle = root.title;
    let cls = null;
    let latestText = null; // 現在形 = 最新の実質記述(new/note/correctionのbody)
    entries.forEach((e) => {
      if (e.type === "void" && e.by) voidView[e.by.startsWith("claude") ? "claude" : "takashi"] = !!e.value;
      if (e.type === "status" && e.status) status = e.status;
      if (e.type === "correction" && e.title) displayTitle = e.title;
      if (e.type === "new" || e.type === "note" || e.type === "correction") {
        const found = findClassification(e.tags);
        if (found) cls = found;
        if (e.body) latestText = e.body;
      }
    });

    const hiddenVoid = voidView.claude === true && voidView.takashi === true;
    const lastAt = entries[entries.length - 1].createdAt;
    threads.push({ threadId, root, status, displayTitle, cls, hiddenVoid, latestText, lastAt, count: entries.length });
  });

  threads.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return threads;
}

// エントリタイプのラベル生成
export function entryTypeLabel(e) {
  if (e.type === "void") return `void = ${e.value ? "true" : "false"}`;
  if (e.type === "status") return `status → ${e.status || ""}`;
  if (e.type === "priority") return `priority`;
  if (e.type === "verified_on_device") return `verified on device`;
  return e.type;
}
