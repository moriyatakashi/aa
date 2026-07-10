// app.js — n1のapp.js相当(type="module"でdeferされる)。
// ログイン成功イベントを受けてデータ読み込みを開始するダミー実装。
//
// 【既知バグの再現(issue #8と同じ構造)】
// auth.jsの自動復元(restoreSession)はHTML解析中に同期実行されるため、
// この行(addEventListener)が評価される前に "boltz-login-success" が
// 発火してしまうケースがある。その場合、このリスナーは何も受け取れず、
// 読み込みは「読み込み中...」のまま止まる。

function loadData() {
  const el = document.getElementById("loadStatus");
  if (el) el.textContent = "読み込み中...";
  // 実データ取得の代わりのダミー処理
  setTimeout(() => {
    if (el) el.textContent = "データ読み込み完了";
  }, 50);
}

window.addEventListener("boltz-login-success", loadData);
