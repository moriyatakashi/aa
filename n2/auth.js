// auth.js — n2向けログインゲート(n1/boltzの修正版を流用)
// GSIのdata-callbackから呼ばれる。ログイン成功で訪問地図を表示する。
// atob()だけだと日本語名などマルチバイト文字が文字化けするため、UTF-8として明示的にデコードする。
function decodeJwtPayload(credential) {
  const base64 = credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

window.handleCredentialResponse = (response) => {
  try {
    const payload = decodeJwtPayload(response.credential);
    window.__loginState = { loggedIn: true, name: payload.name || "" };
    document.getElementById("login-gate").style.display = "none";
    document.getElementById("content").style.display = "block";
    window.dispatchEvent(new CustomEvent("n2-login-success"));
  } catch (e) {
    window.__loginState = { loggedIn: false, error: String(e) };
    document.getElementById("status").textContent = "ログインに失敗しました";
  }
};
