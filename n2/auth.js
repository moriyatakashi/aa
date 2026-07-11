// auth.js — n2向けログインゲート(n1/boltzの修正版を流用)
// GSIのdata-callbackから呼ばれる。ログイン成功で訪問地図を表示する。
// atob()だけだと日本語名などマルチバイト文字が文字化けするため、UTF-8として明示的にデコードする。
// 訪問記録追加(書き込みAPI)にはGoogle IDトークン自体をab-board-api側で検証するため、
// デコード結果だけでなく生のcredentialもwindow.__credentialに保持しておく。
//
// ログイン状態はlocalStorageに30分だけ保持し、期限内ならページ再訪問時にログインを省略する。
// Google IDトークン自体の実際の有効期限は約1時間だが、それより短い30分で自主的に区切ることで、
// 実際には期限切れのトークンをAPIに送ってしまうケースを避けている(n1/n2で共通のキーを使うため、
// 片方でログインすればもう片方も30分以内なら再ログイン不要になる)。
const STORAGE_KEY = "aa_credential";
const SESSION_MS = 30 * 60 * 1000;

function decodeJwtPayload(credential) {
  const base64 = credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

function activateSession(credential, payload) {
  window.__loginState = { loggedIn: true, name: payload.name || "" };
  window.__credential = credential;
  document.getElementById("login-gate").style.display = "none";
  document.getElementById("content").style.display = "block";
  window.dispatchEvent(new CustomEvent("n2-login-success"));
}

// issue #9対応: 自前セッション復元後もGoogle One Tapが自動プロンプトを出してくる問題への対処。
// data-auto_prompt="false"のような初期化設定側の変更は過去(issue #7)に原因不明のデータ読み込み
// 不能を引き起こしたため触らない。代わりに、GSIスクリプトの読み込み完了を(onloadイベントに頼らず
// ポーリングで)待ってから、公式APIのdisableAutoSelect()で自動サインインだけを止める。
// スクリプトの読み込み順序に依存しない実装のため、issue #8のような順序起因の不具合は起きない。
function suppressAutoPromptWhenGsiReady(retriesLeft = 100) {
  if (window.google && window.google.accounts && window.google.accounts.id) {
    window.google.accounts.id.disableAutoSelect();
    return;
  }
  if (retriesLeft <= 0) return;
  setTimeout(() => suppressAutoPromptWhenGsiReady(retriesLeft - 1), 50);
}

window.handleCredentialResponse = (response) => {
  try {
    const payload = decodeJwtPayload(response.credential);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ credential: response.credential, savedAt: Date.now() }));
    activateSession(response.credential, payload);
  } catch (e) {
    window.__loginState = { loggedIn: false, error: String(e) };
    document.getElementById("status").textContent = "ログインに失敗しました";
  }
};

// ページ読み込み時、30分以内の保存済みログインがあれば再利用する
(function restoreSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const { credential, savedAt } = JSON.parse(raw);
    if (!credential || Date.now() - savedAt > SESSION_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    activateSession(credential, decodeJwtPayload(credential));
    suppressAutoPromptWhenGsiReady();
  } catch (e) {
    localStorage.removeItem(STORAGE_KEY);
  }
})();
