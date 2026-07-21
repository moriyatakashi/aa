const container = document.getElementById('categoriesContainer');
const preview = document.getElementById('preview');
const addCategoryBtn = document.getElementById('addCategoryBtn');
const saveBtn = document.getElementById('saveBtn');
const clearBtn = document.getElementById('clearBtn');
const statusDiv = document.getElementById('status');

const STORAGE_KEY = 'bg_yml_data';
const STORAGE_TIMESTAMP = 'bg_yml_timestamp';

let data = {
  updated: new Date().toISOString().split('T')[0],
  categories: []
};

// フォーム内のデータを収集
function collectFormData() {
  const categories = [];
  
  document.querySelectorAll('.category-block').forEach(block => {
    const label = block.querySelector('.category-label').value.trim();
    if (!label) return;
    
    const items = [];
    block.querySelectorAll('.item-block').forEach(item => {
      const code = item.querySelector('.item-code').value.trim();
      const desc = item.querySelector('.item-desc').value.trim();
      const href = item.querySelector('.item-href').value.trim();
      
      if (code || desc || href) {
        items.push({ code, desc, href });
      }
    });
    
    categories.push({ label, items });
  });
  
  return categories;
}

// YAML テキスト生成
function generateYaml(categories) {
  let yaml = `updated: "${new Date().toLocaleString('sv-SE').slice(0, 16)}"\n`;
  yaml += `categories:\n`;
  
  categories.forEach(cat => {
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

// プレビュー更新
function updatePreview() {
  const categories = collectFormData();
  const yaml = generateYaml(categories);
  preview.textContent = yaml;
}

// カテゴリ削除
function removeCategory(idx) {
  document.querySelectorAll('.category-block')[idx]?.remove();
  updatePreview();
}

// アイテム削除
function removeItem(catIdx, itemIdx) {
  const catBlock = document.querySelectorAll('.category-block')[catIdx];
  const items = catBlock.querySelectorAll('.item-block');
  items[itemIdx]?.remove();
  updatePreview();
}

// カテゴリ追加
function addCategory() {
  const idx = document.querySelectorAll('.category-block').length;
  
  const block = document.createElement('div');
  block.className = 'category-block';
  
  block.innerHTML = `
    <div class="category-header">
      <input type="text" class="category-label" placeholder="カテゴリ名（例: 記録）" />
      <button onclick="removeCategory(${idx})">削除</button>
    </div>
    <div class="items-container"></div>
    <button class="add-btn" style="width: 100%; margin-top: 0.5rem;" onclick="addItem(${idx})">+ アイテムを追加</button>
  `;
  
  container.appendChild(block);
  updatePreview();
}

// アイテム追加
function addItem(catIdx) {
  const catBlock = document.querySelectorAll('.category-block')[catIdx];
  const itemsContainer = catBlock.querySelector('.items-container');
  const itemIdx = itemsContainer.querySelectorAll('.item-block').length;
  
  const item = document.createElement('div');
  item.className = 'item-block';
  
  item.innerHTML = `
    <div style="display: grid; grid-template-columns: 1fr; gap: 0.5rem;">
      <div>
        <label>code</label>
        <input type="text" class="item-code" placeholder="n1, n2, ba..." />
      </div>
      <div>
        <label>desc</label>
        <input type="text" class="item-desc" placeholder="説明" />
      </div>
      <div>
        <label>href</label>
        <input type="text" class="item-href" placeholder="src/n1/" />
      </div>
      <button class="item-remove" onclick="removeItem(${catIdx}, ${itemIdx})">削除</button>
    </div>
  `;
  
  // リアルタイムプレビュー更新
  item.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', updatePreview);
  });
  
  itemsContainer.appendChild(item);
  updatePreview();
}

// 初期化時データ読み込み
function loadFromStorage() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const saved_data = JSON.parse(saved);
      data = saved_data;
      
      // UI を再構築
      data.categories.forEach((cat, idx) => {
        addCategory();
        const block = document.querySelectorAll('.category-block')[idx];
        block.querySelector('.category-label').value = cat.label;
        
        cat.items.forEach((item, itemIdx) => {
          addItem(idx);
          const itemBlock = block.querySelectorAll('.item-block')[itemIdx];
          itemBlock.querySelector('.item-code').value = item.code;
          itemBlock.querySelector('.item-desc').value = item.desc;
          itemBlock.querySelector('.item-href').value = item.href;
        });
      });
      
      const timestamp = localStorage.getItem(STORAGE_TIMESTAMP);
      if (timestamp) {
        statusDiv.textContent = `前回保存: ${timestamp}`;
      }
    } catch (e) {
      console.error('Failed to load data:', e);
    }
  } else {
    // デモデータを入れる
    addCategory();
  }
  
  updatePreview();
}

// 保存
function save() {
  const categories = collectFormData();
  data.categories = categories;
  data.updated = new Date().toLocaleString('sv-SE').slice(0, 16);
  
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    const now = new Date().toLocaleString('ja-JP');
    localStorage.setItem(STORAGE_TIMESTAMP, now);
    
    statusDiv.textContent = `✓ 保存しました (${now})`;
    statusDiv.className = 'success';
  } catch (err) {
    statusDiv.textContent = `✗ 保存エラー: ${err.message}`;
    statusDiv.className = 'error';
  }
  
  setTimeout(() => {
    statusDiv.textContent = '';
    statusDiv.className = '';
  }, 3000);
}

// クリア
function clear() {
  if (confirm('全てのデータをクリアしますか？')) {
    container.innerHTML = '';
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_TIMESTAMP);
    data = { updated: new Date().toISOString().split('T')[0], categories: [] };
    addCategory();
    updatePreview();
    statusDiv.textContent = 'クリアしました';
  }
}

// イベント
addCategoryBtn.addEventListener('click', addCategory);
saveBtn.addEventListener('click', save);
clearBtn.addEventListener('click', clear);

// リアルタイムプレビュー用にカテゴリラベル入力も監視
container.addEventListener('input', (e) => {
  if (e.target.classList.contains('category-label')) {
    updatePreview();
  }
});

// 初期化
loadFromStorage();
