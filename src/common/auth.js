// common/auth.js — n1/n2/n4で共通のログインゲート実装(2026-07-13 共通化)
// GSIのdata-callbackから呼ばれる。ログイン成功後、呼び出し元ページが待っている
// カスタムイベント(window.AA_AUTH_EVENTで指定、未指定時は"aa-login-success")を発火する。
// 各ページのindex.htmlは、このスクリプトを読み込む前に
//   <script>window.AA_AUTH_EVENT = "n4-login-success";</script>
// のように1行だけ書けばよい(app.js側の待受けイベント名を変えずに済むための互換用)。
//
// atob()だけだと日本語名などマルチバイト文字が文字化けするため、UTF-8として明示的にデコードする。
// 書き込み(人間レーン)にはGoogle IDトークン自体をab-board-api側で検証するため、
// デコード結果だけでなく生のcredentialもwindow.__credentialに保持しておく。
//
// 永続認証移行(ba-XX, 2026-07-19): Googleの生IDトークンは約1時間しか有効でないため、
// ログイン成功時にAA_API_BASE/session(POST)へ渡してサーバー発行の無期限セッション
// トークン("session:<id>.<署名>")に交換し、以後はそちらをwindow.__credentialとして使う。
// サーバー側が未対応(SESSION_SECRET未設定・通信不可等)の場合は、従来どおり生の
// Googleトークンを60分だけ保持するフォールバックに自動的に倒れる(段階移行を安全にするため)。
// 無期限トークンはログアウト(window.aaLogout、またはサーバー側の失効)でのみ失効する。
// n1/n2/n4で共通のキーを使うため、いずれか1つでログインすれば他も再ログイン不要になる。
const STORAGE_KEY = "aa_credential";
const GOOGLE_TOKEN_SESSION_MS = 60 * 60 * 1000; // フォールバック(生Googleトークン)のみに適用
const LOGIN_EVENT = window.AA_AUTH_EVENT || "aa-login-success";

function decodeJwtPayload(credential) {
  const base64 = credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

// ba-35残課題(2、2026-07-20): 閲覧はログイン不要にするページ向けの表示モード。
// ページ側が<script>window.AA_PUBLIC_VIEW = true;</script>を1行足すだけで有効化する
// (未指定なら既定でfalse相当=従来通りのゲート必須動作、baは対象外のため無変更)。
function renderLoginLink() {
  if (document.getElementById("aa-login-link")) return;
  const a = document.createElement("a");
  a.id = "aa-login-link";
  a.href = "#";
  a.textContent = "ログイン";
  a.className = "aa-corner-link";
  a.style.cssText =
    "position:fixed; top:8px; right:8px; font-size:0.72rem; color:#888; " +
    "background:rgba(0,0,0,0.35); padding:3px 8px; border-radius:5px; z-index:1000; text-decoration:none;";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("login-gate").style.display = "block";
    a.remove();
  });
  document.body.appendChild(a);
}

// ba-35残課題(2) Stage5: 公開閲覧モードで書き込みを試みた際、ログインへ誘導するための
// 共通ヘルパー。「ログイン」リンクをクリックした時と同じ操作(フルゲート表示)を行う。
window.aaShowLoginGate = () => {
  const link = document.getElementById("aa-login-link");
  if (link) link.remove();
  const gate = document.getElementById("login-gate");
  if (gate) gate.style.display = "block";
};

function renderLogoutLink() {
  if (document.getElementById("aa-logout-link")) return;
  const a = document.createElement("a");
  a.id = "aa-logout-link";
  a.href = "#";
  a.textContent = "ログアウト";
  a.className = "aa-corner-link";
  a.style.cssText =
    "position:fixed; top:8px; right:8px; font-size:0.72rem; color:#888; " +
    "background:rgba(0,0,0,0.35); padding:3px 8px; border-radius:5px; z-index:1000; text-decoration:none;";
  a.addEventListener("click", (e) => {
    e.preventDefault();
    window.aaLogout();
  });
  document.body.appendChild(a);
}

function activateSession(credential, name) {
  window.__loginState = { loggedIn: true, name: name || "" };
  window.__credential = credential;
  document.getElementById("login-gate").style.display = "none";
  document.getElementById("content").style.display = "block";
  renderLogoutLink();
  window.dispatchEvent(new CustomEvent(LOGIN_EVENT));
}

