const categoryList = document.getElementById('categoryList');
const detailsContainer = document.getElementById('detailsContainer');
const statusDiv = document.getElementById('status');
const saveBtn = document.getElementById('saveBtn');
const reloadBtn = document.getElementById('reloadBtn');
const addCategoryBtn = document.getElementById('addCategoryBtn');

// モックデータ
let data = {
  updated: "2026-07-21 09:00",
  categories: [
    {
      label: "記録",
      items: [
        { code: "n1", desc: "記録一覧", href: "src/n1/" },
        { code: "n2", desc: "訪問地図", href: "src/n2/" },
        { code: "be", desc: "スコア推移(折れ線グラフ)", href: "src/be/" }
      ]
    },
    {
      label: "内部メモ",
      items: [
        { code: "ba", desc: "気づきログ(n4後継)", href: "src/ba/" },
        { code: "bb", desc: "ba現在形ビューワ", href: "src/bb/" },
        { code: "k2", desc: "baレーダーチャート", href: "src/k2/" },
        { code: "bg", desc: "YML定義エディタ", href: "src/bg/" }
      ]
    },
    {
      label: "あそび",
      items: [
        { code: "k1", desc: "NES Emulator", href: "src/k1/" },
        { code: "bc", desc: "CASL II シミュレータ", href: "src/bc/" },
        { code: "bd", desc: "ふっかつのじゅもん解析器", href: "src/bd/" },
        { code: "bf", desc: "DQ2 ふっかつのじゅもん生成器", href: "src/bf/" }
      ]
    }
  ]
};

let currentCategoryIdx = 0;

// UI をレンダリング
function renderUI() {
  // 左：カテゴリリスト
  categoryList.innerHTML = '';
  data.categories.forEach((cat, idx) => {
    const li = document.createElement('li');
    li.className = 'category-item';
    if (idx === currentCategoryIdx) li.classList.add('active');
    li.textContent = cat.label || '（名前なし）';
    li.onclick = () => selectCategory(idx);
    categoryList.appendChild(li);
  });
  
  // 右：最初のカテゴリを表示
  selectCategory(currentCategoryIdx);
}

// カテゴリ選択
function selectCategory(idx) {
  currentCategoryIdx = idx;
  
  // 左の選択状態を更新
  document.querySelectorAll('.category-item').forEach((item, i) => {
    item.classList.toggle('active', i === idx);
  });
  
  // 右に詳細を表示
  const cat = data.categories[idx];
  
  detailsContainer.innerHTML = `
    <div class="category-form">
      <label>カテゴリ名</label>
      <input type="text" class="cat-label" value="${escapeHtml(cat.label)}" />
    </div>
    
    <div class="items-section">
      <h3>アイテム</h3>
      <div id="itemsContainer"></div>
      <button onclick="addItem(${idx})" style="width: 100%; margin-top: 0.75rem; padding: 0.5rem; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer;">+ アイテムを追加</button>
    </div>
    
    <button onclick="removeCategory(${idx})" style="width: 100%; margin-top: 1rem; background: #c33; color: white; padding: 0.5rem; border: none; border-radius: 4px; cursor: pointer;">
      このカテゴリを削除
    </button>
  `;
  
  // アイテムを表示
  const itemsContainer = detailsContainer.querySelector('#itemsContainer');
  cat.items.forEach((item, itemIdx) => {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'item-block';
    itemDiv.innerHTML = `
      <label>Code</label>
      <input type="text" class="item-code" value="${escapeHtml(item.code)}" />
      
      <label>Description</label>
      <input type="text" class="item-desc" value="${escapeHtml(item.desc)}" />
      
      <label>Href</label>
      <input type="text" class="item-href" value="${escapeHtml(item.href)}" />
      
      <button class="item-remove" onclick="removeItem(${idx}, ${itemIdx})">削除</button>
    `;
    itemsContainer.appendChild(itemDiv);
  });
  
  // カテゴリ名の変更を監視
  detailsContainer.querySelector('.cat-label').addEventListener('input', (e) => {
    data.categories[idx].label = e.target.value;
  });
  
  // アイテムの変更を監視
  detailsContainer.querySelectorAll('.item-code, .item-desc, .item-href').forEach((input, i) => {
    const itemIdx = Math.floor(i / 3);
    const fieldIdx = i % 3;
    const fields = ['code', 'desc', 'href'];
    
    input.addEventListener('input', (e) => {
      if (data.categories[idx].items[itemIdx]) {
        data.categories[idx].items[itemIdx][fields[fieldIdx]] = e.target.value;
      }
    });
  });
}

// アイテム追加
function addItem(catIdx) {
  data.categories[catIdx].items.push({ code: '', desc: '', href: '' });
  selectCategory(catIdx);
}

// アイテム削除
function removeItem(catIdx, itemIdx) {
  if (confirm('このアイテムを削除しますか？')) {
    data.categories[catIdx].items.splice(itemIdx, 1);
    selectCategory(catIdx);
  }
}

// カテゴリ削除
function removeCategory(idx) {
  if (confirm('このカテゴリを削除しますか？')) {
    data.categories.splice(idx, 1);
    if (currentCategoryIdx >= data.categories.length) {
      currentCategoryIdx = data.categories.length - 1;
    }
    renderUI();
  }
}

// カテゴリ追加
function addCategory() {
  data.categories.push({ label: '新しいカテゴリ', items: [] });
  renderUI();
}

// YAML に変換
function toYaml(obj) {
  let yaml = `updated: "${obj.updated || new Date().toISOString().split('T')[0]}"\n`;
  yaml += `categories:\n`;
  
  obj.categories.forEach(cat => {
    yaml += `  - label: ${cat.label}\n`;
    yaml += `    items:\n`;
    cat.items.forEach(item => {
      yaml += `      - code: ${item.code}\n`;
      yaml += `        desc: ${item.desc}\n`;
      yaml += `        href: ${item.href}\n`;
    });
  });
  
  return yaml;
}

// ローカルストレージに保存
function save() {
  const yaml = toYaml(data);
  const now = new Date().toLocaleString('ja-JP');
  
  try {
    localStorage.setItem('bg_nav_yml', yaml);
    localStorage.setItem('bg_nav_timestamp', now);
    
    statusDiv.innerHTML = `
      <strong>✓ ローカルストレージに保存しました</strong><br/>
      <span style="font-size: 0.8rem; margin-top: 0.5rem; display: block;">
        ${now}
      </span>
      <br/>
      <strong style="font-size: 0.85rem;">YAML プレビュー：</strong>
      <pre style="background: #f0f0f0; padding: 0.5rem; border-radius: 3px; font-size: 0.75rem; overflow-x: auto; max-height: 200px; margin-top: 0.5rem;">${escapeHtml(yaml)}</pre>
    `;
    statusDiv.className = 'success';
  } catch (err) {
    statusDiv.textContent = `✗ 保存エラー: ${err.message}`;
    statusDiv.className = 'error';
  }
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

// イベント
saveBtn.addEventListener('click', save);
reloadBtn.addEventListener('click', () => {
  statusDiv.textContent = 'モックデータを再読み込みしました';
  statusDiv.className = 'success';
  setTimeout(() => statusDiv.textContent = '', 2000);
});
addCategoryBtn.addEventListener('click', addCategory);

// 初期化
renderUI();
