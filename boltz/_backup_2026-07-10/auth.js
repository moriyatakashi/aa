// auth.js — n1向けログイン最小実装の検証用(boltz)
// GSIのdata-callbackから呼ばれる想定。JWTペイロードをクライアント側でデコードするだけ。
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
    document.getElementById("status").textContent =
      `ログイン中: ${payload.name || "(名前未取得)"}`;
  } catch (e) {
    window.__loginState = { loggedIn: false, error: String(e) };
    document.getElementById("status").textContent = "ログインに失敗しました";
  }
};
