// app.js — ba(n4後継の追記ログ)。1件=1つの出来事(new/note/correction/priority/status/void/...)を
// 追記していくだけの台帳を表示・操作する。過去の行は書き換えない(赤黒帳票方式)。
// 画面側ログインゲートを通過した後にのみデータを取得・表示する(GETもcredentialヘッダで認証)。
const API_BASE = "https://ab-board-api.azurewebsites.net/api";
const BA_API = `${API_BASE}/ba`;

const HUMAN_TYPES = ["note", "void", "status"];

// ba-32: tagの予約語4種による分類。newのtagsと分類note(tagsに予約語を含むnote)を
// 時系列で走査し、最新の分類を採用する(追記オンリーの訂正方式と整合)。
const CLASSIFICATIONS = ["案件", "確定仕様", "気づき", "保留論点"];
const CLS_KEY = { "案件": "anken", "確定仕様": "shiyou", "気づき": "kizuki", "保留論点": "horyu" };

// ba-29: title/body/tags等をinnerHTMLへ流し込む前のHTMLエスケープ。
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function withCredential(body = {}) {
  return { ...body, credential: window.__credential };
}

function parseTags(text) {
  return text
    .split(/[\s,、]+/)
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);
}

// n4-5対応: サーバーのcreatedAtはUTCで保存されている(function_app.pyがdatetime.now(timezone.utc)
// で生成)。文字列を単純に切り詰めるとUTCのままJSTのつもりで読まれて混乱するため、
// 明示的にJSTへ変換した上で「JST」ラベルも付けて曖昧さを無くす。
function fmtTs(iso) {
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

// スレッド化: PartitionKey(threadId)でグルーピングし、id===threadIdの行を起点(new)とみなす。
function groupThreads(items) {
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
      // タイトル訂正(有事用): titleを持つcorrectionが見出し表示だけを上書きする(最新優先)。
      // 上書きはtitleに限定。本文の間違いは訂正エントリを「並べて見せる」従来方式のまま。
      if (e.type === "correction" && e.title) { displayTitle = e.title; titleCorrected = true; }
    });

    // 分類(ba-32/ba-33): new/noteのtagsから予約語を拾い、時系列で最新を採用。
    let cls = null;
    let clsVia = null;
    entries.forEach((e) => {
      if (e.type !== "new" && e.type !== "note") return;
      const found = (Array.isArray(e.tags) ? e.tags : []).find((t) => CLASSIFICATIONS.includes(t));
      if (found) { cls = found; clsVia = e.type; }
    });

    // 両視点そろって無効のときだけ既定で隠す。片方だけ無効=認識が食い違っている
    // スレッドは、齟齬が拾えるようにあえて隠さない。
    const hiddenVoid = voidView.claude === true && voidView.takashi === true;

    threads.push({ threadId, root, children, entries, voidView, priorityByLane, status, displayTitle, titleCorrected, hiddenVoid, cls, clsVia });
  });

  threads.sort((a, b) => b.root.createdAt.localeCompare(a.root.createdAt));
  return threads;
}

function entryTypeLabel(e) {
  if (e.type === "void") return `void = ${e.value ? "true" : "false"}`;
  if (e.type === "status") return `status → ${esc(e.status)}`;
  if (e.type === "priority") return `priority`;
  // ba-1: verified_on_device(実機/実ブラウザで確認できた、という主張。PCレーンのみ書込可)
  if (e.type === "verified_on_device") return `verified on device`;
  return e.type;
}

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
  const typeClass = e.type === "correction" ? " entry--correction" : e.type === "priority" ? " entry--priority" : e.type === "status" ? " entry--status" : e.type === "new" ? " entry--new" : e.type === "verified_on_device" ? " entry--verified" : " entry--note";
  // new/correctionのtitleはタイムライン上にも出す。訂正で見出しが変わっても、
  // 元のタイトルと訂正の経緯がスレッドを開けば読めるようにするため。
  const titleLine = e.title && (e.type === "new" || e.type === "correction")
    ? `<div class="entry-title">${e.type === "correction" ? "タイトル → " : ""}${esc(e.title)}</div>` : "";
  return `
    <div class="entry${voidClass || typeClass}">
      <div class="entry-rail"></div>
      <div>
        <div class="entry-head"><span class="entry-type">${entryTypeLabel(e)}</span><span>${fmtTs(e.createdAt)}</span><span>${esc(e.by)}</span></div>
        ${titleLine}
        <div class="entry-body">${esc(e.body || e.reason || "")}</div>
      </div>
    </div>`;
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

