// aa/src/ca/ca-app.js -- ca(ba-242/c1.html P6)のFirestore SDK経由read/write。
// (2026-08-08、ab/src/ca-app.jsから移設)
// ca.html から type="module" で読み込まれる。
//
// 読み取り: 誰でも(Security Rulesの allow read: if true)。onSnapshotでリアルタイム表示。
// 人間の書き込み: Firebase Authentication(Googleログイン) + Security Rulesがtakashi本人のみ許可
// (../../firestore.rules参照)。ここではUIをtakashiのメールで出し分けているだけで、実際の認可は
// Rules側が担う(このJS内のチェックを迂回されても書き込みは弾かれる)。
// Claudeレーンの書き込みはこのファイルを経由しない(rbook/run ca → Cloud Function、
// firestore.rules冒頭のコメント参照)。
//
// createdAtは意図的にFirestore Timestamp/serverTimestamp()ではなく ISO 8601文字列を使う。
// 理由: Claudeレーン(aa/functions/ca_lane/main.py)がdatetime.now(timezone.utc).isoformat()で
// 文字列として書いているため、型を揃えないと orderBy('createdAt') が
// 人間の投稿とClaudeの投稿の間で正しく交互に並ばなくなる(rbook/src/run_ca.pyの
// 文字列ソートとも合わせる必要がある)。

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getFirestore, collection, query, orderBy, onSnapshot, addDoc, doc,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";

// プロジェクトは ab01-9f35a(rbook/src/run.yml参照、P1で既に作成・流用済み)。
// 値は Firebase Management API(projects.webApps.getConfig)から取得したもの
// (登録済みウェブアプリ "ab" 1件のみ)。apiKeyは公開前提の値(クライアントに同梱される) —
// 認可はSecurity Rulesが担うので、ここに秘密情報は含まれない。
const firebaseConfig = {
  apiKey: "AIzaSyDuPw8nMuFWx8ghV5ZeBGETeiNII3uk4l8",
  authDomain: "ab01-9f35a.firebaseapp.com",
  projectId: "ab01-9f35a",
  storageBucket: "ab01-9f35a.firebasestorage.app",
  messagingSenderId: "502154862201",
  appId: "1:502154862201:web:4ca0c72225af6bd0147ea8",
  measurementId: "G-4L8FF69B1B",
};

const TAKASHI_EMAIL = "takashi.moriya@gmail.com";

const $ = (id) => document.getElementById(id);
const statusLine = $("status-line");
const liveBadge = $("live-badge");
const summaryThreads = $("summary-threads");
const summaryOpen = $("summary-open");
const summaryLatest = $("summary-latest");
const authInfo = $("auth-info");
const signinBtn = $("signin-btn");
const signoutBtn = $("signout-btn");
const newThreadBox = $("new-thread-box");
const newThreadForm = $("new-thread-form");
const threadList = $("thread-list");

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// --- 認証 ---------------------------------------------------------------
let isTakashi = false;

onAuthStateChanged(auth, (user) => {
  isTakashi = !!user && user.email === TAKASHI_EMAIL && !!user.emailVerified;
  if (user) {
    signinBtn.style.display = "none";
    signoutBtn.style.display = "";
    authInfo.style.display = "";
    authInfo.textContent = isTakashi
      ? `${user.email} としてログイン中`
      : `${user.email} としてログイン中(書き込み権限なし — takashi本人のみ)`;
  } else {
    signinBtn.style.display = "";
    signoutBtn.style.display = "none";
    authInfo.style.display = "none";
  }
  newThreadBox.style.display = isTakashi ? "" : "none";
  render();
});

signinBtn.addEventListener("click", () => {
  signInWithPopup(auth, provider).catch((err) => {
    alert("ログイン失敗: " + err.message);
  });
});

signoutBtn.addEventListener("click", () => {
  signOut(auth);
});

