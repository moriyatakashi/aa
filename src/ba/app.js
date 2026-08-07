// app.js — ba(n4後継の追記ログ)。1件=1つの出来事(new/note/correction/priority/status/void/...)を
// 追記していくだけの台帳を表示・操作する。過去の行は書き換えない(赤黒帳票方式)。
// 画面側ログインゲートを通過した後にのみデータを取得・表示する(GETもcredentialヘッダで認証)。
// config.jsを自分でimportする(ba-9追補)。HTML側の<script>読込に依存しないため、
// 旧index.htmlがキャッシュされた端末でも壊れない(2026-07-16の表示不具合の恒久対策)。
import "../common/config.js";
import { esc, fmtTs, CLASSIFICATIONS, CLS_KEY, BY_LABEL, parseTags, filterFreeTags, withCredential } from "../common/utils.js";
import { groupThreads, entryTypeLabel } from "../common/thread-logic.js";

const API_BASE = window.AA_API_BASE; // common/config.js から(ba-9)
const BA_API = `${API_BASE}/ba`;

const HUMAN_TYPES = ["note", "void", "status"];

function renderSummary(threads) {
  const openCount = threads.filter((t) => t.status === "open").length;
  const closedCount = threads.length - openCount;
  const allEntries = threads.flatMap((t) => t.entries);
  const latest = allEntries.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  document.getElementById("statTotal").textContent = threads.length;
  document.getElementById("statOpen").textContent = openCount;
  document.getElementById("statClosed").textContent = closedCount;
  document.getElementById("statLatestBy").textContent = latest ? latest.by : "—";
}

function entryRowHtml(e) {
  const voidClass = e.type === "void" ? (e.value ? " entry--void-true" : " entry--void-false") : "";
  const typeClass = e.type === "correction" ? " entry--correction" : e.type === "priority" ? " entry--priority" : e.type === "status" ? " entry--status" : e.type === "new" ? " entry--new" : e.type === "verified_on_device" ? " entry--verified" : "";
  // new/correctionのtitleはタイムライン上にも出す。訂正で見出しが変わっても、
  // 元のタイトルと訂正の経緯がスレッドを開けば読めるようにするため。
  const titleLine = e.title && (e.type === "new" || e.type === "correction")
    ? `<div class="entry-title">${e.type === "correction" ? "タイトル → " : ""}${esc(e.title)}</div>` : "";
  // ba-77: 承認キュー。proposeFor:"takashi"付きのエントリだけバッジ(+承認待ちならボタン)を出す。
  const approvalHtml = e.pendingApproval
    ? `<span class="approval-badge approval-badge--pending">takashi代筆・承認待ち</span><button type="button" class="btn-approve" data-approve-id="${esc(e.id)}">承認</button>`
    : e.approved
      ? `<span class="approval-badge approval-badge--approved">takashi代筆・承認済み</span>`
      : "";
  return `
    <div class="entry${voidClass || typeClass}">
      <div class="entry-rail"></div>
      <div>
        <div class="entry-head"><span class="entry-type">${entryTypeLabel(e)}</span><span>${fmtTs(e.createdAt)}</span><span>${esc(e.by)}</span>${approvalHtml}</div>
        ${titleLine}
        <div class="entry-body">${esc(e.body || e.reason || "")}</div>
      </div>
    </div>`;
}

// react: 3レーンそれぞれの軽い反応(参考程度、正式な承認・決定条件ではない)。
const REACT_LANES = ["claude-pc", "claude-mobile", "takashi"];
function reactRowHtml(reactByLane) {
  const chips = REACT_LANES.map((lane) => {
    const val = reactByLane[lane];
    return `<span class="react-chip${val ? " react-chip--on" : ""}">${esc(BY_LABEL[lane] || lane)}${val ? "✓" : ""}</span>`;
  }).join("");
  return `<div class="react-row"><span class="react-label" title="参考程度の反応であり、正式な承認・決定条件ではない">反応:</span>${chips}</div>`;
}

function perspectiveRowHtml(voidView) {
  const c = voidView.claude;
  const t = voidView.takashi;
  if (c === undefined && t === undefined) return "";
  const chip = (val, label) =>
    val === undefined
      ? ""
      : `<span class="perspective-chip ${val ? "perspective-chip--void" : "perspective-chip--active"}">${label}: ${val ? "無効" : "有効"}</span>`;
  return `<div class="perspective-row"><span class="perspective-label">無効フラグ:</span>${chip(c, "C")}${chip(t, "T")}</div>`;
}

