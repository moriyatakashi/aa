// app.js — ba(n4後継の追記ログ)。1件=1つの出来事(new/note/correction/priority/status/void/...)を
// 追記していくだけの台帳を表示・操作する。過去の行は書き換えない(赤黒帳票方式)。
// 画面側ログインゲートを通過した後にのみデータを取得・表示する(GETもcredentialヘッダで認証)。
const API_BASE = "https://ab-board-api.azurewebsites.net/api";
const BA_API = `${API_BASE}/ba`;

const HUMAN_TYPES = ["note", "void", "status"];

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

    // 両視点そろって無効のときだけ既定で隠す。片方だけ無効=認識が食い違っている
    // スレッドは、齟齬が拾えるようにあえて隠さない。
    const hiddenVoid = voidView.claude === true && voidView.takashi === true;

    threads.push({ threadId, root, children, entries, voidView, priorityByLane, status, displayTitle, titleCorrected, hiddenVoid });
  });

  threads.sort((a, b) => b.root.createdAt.localeCompare(a.root.createdAt));
  return threads;
}

function entryTypeLabel(e) {
  if (e.type === "void") return `void = ${e.value ? "true" : "false"}`;
  if (e.type === "status") return `status → ${e.status}`;
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
    ? `<div class="entry-title">${e.type === "correction" ? "タイトル → " : ""}${e.title}</div>` : "";
  return `
    <div class="entry${voidClass || typeClass}">
      <div class="entry-rail"></div>
      <div>
        <div class="entry-head"><span class="entry-type">${entryTypeLabel(e)}</span><span>${fmtTs(e.createdAt)}</span><span>${e.by}</span></div>
        ${titleLine}
        <div class="entry-body">${e.body || e.reason || ""}</div>
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
  const tagsHtml = tags.map((t) => `<span class="tag">#${t}</span>`).join("");
  const ghHtml = root.github_issue ? `<span class="gh-chip">gh #${root.github_issue}</span>` : "";
  const isOpen = status === "open";
  const takashiVoid = thread.voidView.takashi;

  return `
    <details class="thread-card${thread.hiddenVoid ? " thread-card--void" : ""}" data-thread-id="${threadId}" ${isOpen ? "open" : ""}>
      <summary>
        <div class="thread-top-row">
          <span class="chevron">▶</span>
          ${root.seq ? `<span class="seq-chip">ba-${root.seq}</span>` : ""}
          <span class="pill ${isOpen ? "pill-open" : "pill-closed"}">${isOpen ? "open" : "closed"}</span>
          <span class="thread-title">${title}</span>
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
let cachedThreads = [];

function render() {
  const listEl = document.getElementById("threadList");
  const hiddenCount = cachedThreads.filter((t) => t.hiddenVoid).length;
  const visible = showVoided ? cachedThreads : cachedThreads.filter((t) => !t.hiddenVoid);

  renderSummary(cachedThreads);
  const toggleEl = document.getElementById("btnToggleVoid");
  toggleEl.style.display = hiddenCount ? "" : "none";
  toggleEl.textContent = showVoided ? `無効スレッドを隠す(${hiddenCount})` : `無効スレッドも表示(${hiddenCount})`;

  listEl.innerHTML = visible.map(threadCardHtml).join("") || `<p class="empty">まだ何もありません</p>`;
  visible.forEach((t) => attachThreadHandlers(listEl, t));
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
  load();
}

if (window.__loginState && window.__loginState.loggedIn) {
  onLoginSuccess();
} else {
  window.addEventListener("ba-login-success", onLoginSuccess, { once: true });
}
