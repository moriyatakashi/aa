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

    const voidByLane = {};
    const priorityByLane = {};
    let status = "open";
    entries.forEach((e) => {
      if (e.type === "void" && e.by) voidByLane[e.by] = !!e.value;
      if (e.type === "priority" && e.by) priorityByLane[e.by] = e.value;
      if (e.type === "status" && e.status) status = e.status;
    });

    threads.push({ threadId, root, children, entries, voidByLane, priorityByLane, status });
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
  return `
    <div class="entry${voidClass || typeClass}">
      <div class="entry-rail"></div>
      <div>
        <div class="entry-head"><span class="entry-type">${entryTypeLabel(e)}</span><span>${fmtTs(e.createdAt)}</span><span>${e.by}</span></div>
        <div class="entry-body">${e.body || e.reason || ""}</div>
      </div>
    </div>`;
}

function perspectiveRowHtml(voidByLane) {
  const c = voidByLane.claude;
  const t = voidByLane.takashi;
  if (c === undefined && t === undefined) return "";
  const chip = (val, label) =>
    val === undefined
      ? ""
      : `<span class="perspective-chip ${val ? "perspective-chip--void" : "perspective-chip--active"}">${label}: ${val ? "無効" : "有効"}</span>`;
  return `<div class="perspective-row"><span class="perspective-label">無効フラグ:</span>${chip(c, "C")}${chip(t, "T")}</div>`;
}

function threadCardHtml(thread) {
  const { threadId, root, children, status } = thread;
  const title = root.title || root.body || "(無題)";
  const tags = Array.isArray(root.tags) ? root.tags : [];
  const tagsHtml = tags.map((t) => `<span class="tag">#${t}</span>`).join("");
  const ghHtml = root.github_issue ? `<span class="gh-chip">gh #${root.github_issue}</span>` : "";
  const isOpen = status === "open";
  const takashiVoid = thread.voidByLane.takashi;

  return `
    <details class="thread-card" data-thread-id="${threadId}" ${isOpen ? "open" : ""}>
      <summary>
        <div class="thread-top-row">
          <span class="chevron">▶</span>
          ${root.seq ? `<span class="seq-chip">ba-${root.seq}</span>` : ""}
          <span class="pill ${isOpen ? "pill-open" : "pill-closed"}">${isOpen ? "open" : "closed"}</span>
          <span class="thread-title">${title}</span>
        </div>
        <div class="meta-row">${tagsHtml}${ghHtml}</div>
        ${perspectiveRowHtml(thread.voidByLane)}
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
      await postEntry({ ref: thread.threadId, type: "void", value: !thread.voidByLane.takashi });
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

async function load() {
  const listEl = document.getElementById("threadList");
  try {
    const res = await fetch(BA_API, { cache: "no-store", headers: { "X-Ba-Credential": window.__credential || "" } });
    const items = res.ok ? await res.json() : [];
    const threads = groupThreads(items);

    renderSummary(threads);
    listEl.innerHTML = threads.map(threadCardHtml).join("") || `<p class="empty">まだ何もありません</p>`;
    threads.forEach((t) => attachThreadHandlers(listEl, t));
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
  load();
}

if (window.__loginState && window.__loginState.loggedIn) {
  onLoginSuccess();
} else {
  window.addEventListener("ba-login-success", onLoginSuccess, { once: true });
}