// ba-162: 関連番号(link)のチップ行。seqTitleは groupThreads が返す配列に生えている
// threads.seqTitle(seq→タイトル先頭10文字)を渡す想定。
function relatedRowHtml(relatedSeqs, seqTitle) {
  if (!relatedSeqs || !relatedSeqs.length) return "";
  const chips = relatedSeqs
    .map((seq) => {
      const preview = (seqTitle && seqTitle[seq]) || "";
      return `<button type="button" class="related-chip" data-jump-seq="${seq}">ba-${seq}${preview ? " " + esc(preview) : ""}</button>`;
    })
    .join("");
  return `<div class="related-row"><span class="related-label">関連:</span>${chips}</div>`;
}

function threadCardHtml(thread, seqTitle, autoExpand) {
  const { threadId, root, children, status } = thread;
  const title = thread.displayTitle || root.body || "(無題)";
  const tags = Array.isArray(root.tags) ? root.tags : [];
  // 分類はバッジで出すため、自由タグ列からは除外して二重表示を避ける(ba-33)。
  const tagsHtml = filterFreeTags(tags).map((t) => `<span class="tag">#${esc(t)}</span>`).join("");
  const ghHtml = root.github_issue ? `<span class="gh-chip">gh #${esc(root.github_issue)}</span>` : "";
  // 分類バッジ(ba-33)。note由来の分類は来歴として小さく「note」を添える(赤黒帳票の思想)。
  const clsHtml = thread.cls
    ? `<span class="cls-badge cls-badge--${CLS_KEY[thread.cls]}">${thread.cls}${thread.clsVia === "note" ? '<span class="cls-via">note</span>' : ""}</span>`
    : "";
  const isOpen = status === "open";
  // 表示件数が多いときはautoExpand=falseにして、openスレッドも既定でたたんでおく(手動で開ける)。
  const expand = isOpen && autoExpand;
  const takashiVoid = thread.voidView.takashi;
  const takashiReact = thread.reactByLane.takashi;

  return `
    <details class="thread-card${thread.hiddenVoid ? " thread-card--void" : ""}" data-thread-id="${threadId}" data-seq="${root.seq || ""}" ${expand ? "open" : ""}>
      <summary>
        <div class="thread-top-row">
          <span class="chevron">▶</span>
          ${root.seq ? `<span class="seq-chip">ba-${root.seq}</span>` : ""}
          <span class="pill ${isOpen ? "pill-open" : "pill-closed"}">${isOpen ? "open" : "closed"}</span>
          ${clsHtml}
          <span class="thread-title">${esc(title)}</span>
          ${thread.titleCorrected ? `<span class="title-corrected-chip">タイトル訂正済</span>` : ""}
        </div>
        ${thread.gist ? `<div class="thread-gist">${esc(thread.gist)}</div>` : ""}
        <div class="meta-row">${tagsHtml}${ghHtml}</div>
        ${relatedRowHtml(thread.relatedSeqs, seqTitle)}
        ${perspectiveRowHtml(thread.voidView)}
        ${reactRowHtml(thread.reactByLane)}
      </summary>
      <div class="thread-timeline">
        ${entryRowHtml(root)}
        ${children.map(entryRowHtml).join("")}
        <div class="lane-form">
          <span class="lane-form-label">人間レーンから追記</span>
          <div class="lane-form-row">
            <input type="text" class="note-input" placeholder="ひとこと">
            <button type="button" class="btn-add-note">追加</button>
          </div>
          <div class="lane-form-row" style="margin-top:6px;">
            <button type="button" class="btn-toggle-void">${takashiVoid ? "有効に戻す(T)" : "無効にする(T)"}</button>
            <button type="button" class="btn-toggle-status">${isOpen ? "クローズ" : "再オープン"}</button>
            <button type="button" class="btn-toggle-react">${takashiReact ? "反応を取り消す" : "反応する"}</button>
          </div>
          <div class="lane-form-row" style="margin-top:6px;">
            <select class="reclass-select">
              <option value="" selected disabled>分類を変更…</option>
              ${CLASSIFICATIONS.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
            </select>
            <button type="button" class="btn-reclassify">変更</button>
          </div>
          <div class="lane-form-row" style="margin-top:6px;">
            <input type="text" class="title-fix-input" value="${esc(title)}">
            <button type="button" class="btn-fix-title">タイトルを直す</button>
          </div>
          <div class="lane-form-hint">使える種別: note / void / status / react / 分類変更 / タイトル訂正(id・時刻・by は自動)</div>
        </div>
      </div>
    </details>`;
}

