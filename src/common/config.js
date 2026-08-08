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

// ファビコンの動的挿入: 各サブページで相対パスを気にせず表示させるため、
// SVG をデータURI化して <head> に link rel="icon" を追加する。
(function(){
  try {
    // 元の favicon.svg と同等のコンテンツ (色は prefers-color-scheme に依存)
    const svg = `<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">\n  <style>\n    .bg{fill:#0a6c96}\n    .fg{fill:#f7f6f0}\n    @media (prefers-color-scheme: dark){\n      .bg{fill:#66ccff}\n      .fg{fill:#14170f}\n    }\n  </style>\n  <rect x="1" y="1" width="14" height="14" rx="4" class="bg"/>\n  <text x="8" y="12" text-anchor="middle" font-size="11" font-weight="900" font-family="system-ui, sans-serif" class="fg">a</text>\n</svg>`;

    const href = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

    // 既にページが明示的に favicon を持っている場合は追加しない
    if (!document.querySelector('link[rel~="icon"]') && document.head) {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/svg+xml';
      link.href = href;
      document.head.appendChild(link);

      // Apple touch 用に同じデータURIを指定（iOSでのホーム画面追加に有利）
      const apple = document.createElement('link');
      apple.rel = 'apple-touch-icon';
      apple.href = href;
      document.head.appendChild(apple);
    }
  } catch (e) {
    // 失敗してもページ表示には影響を及ぼさないようにする
    console.error('favicon injection failed', e);
  }
})();
