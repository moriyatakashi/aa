// common/config.js — aa全ページ共通の設定値(ba-9共通化の一環、2026-07-16)
// API_BASEのハードコード解消(ba-30の(5))。クラシックスクリプトのため、
// module指定の各app.jsより必ず先に実行される(HTML内の記載位置に依らない)。
//
// 注: GoogleクライアントIDは各index.htmlのdata-client_id属性に残している。
// GSIの宣言的初期化の順序に手を入れるのはm14ログイン事故(c2/idea_01_失敗ログ参照)の轍に
// なり得るため、実機/Playwright確認とセットでPC側で別途行う(ba-9参照)。
window.AA_API_BASE = "https://ab-board-api.azurewebsites.net/api";