async function postEntry(body) {
  const res = await fetch(BA_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withCredential(body)),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function attachThreadHandlers(container, thread) {
  const card = container.querySelector(`[data-thread-id="${thread.threadId}"]`);
  if (!card) return;

  const noteInput = card.querySelector(".note-input");
  card.querySelector(".btn-add-note").addEventListener("click", async () => {
    const body = noteInput.value.trim();
    if (!body) return;
    try {
      await postEntry({ ref: thread.threadId, type: "note", body });
      noteInput.value = "";
      load();
    } catch (e) {
      alert("追記に失敗しました: " + e.message);
    }
  });

  card.querySelector(".btn-toggle-void").addEventListener("click", async () => {
    try {
      await postEntry({ ref: thread.threadId, type: "void", value: !thread.voidView.takashi });
      load();
    } catch (e) {
      alert("無効フラグの切り替えに失敗しました: " + e.message);
    }
  });

  card.querySelector(".btn-toggle-status").addEventListener("click", async () => {
    try {
      await postEntry({ ref: thread.threadId, type: "status", status: thread.status === "open" ? "closed" : "open" });
      load();
    } catch (e) {
      alert("ステータス変更に失敗しました: " + e.message);
    }
  });

  card.querySelector(".btn-toggle-react").addEventListener("click", async () => {
    try {
      await postEntry({ ref: thread.threadId, type: "react", value: !thread.reactByLane.takashi });
      load();
    } catch (e) {
      alert("反応の切り替えに失敗しました: " + e.message);
    }
  });

  // ba-130: 分類はnew投稿時にしか選べなかった問題への対応。noteにtagsを載せて追記し、
  // thread-logic.jsのfindClassification(new/noteのtagsを時系列で見て最新優先)に乗せる。
  const reclassSelect = card.querySelector(".reclass-select");
  card.querySelector(".btn-reclassify").addEventListener("click", async () => {
    const value = reclassSelect.value;
    if (!value) return;
    try {
      await postEntry({ ref: thread.threadId, type: "note", tags: [value] });
      load();
    } catch (e) {
      alert("分類の変更に失敗しました: " + e.message);
    }
  });

  // タイトル訂正。追記オンリーの制約上、直接書き換えではなくtitle付きcorrectionを
  // 積む(thread-logic.jsのdisplayTitle解決が最新のcorrectionを優先する)。
  // 元のnewエントリのtitleは変わらず残るため、付け直しの履歴もタイムラインに残る。
  const titleFixInput = card.querySelector(".title-fix-input");
  card.querySelector(".btn-fix-title").addEventListener("click", async () => {
    const newTitle = titleFixInput.value.trim();
    if (!newTitle || newTitle === (thread.displayTitle || "")) return;
    try {
      await postEntry({ ref: thread.threadId, type: "correction", title: newTitle });
      load();
    } catch (e) {
      alert("タイトルの訂正に失敗しました: " + e.message);
    }
  });

  // ba-77: 承認キュー。1スレッドに承認待ちが複数あり得るため全ボタンに付ける。
  card.querySelectorAll(".btn-approve").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await postEntry({ ref: thread.threadId, type: "approval", approvesId: btn.dataset.approveId });
        load();
      } catch (e) {
        alert("承認に失敗しました: " + e.message);
      }
    });
  });
}

// 両視点そろって無効のスレッドは既定で一覧から隠す。トグルONのときだけ薄色で表示する。
let showVoided = false;
// ba-33: 既定はopenのみ表示。確定仕様はcloseしない規約(ba-32)なので参照の邪魔にならない。
let showClosed = false;
// ba-33: 分類フィルタ(単一選択)。"all"は分類なしスレッドも含めて表示。
let filterCls = "all";
// 検索ボックスの現在値。数字ならジャンプ、それ以外ならタグ抽出に使う(空なら絞り込みなし)。
let searchQuery = "";
let cachedThreads = [];

