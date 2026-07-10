// app-optionB.js — issue #8への対応案B。
// イベント("boltz-login-success")の発火タイミングに依存せず、
// このスクリプトが実行された時点でwindow.__loginStateを直接チェックする。
// auth.js(通常スクリプト)はHTML解析中に同期実行されるため、
// このモジュールが動く時点では既にwindow.__loginStateがセット済みの可能性がある。
// 未ログインならイベントも引き続き待つ(通常のログインボタン操作に対応するため)。

function loadData() {
  const el = document.getElementById("loadStatus");
  if (el) el.textContent = "読み込み中...";
  setTimeout(() => {
    if (el) el.textContent = "データ読み込み完了";
  }, 50);
}

if (window.__loginState && window.__loginState.loggedIn) {
  loadData();
} else {
  window.addEventListener("boltz-login-success", loadData);
}
