// auth.js
// ログイン検証用の最小ロジック。DOM操作は結果表示の1行だけ。
// バックエンド側での検証は行わない(JWTペイロードをそのままクライアント側でデコードするだけ)。

function onSignIn(response) {
  try {
    const payload = JSON.parse(atob(response.credential.split(".")[1]));
    document.getElementById("result").textContent = payload.name || "(name未取得)";
  } catch (e) {
    console.warn("credentialのデコードに失敗:", e);
  }
}
