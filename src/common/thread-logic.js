// common/thread-logic.js — ba/bb共通のスレッド処理ロジック

import { CLASSIFICATIONS, findClassification } from "./utils.js";

// ba-77: 承認キュー。proposeFor:"takashi"付きのエントリは、同じスレッド内に
// approvesIdが一致するtype:"approval"があれば承認済み、無ければ承認待ち。
// エントリ配列を直接書き換える(呼び出し側でsort済みの同じ配列をroot/childrenが参照するため)。
function applyApprovalFlags(entries) {
  const approvedIds = new Set(
    entries.filter((e) => e.type === "approval").map((e) => e.approvesId)
  );
  entries.forEach((e) => {
    if (e.proposeFor !== "takashi") return;
    e.approved = approvedIds.has(e.id);
    e.pendingApproval = !e.approved;
  });
}

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
    applyApprovalFlags(entries);
    const root = entries.find((e) => e.id === threadId) || entries[0];
    const children = entries.filter((e) => e.id !== threadId);

    // 無効フラグはclaude視点/takashi視点の2視点で持つ。claudeはPC/スマホの2レーン
    // あるが視点としては1つに合算する(時系列で最新のvoid値が勝つ)。
    const voidView = {};
    const priorityByLane = {};
    // react: 3レーン(takashi/claude-pc/claude-mobile)がそれぞれ独立に持つ軽い反応
    // (voidと違い集約せず、priorityByLaneと同じくレーンごとに個別表示するため)。
    // 判断根拠にはしない(意思決定はapproval)。
    const reactByLane = {};
    let status = "open";
    let displayTitle = root.title;
    let titleCorrected = false;
    // gist: 確定仕様スレッドの「今の結論」一言(200字以内)。correction/statusと同じ
    // 「追記のみ・最新が勝つ」。分類に関わらず無条件に計算し、確定仕様の時だけ意味を
    // 持つという制約は表示側(threadCardHtml)に任せる。
    let gist = null;
    // ba-162: 関連付け(link)。追記のみ・(このスレッド, relSeq)の組ごとに最新のvalueが勝つ
    // (voidと同じ「後勝ち」)。ここでは自スレッドが指す先(前方向)だけを集め、双方向化は
    // 全スレッド構築後の2パス目でまとめて行う。
    const linkValueBySeq = new Map();
    entries.forEach((e) => {
      if (e.type === "void" && e.by) voidView[e.by.startsWith("claude") ? "claude" : "takashi"] = !!e.value;
      if (e.type === "priority" && e.by) priorityByLane[e.by] = e.value;
      if (e.type === "react" && e.by) reactByLane[e.by] = !!e.value;
      if (e.type === "status" && e.status) status = e.status;
      // タイトル訂正(有事用): titleを持つcorrectionが見出し表示だけを上書きする(最新優先)
      if (e.type === "correction" && e.title) { displayTitle = e.title; titleCorrected = true; }
      if (e.type === "gist" && e.text) gist = e.text;
      if (e.type === "link" && Number.isInteger(e.relSeq)) linkValueBySeq.set(e.relSeq, e.value !== false);
    });
    const forwardRelSeqs = [...linkValueBySeq.entries()].filter(([, v]) => v).map(([seq]) => seq);

    // 分類(ba-32/ba-33): new/noteのtagsから予約語を拾い、時系列で最新を採用
    let cls = null;
    let clsVia = null;
    entries.forEach((e) => {
      if (e.type !== "new" && e.type !== "note") return;
      const found = findClassification(e.tags);
      if (found) { cls = found; clsVia = e.type; }
    });

    // 根なしスレッド(起点がnewでない=ref誤記事故等の産物)は、両視点の合意を待たず既定で隠す。
    // 正規コンテンツではなくバグの副産物のため、後始末の片方(claude/takashi)が漏れただけで
    // 永久に一覧へ残り続ける事態を避ける(ba-44/ba-9で実際に発生)。「無効スレッドも表示」で確認可能。
    const isRootless = root.type !== "new";
    // 両視点そろって無効のときも既定で隠す
    const hiddenVoid = isRootless || (voidView.claude === true && voidView.takashi === true);

    threads.push({ threadId, root, children, entries, voidView, priorityByLane, reactByLane, status, displayTitle, titleCorrected, gist, hiddenVoid, cls, clsVia, forwardRelSeqs });
  });

  // ba-162 projection: 双方向の関連付けとタイトルプレビューをここでまとめて計算する。
  // 表示(チップ/折り畳みUI/文言)はすま側の担当のため、ここではrelatedSeqs(相手seqの
  // 数値配列、双方向・重複排除・昇順)とseqTitle(seq→タイトル先頭10文字プレビュー)の
  // 2つのデータ形を用意するところまでに留める。
  const seqTitle = {};
  threads.forEach((t) => {
    if (Number.isInteger(t.root.seq)) seqTitle[t.root.seq] = (t.displayTitle || "").slice(0, 10);
  });
  const relatedBySeq = new Map();
  const addRelated = (seq, other) => {
    if (!relatedBySeq.has(seq)) relatedBySeq.set(seq, new Set());
    relatedBySeq.get(seq).add(other);
  };
  threads.forEach((t) => {
    if (!Number.isInteger(t.root.seq)) return;
    t.forwardRelSeqs.forEach((target) => {
      addRelated(t.root.seq, target);
      addRelated(target, t.root.seq);
    });
  });
  threads.forEach((t) => {
    const set = Number.isInteger(t.root.seq) ? relatedBySeq.get(t.root.seq) : null;
    t.relatedSeqs = set ? [...set].sort((a, b) => a - b) : [];
    delete t.forwardRelSeqs;
  });

  threads.sort((a, b) => b.root.createdAt.localeCompare(a.root.createdAt));
  threads.seqTitle = seqTitle;
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
    applyApprovalFlags(entries);
    const root = entries.find((e) => e.id === threadId) || entries[0];

    const voidView = {};
    let status = "open";
    let displayTitle = root.title;
    let cls = null;
    let gist = null; // 確定仕様の「今の結論」一言(ba側と同じ計算、gist型entryの最新text)
    let latestText = null; // 現在形 = 最新の実質記述(new/note/correctionのbody)
    entries.forEach((e) => {
      if (e.type === "void" && e.by) voidView[e.by.startsWith("claude") ? "claude" : "takashi"] = !!e.value;
      if (e.type === "status" && e.status) status = e.status;
      if (e.type === "correction" && e.title) displayTitle = e.title;
      if (e.type === "gist" && e.text) gist = e.text;
      if (e.type === "new" || e.type === "note" || e.type === "correction") {
        const found = findClassification(e.tags);
        if (found) cls = found;
        if (e.body) latestText = e.body;
      }
    });

    // ba側と同じ理由(ba-44/ba-9)で、根なしスレッドは既定で隠す
    const isRootless = root.type !== "new";
    const hiddenVoid = isRootless || (voidView.claude === true && voidView.takashi === true);
    const lastAt = entries[entries.length - 1].createdAt;
    threads.push({ threadId, root, status, displayTitle, cls, gist, hiddenVoid, latestText, lastAt, count: entries.length });
  });

  threads.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return threads;
}

// エントリタイプのラベル生成
export function entryTypeLabel(e) {
  if (e.type === "void") return `void = ${e.value ? "true" : "false"}`;
  if (e.type === "status") return `status → ${e.status || ""}`;
  if (e.type === "gist") return `gist → ${e.text || ""}`;
  if (e.type === "priority") return `priority`;
  if (e.type === "verified_on_device") return `verified on device`;
  if (e.type === "approval") return `approval`;
  return e.type;
}