// --- 新規スレッド作成 -----------------------------------------------------
newThreadForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const title = $("nt-title").value.trim();
  if (!title) return;
  const submitBtn = newThreadForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    await addDoc(collection(db, "caThreads"), {
      title,
      body: $("nt-body").value.trim(),
      class: $("nt-class").value.trim(),
      by: "takashi",
      createdAt: new Date().toISOString(),
      status: "open",
    });
    newThreadForm.reset();
  } catch (err) {
    alert("投稿失敗: " + err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

// --- note追記(スレッドカードごとに動的生成するフォーム) ---------------------
async function submitNote(threadId, text, formEl) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const btn = formEl.querySelector("button");
  btn.disabled = true;
  try {
    await addDoc(collection(db, "caThreads", threadId, "notes"), {
      body: trimmed,
      by: "takashi",
      createdAt: new Date().toISOString(),
    });
    formEl.reset();
  } catch (err) {
    alert("追記失敗: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// --- 読み取り(リアルタイム) ------------------------------------------------
// スレッド本体とnotesサブコレクションを両方onSnapshotで購読する。
// notesの購読はスレッドごとに個別に張り、スレッドが消えたら(このアプリでは削除しないが念のため)解除する。
const threadsCache = new Map(); // id -> { id, ...fields, notes: [] }
const noteUnsubs = new Map(); // id -> unsubscribe fn

const threadsQuery = query(collection(db, "caThreads"), orderBy("createdAt", "asc"));

onSnapshot(
  threadsQuery,
  (snap) => {
    liveBadge.style.display = "";
    statusLine.style.display = "none";
    snap.docChanges().forEach((change) => {
      const id = change.doc.id;
      if (change.type === "removed") {
        threadsCache.delete(id);
        const unsub = noteUnsubs.get(id);
        if (unsub) { unsub(); noteUnsubs.delete(id); }
        return;
      }
      const prev = threadsCache.get(id);
      threadsCache.set(id, { id, ...change.doc.data(), notes: prev ? prev.notes : [] });
      if (!noteUnsubs.has(id)) {
        const notesQuery = query(collection(db, "caThreads", id, "notes"), orderBy("createdAt", "asc"));
        const unsub = onSnapshot(notesQuery, (nsnap) => {
          const t = threadsCache.get(id);
          if (!t) return;
          t.notes = nsnap.docs.map((d) => ({ id: d.id, ...d.data() }));
          render();
        });
        noteUnsubs.set(id, unsub);
      }
    });
    render();
  },
  (err) => {
    statusLine.style.display = "";
    statusLine.textContent = "読み込みに失敗しました: " + err.message;
  }
);

function laneDotClass(by) {
  return (by || "").startsWith("claude") ? "lane-dot--claude" : "lane-dot--human";
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function render() {
  const threads = [...threadsCache.values()].sort((a, b) =>
    (a.createdAt || "").localeCompare(b.createdAt || "")
  );

  summaryThreads.textContent = threads.length;
  summaryOpen.textContent = threads.filter((t) => (t.status || "open") === "open").length;
  const allNotes = threads.flatMap((t) => t.notes.map((n) => ({ ...n, threadId: t.id })));
  const lastAuthor = allNotes.length
    ? allNotes.reduce((a, b) => ((a.createdAt || "") > (b.createdAt || "") ? a : b)).by
    : (threads.length ? threads[threads.length - 1].by : "-");
  summaryLatest.textContent = lastAuthor || "-";

  threadList.innerHTML = "";
  if (!threads.length) {
    threadList.innerHTML = '<p class="pv-lede">(まだスレッドがありません)</p>';
    return;
  }

  threads.forEach((t, idx) => {
    const card = document.createElement("div");
    card.className = "pv-thread-card";

    const notesHtml = t.notes.map((n) => `
      <div>
        <div class="pv-note-line">${escapeHtml(n.body)}</div>
        <div class="pv-note-meta"><span class="lane-dot ${laneDotClass(n.by)}"></span>${escapeHtml(n.by)} · ${fmtTime(n.createdAt)}</div>
      </div>
    `).join("");

    card.innerHTML = `
      <div class="pv-thread-head">
        <span class="pv-thread-seq">#${idx + 1}</span>
        <span class="pv-thread-title">${escapeHtml(t.title)}</span>
        ${t.class ? `<span class="pv-thread-cls">${escapeHtml(t.class)}</span>` : ""}
      </div>
      <div class="pv-thread-meta"><span class="lane-dot ${laneDotClass(t.by)}"></span>${escapeHtml(t.by)} · ${fmtTime(t.createdAt)}${t.status && t.status !== "open" ? " · " + escapeHtml(t.status) : ""}</div>
      ${t.body ? `<div class="pv-note-line" style="margin-top:8px">${escapeHtml(t.body)}</div>` : ""}
      <div class="pv-thread-notes">${notesHtml}</div>
    `;

    if (isTakashi) {
      const form = document.createElement("form");
      form.className = "note-form";
      form.innerHTML = `
        <input type="text" placeholder="noteを追記…" required>
        <button type="submit">追記</button>
      `;
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const input = form.querySelector("input");
        submitNote(t.id, input.value, form);
      });
      card.appendChild(form);
    }

    threadList.appendChild(card);
  });
}