function threadCardHtml(thread) {
  const { threadId, root, children, status } = thread;
  const title = thread.displayTitle || root.body || "(無題)";
  const tags = Array.isArray(root.tags) ? root.tags : [];
  // 分類はバッジで出すため、自由タグ列からは除外して二重表示を避ける(ba-33)。
  const tagsHtml = tags.filter((t) => !CLASSIFICATIONS.includes(t)).map((t) => `<span class="tag">#${esc(t)}</span>`).join("");
  const ghHtml = root.github_issue ? `<span class="gh-chip">gh #${esc(root.github_issue)}</span>` : "";
  // 分類バッジ(ba-33)。note由来の分類は来歴として小さく「note」を添える(赤黒帳票の思想)。
  const clsHtml = thread.cls
    ? `<span class="cls-badge cls-badge--${CLS_KEY[thread.cls]}">${thread.cls}${thread.clsVia === "note" ? '<span class="cls-via">note</span>' : ""}</span>`
    : "";
  const isOpen = status === "open";
  const takashiVoid = thread.voidView.takashi;

  return `
    <details class="thread-card${thread.hiddenVoid ? " thread-card--void" : ""}" data-thread-id="${threadId}" ${isOpen ? "open" : ""}>
      <summary>
        <div class="thread-top-row">
          <span class="chevron">▶</span>
          ${root.seq ? `<span class="seq-chip">ba-${root.seq}</span>` : ""}
          <span class="pill ${isOpen ? "pill-open" : "pill-closed"}">${isOpen ? "open" : "closed"}</span>
          ${clsHtml}
          <span class="thread-title">${esc(title)}</span>
          ${thread.titleCorrected ? `<span class="title-corrected-chip">タイトル訂正済</span>` : ""}
        </div>
        <div class="meta-row">${tagsHtml}${ghHtml}</div>
        ${perspectiveRowHtml(thread.voidView)}
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
          </div>
          <div class="lane-form-hint">使える種別: note / void / status のみ(id・時刻・by は自動)</div>
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
}

// 両視点そろって無効のスレッドは既定で一覧から隠す。トグルONのときだけ薄色で表示する。
let showVoided = false;
// ba-33: 既定はopenのみ表示。確定仕様はcloseしない規約(ba-32)なので参照の邪魔にならない。
let showClosed = false;
// ba-33: 分類フィルタ(単一選択)。"all"は分類なしスレッドも含めて表示。
let filterCls = "all";
let cachedThreads = [];

function render() {
  const listEl = document.getElementById("threadList");
  const hiddenCount = cachedThreads.filter((t) => t.hiddenVoid).length;
  const closedCount = cachedThreads.filter((t) => t.status !== "open").length;
  let visible = showVoided ? cachedThreads : cachedThreads.filter((t) => !t.hiddenVoid);
  if (!showClosed) visible = visible.filter((t) => t.status === "open");
  if (filterCls !== "all") visible = visible.filter((t) => t.cls === filterCls);

  renderSummary(cachedThreads);
  renderClsFilter();

  const toggleEl = document.getElementById("btnToggleVoid");
  toggleEl.style.display = hiddenCount ? "" : "none";
  toggleEl.textContent = showVoided ? `無効スレッドを隠す(${hiddenCount})` : `無効スレッドも表示(${hiddenCount})`;

  const closedEl = document.getElementById("btnToggleClosed");
  closedEl.textContent = showClosed ? `closedを隠す(${closedCount})` : `closedも表示(${closedCount})`;

  listEl.innerHTML = visible.map(threadCardHtml).join("") || `<p class="empty">表示できるスレッドがありません(分類フィルタと「closedも表示」を確認)</p>`;
  visible.forEach((t) => attachThreadHandlers(listEl, t));
}

// ba-33: 分類フィルタのチップ(単一選択+件数)。分類なしスレッドは「すべて」でのみ表示される。
function renderClsFilter() {
  const el = document.getElementById("clsFilter");
  if (!el) return;
  const count = (c) => cachedThreads.filter((t) => t.cls === c).length;
  const chip = (value, label, n) =>
    `<button type="button" class="cls-chip${filterCls === value ? " cls-chip--on" : ""}${value !== "all" ? ` cls-chip--${CLS_KEY[value]}` : ""}" data-cls="${value}">${label}<span class="cls-cnt">${n}</span></button>`;
  el.innerHTML = chip("all", "すべて", cachedThreads.length) + CLASSIFICATIONS.map((c) => chip(c, c, count(c))).join("");
}

async function load() {
  const listEl = document.getElementById("threadList");
  try {
    const res = await fetch(BA_API, { cache: "no-store", headers: { "X-Ba-Credential": window.__credential || "" } });
    const items = res.ok ? await res.json() : [];
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
  load();
}

if (window.__loginState && window.__loginState.loggedIn) {
  onLoginSuccess();
} else {
  window.addEventListener("ba-login-success", onLoginSuccess, { once: true });
}
