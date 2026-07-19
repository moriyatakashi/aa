// common/config.js — aa全ページ共通の設定値(ba-9共通化の一環、2026-07-16)
// API_BASEのハードコード解消(ba-30の(5))。クラシックスクリプトのため、
// module指定の各app.jsより必ず先に実行される(HTML内の記載位置に依らない)。
//
// GoogleクライアントID(ba-9残タスク、2026-07-20集約)。GSIの宣言的初期化
// (<div id="g_id_onload" data-client_id="...">をGSIスクリプトが実行時にDOMから
// 読む方式)の順序に手を入れるのはm14ログイン事故(c2/idea_01_失敗ログ参照)の轍に
// なりかねないため、各ページはこの値をJSでdata-client_id属性に書き戻すだけに留め、
// GSIの初期化方式自体(async defer・宣言的init)には触れない。このscriptタグを
// 各index.htmlの<head>先頭に置くことで、GSIの外部scriptが実際にfetchを開始する
// 時点でこの値が確実に設定済みになるようにしている(タイミングの偶然に頼らない)。
window.AA_API_BASE = "https://ab-board-api.azurewebsites.net/api";
window.AA_GOOGLE_CLIENT_ID = "550466095352-50h92anfullp137l4gq4gdi7ogjk0auc.apps.googleusercontent.com";
