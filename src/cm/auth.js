// cm/auth.js — n1/n2/n4で共通のログインゲート実装(2026-07-13 共通化)
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
// ログイン状態はlocalStorageに60分だけ保持し、期限内ならページ再訪問時にログインを省略する。
// (n4-3対応: 30分は頻繁すぎるとの指摘で60分に延長。Google IDトークン自体の実際の有効期限は
// 約1時間なので、期限ぎりぎりで書き込むと稀に失敗することがあるが、再ログインすれば済む)。
// n1/n2/n4で共通のキーを使うため、いずれか1つでログインすれば他も60分以内なら再ログイン不要になる。
const STORAGE_KEY = "aa_credential";
const SESSION_MS = 60 * 60 * 1000;
const LOGIN_EVENT = window.AA_AUTH_EVENT || "aa-login-success";

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

// ページ読み込み時、60分以内の保存済みログインがあれば再利用する
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