// 表示中のカード数がこれを超えたら、openスレッドも既定でたたむ(1件ずつクリックで開ける)。
// 少数なら今まで通り中身が見えたほうが便利なので、閾値以下は自動展開のまま。
const AUTO_EXPAND_MAX = 6;

// "50" "ba-50" "#50" のような数字入力を判定する。マッチすれば番号部分(文字列)を返す(なければnull)。
function parseSeqInput(q) {
  const m = q.trim().match(/^(?:ba-|#)?(\d+)$/i);
  return m ? m[1] : null;
}

// 指定seqのスレッドへジャンプする。絞り込みで隠れていても辿り着けるよう、
// void/closed/分類/検索をすべて解除してから開いてスクロールする(ba-162の関連チップと同じ動き)。
function jumpToSeq(seq) {
  showVoided = true;
  showClosed = true;
  filterCls = "all";
  searchQuery = "";
  const searchEl = document.getElementById("baSearch");
  if (searchEl) searchEl.value = "";
  render();
  const target = document.querySelector(`[data-seq="${seq}"]`);
  if (target) {
    target.open = true;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// タグのみで絞り込む(タイトル・本文は見ない)。分類変更のnote(ba-130)で乗ったタグも拾うため、
// rootだけでなく全エントリのtagsを見る。大文字小文字は無視、部分一致。
function threadMatchesTag(thread, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const allTags = (thread.entries || []).flatMap((e) => (Array.isArray(e.tags) ? e.tags : []));
  return allTags.some((t) => String(t).toLowerCase().includes(needle));
}

function render() {
  const listEl = document.getElementById("threadList");
  const hiddenCount = cachedThreads.filter((t) => t.hiddenVoid).length;
  const closedCount = cachedThreads.filter((t) => t.status !== "open").length;
  const searching = searchQuery.trim() !== "";
  let visible = showVoided ? cachedThreads : cachedThreads.filter((t) => !t.hiddenVoid);
  // タグ抽出中はclosedも対象にする(過去の案件をタグで辿れるように)。
  if (!showClosed && !searching) visible = visible.filter((t) => t.status === "open");
  if (filterCls !== "all") visible = visible.filter((t) => t.cls === filterCls);
  if (searching) visible = visible.filter((t) => threadMatchesTag(t, searchQuery));

  renderSummary(cachedThreads);
  renderClsFilter();

  const toggleEl = document.getElementById("btnToggleVoid");
  toggleEl.style.display = hiddenCount ? "" : "none";
  toggleEl.textContent = showVoided ? `無効スレッドを隠す(${hiddenCount})` : `無効スレッドも表示(${hiddenCount})`;

  const closedEl = document.getElementById("btnToggleClosed");
  closedEl.textContent = showClosed ? `closedを隠す(${closedCount})` : `closedも表示(${closedCount})`;

  // ③タグ抽出中(②)だけリセットボタンを出す。
  const resetEl = document.getElementById("btnSearchReset");
  if (resetEl) resetEl.style.display = searching ? "" : "none";

  const emptyMsg = searching
    ? `<p class="empty">タグ「${esc(searchQuery.trim())}」に一致するスレッドはありません</p>`
    : `<p class="empty">表示できるスレッドがありません(分類フィルタと「closedも表示」を確認)</p>`;
  // 表示件数がAUTO_EXPAND_MAXを超えたら、openスレッドも既定でたたんで一覧を見渡しやすくする。
  const autoExpand = visible.length <= AUTO_EXPAND_MAX;
  listEl.innerHTML = visible.map((t) => threadCardHtml(t, cachedThreads.seqTitle, autoExpand)).join("") || emptyMsg;
  visible.forEach((t) => attachThreadHandlers(listEl, t));
}

// ba-33: 分類フィルタのチップ(単一選択+件数)。分類なしスレッドは「すべて」でのみ表示される。
function renderClsFilter() {
  const el = document.getElementById("clsFilter");
  if (!el) return;
  const count = (c) => cachedThreads.filter((t) => t.cls === c).length;
  const chip = (value, label, n) =>
    `<button type="button" class="cls-chip${filterCls === value ? " cls-chip--on" : ""}${value !== "all" ? ` cls-chip--${CLS_KEY[value]}` : ""}" data-cls="${value}">${label}<span class="cls-cnt">[${n}]</span></button>`;
  el.innerHTML = chip("all", "すべて", cachedThreads.length) + CLASSIFICATIONS.map((c) => chip(c, c, count(c))).join("");
}

async function load() {
  const listEl = document.getElementById("threadList");
  try {
    const res = await fetch(BA_API, { cache: "no-store" }); // GET認証は2026-07-15に廃止済み(ba-35)。無意味だった旧ヘッダーを削除
    // 失敗ステータスを黙って空一覧にしない(2026-07-16の不具合でエラーが不可視だった教訓)
    if (!res.ok) throw new Error(`status=${res.status}`);
    const items = await res.json();
    cachedThreads = groupThreads(items);
    render();
  } catch (e) {
    listEl.innerHTML = `<p class="empty">読み込みエラー: ${e.message}</p>`;
  }
}

function initNewEntryForm() {
  const elTitle = document.getElementById("newTitle");
  const elTags = document.getElementById("newTags");
  const elBody = document.getElementById("newBody");
  const elJson = document.getElementById("newJson");
  const elSubmit = document.getElementById("btnAddThread");

  elSubmit.addEventListener("click", async () => {
    try {
      let payload;
      if (elJson.value.trim()) {
        const parsed = JSON.parse(elJson.value);
        payload = { type: "new", title: parsed.title, tags: parsed.tags, body: parsed.body };
      } else {
        const title = elTitle.value.trim();
        if (!title) { elTitle.focus(); return; }
        payload = { type: "new", title, tags: parseTags(elTags.value), body: elBody.value.trim() };
      }
      // ba-32/ba-33: 分類を必ずtagsに含める(JSON貼り付け側に既に分類があればそれを尊重)。
      const curTags = Array.isArray(payload.tags) ? payload.tags : [];
      if (!curTags.some((t) => CLASSIFICATIONS.includes(t))) {
        const clsEl = document.querySelector('input[name="newCls"]:checked');
        if (clsEl) payload.tags = [clsEl.value, ...curTags];
      }
      await postEntry(payload);
      elTitle.value = "";
      elTags.value = "";
      elBody.value = "";
      elJson.value = "";
      load();
    } catch (e) {
      alert("新規スレッドの追加に失敗しました: " + e.message);
    }
  });
}

// issue #8対応(案B)の踏襲: auth.jsの実行順は変えず、起動時にwindow.__loginStateを直接チェックする。
function onLoginSuccess() {
  initNewEntryForm();
  document.getElementById("btnToggleVoid").addEventListener("click", () => {
    showVoided = !showVoided;
    render();
  });
  document.getElementById("btnToggleClosed").addEventListener("click", () => {
    showClosed = !showClosed;
    render();
  });
  document.getElementById("clsFilter").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".cls-chip");
    if (!btn) return;
    filterCls = btn.dataset.cls;
    render();
  });
  const searchEl = document.getElementById("baSearch");
  const searchResetEl = document.getElementById("btnSearchReset");
  if (searchEl) {
    // ②数字以外はタグ絞り込みを都度適用。数字入力中(ジャンプ待ち)はタグ絞り込みをかけない。
    searchEl.addEventListener("input", (ev) => {
      const val = ev.target.value;
      if (parseSeqInput(val) !== null) {
        if (searchQuery !== "") { searchQuery = ""; render(); }
        return;
      }
      searchQuery = val;
      render();
    });
    // ①番号+Enterでジャンプ。
    searchEl.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      const seq = parseSeqInput(ev.target.value);
      if (seq !== null) {
        ev.preventDefault();
        jumpToSeq(seq);
      }
    });
  }
  // ③タグ絞り込み(②)のリセットボタン。
  if (searchResetEl) {
    searchResetEl.addEventListener("click", () => {
      searchQuery = "";
      if (searchEl) searchEl.value = "";
      render();
    });
  }
  // ba-162: 関連チップのジャンプも同じ経路(jumpToSeq)に統一。
  document.getElementById("threadList").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".related-chip");
    if (!btn) return;
    jumpToSeq(btn.dataset.jumpSeq);
  });
  load();
}

if (window.__loginState && window.__loginState.loggedIn) {
  onLoginSuccess();
} else {
  window.addEventListener("ba-login-success", onLoginSuccess, { once: true });
}
