// auth.js — n1向けログイン最小実装の検証用(boltz)
// GSIのdata-callbackから呼ばれる想定。JWTペイロードをクライアント側でデコードするだけ。
// atob()だけだと日本語名などマルチバイト文字が文字化けするため、UTF-8として明示的にデコードする。

const CACHE_KEY = "boltz_login_cache";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30分(n1/n2と同じ自動復元キャッシュ期間)

function decodeJwtPayload(credential) {
  const base64 = credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

function activateSession(payload) {
  window.__loginState = { loggedIn: true, name: payload.name || "" };
  const statusEl = document.getElementById("status");
  if (statusEl) {
    statusEl.textContent = `ログイン中: ${payload.name || "(名前未取得)"}`;
  }
  // n1/n2と同じく、データ読み込み側(app.js)に知らせるためイベントを発火する。
  // restoreSession()の場合はスクリプト解析中に同期的に発火する点がissue #8の再現ポイント。
  window.dispatchEvent(new CustomEvent("boltz-login-success"));
}

window.handleCredentialResponse = (response) => {
  try {
    const payload = decodeJwtPayload(response.credential);
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ credential: response.credential, expiresAt: Date.now() + CACHE_TTL_MS })
    );
    activateSession(payload);
  } catch (e) {
    window.__loginState = { loggedIn: false, error: String(e) };
    const statusEl = document.getElementById("status");
    if (statusEl) statusEl.textContent = "ログインに失敗しました";
  }
};

// n1/n2のrestoreSession()と同じ即時実行関数。
// 30分以内の有効なキャッシュがあれば、ログインボタン操作を経ずに同期的にactivateSession()を呼ぶ。
(function restoreSession() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const cache = JSON.parse(raw);
    if (!cache.expiresAt || Date.now() > cache.expiresAt) {
      localStorage.removeItem(CACHE_KEY);
      return;
    }
    const payload = decodeJwtPayload(cache.credential);
    activateSession(payload);
  } catch (e) {
    // 壊れたキャッシュは無視して未ログイン扱いにする
  }
})();
