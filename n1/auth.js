// auth.js — n1向けログインゲート(boltzの修正版を流用)
// GSIのdata-callbackから呼ばれる。ログイン成功で記録一覧を表示する。
// atob()だけだと日本語名などマルチバイト文字が文字化けするため、UTF-8として明示的にデコードする。
// スコア保存(書き込みAPI)にはGoogle IDトークン自体をab-board-api側で検証するため、
// デコード結果だけでなく生のcredentialもwindow.__credentialに保持しておく。
function decodeJwtPayload(credential) {
  const base64 = credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

window.handleCredentialResponse = (response) => {
  try {
    const payload = decodeJwtPayload(response.credential);
    window.__loginState = { loggedIn: true, name: payload.name || "" };
    window.__credential = response.credential;
    document.getElementById("login-gate").style.display = "none";
    document.getElementById("content").style.display = "block";
    window.dispatchEvent(new CustomEvent("n1-login-success"));
  } catch (e) {
    window.__loginState = { loggedIn: false, error: String(e) };
    document.getElementById("status").textContent = "ログインに失敗しました";
  }
};