// issue #9対応の踏襲: 自前セッション復元後もGoogle One Tapが自動プロンプトを出してくる問題への対処。
// GSIスクリプトの読み込み完了を(onloadイベントに頼らずポーリングで)待ってから、
// 公式APIのdisableAutoSelect()で自動サインインだけを止める。
function suppressAutoPromptWhenGsiReady(retriesLeft = 100) {
  if (window.google && window.google.accounts && window.google.accounts.id) {
    window.google.accounts.id.disableAutoSelect();
    return;
  }
  if (retriesLeft <= 0) return;
  setTimeout(() => suppressAutoPromptWhenGsiReady(retriesLeft - 1), 50);
}

function persistSession(credential, name, kind) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ credential, name, kind, savedAt: Date.now() }));
}

// GoogleのIDトークンを、サーバー発行の無期限セッショントークンに交換する。
// 失敗時(未対応サーバー・オフライン等)はnullを返し、呼び出し側で従来フローにフォールバックする。
async function exchangeForPersistentSession(googleCredential) {
  const base = window.AA_API_BASE;
  if (!base) return null;
  try {
    const res = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: googleCredential }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.sessionToken || null;
  } catch (e) {
    return null;
  }
}

window.handleCredentialResponse = async (response) => {
  try {
    const payload = decodeJwtPayload(response.credential);
    const name = payload.name || "";
    const sessionToken = await exchangeForPersistentSession(response.credential);
    if (sessionToken) {
      persistSession(sessionToken, name, "session");
      activateSession(sessionToken, name);
    } else {
      persistSession(response.credential, name, "google");
      activateSession(response.credential, name);
    }
  } catch (e) {
    window.__loginState = { loggedIn: false, error: String(e) };
    document.getElementById("status").textContent = "ログインに失敗しました";
  }
};

// 明示的なログアウト。サーバー発行のセッショントークンならサーバー側でも即時失効させてから、
// ローカルの保存内容を消してページを再読み込みする(ログインゲートに戻すため)。
window.aaLogout = async () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const { credential, kind } = JSON.parse(raw);
      if (kind === "session" && credential && window.AA_API_BASE) {
        await fetch(`${window.AA_API_BASE}/session`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential }),
        }).catch(() => {});
      }
    }
  } finally {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  }
};

// ページ読み込み時、保存済みログインがあれば再利用する。
// kind:"session"(サーバー発行の無期限トークン)はローカルでの期限切れ判定を行わない
// (失効はログアウトかサーバー側の取り消しでのみ起こる)。
// kind:"google"(交換前の生IDトークン、または移行前からの保存データ)は
// 従来どおり60分でローカル失効させる(Googleトークン自体の寿命に合わせた安全策)。
(function restoreSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const { credential, savedAt, kind, name } = JSON.parse(raw);
    if (!credential) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    if (kind !== "session" && Date.now() - savedAt > GOOGLE_TOKEN_SESSION_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const displayName = kind === "session" ? name || "" : name || decodeJwtPayload(credential).name || "";
    activateSession(credential, displayName);
    suppressAutoPromptWhenGsiReady();
  } catch (e) {
    localStorage.removeItem(STORAGE_KEY);
  }
})();

// ba-35残課題(2): ログイン済み(restoreSessionで復元済み)でなければ、公開閲覧モードの
// ページでは即#contentを表示し、フルゲートの代わりに小さな「ログイン」リンクを出す。
// window.__credential/__loginStateはここでは設定しない(未ログインのまま=書き込みは
// 各ページ側でcredential有無を見て個別にログインを促す、ba-35 Stage5参照)。
if (window.AA_PUBLIC_VIEW && !(window.__loginState && window.__loginState.loggedIn)) {
  document.getElementById("content").style.display = "block";
  document.getElementById("login-gate").style.display = "none";
  renderLoginLink();
  suppressAutoPromptWhenGsiReady();
  // app.js(type="module")はauth.js(通常script)より後に実行されるため、ここで即dispatchすると
  // リスナー登録前にイベントが握りつぶされる。DOMContentLoadedまで待てば、moduleを含む
  // 全scriptの評価が完了している(HTML仕様上、DOMContentLoadedはdeferred/module実行後に発火)。
  window.addEventListener("DOMContentLoaded", () => {
    window.dispatchEvent(new CustomEvent(LOGIN_EVENT));
  });
}
