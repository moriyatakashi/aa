const categoryList = document.getElementById('categoryList');
const detailsContainer = document.getElementById('detailsContainer');
const statusDiv = document.getElementById('status');
const saveBtn = document.getElementById('saveBtn');
const reloadBtn = document.getElementById('reloadBtn');
const addCategoryBtn = document.getElementById('addCategoryBtn');

const GITHUB_API = 'https://api.github.com/repos/moriyatakashi/aa';

let data = {
  updated: '',
  categories: []
};

let navSha = '';

// GitHub から nav.yml を取得（読み取り専用、認証不要）
async function loadNavYml() {
  statusDiv.textContent = '読み込み中...';
  statusDiv.className = 'loading';
  
  try {
    // raw content を取得
    const response = await fetch(
      'https://raw.githubusercontent.com/moriyatakashi/aa/main/nav.yml'
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch nav.yml: ${response.status}`);
    }
    
    const yaml = await response.text();
    
    // YAML パース
    data = parseYaml(yaml);
    
    renderUI();
    statusDiv.textContent = 'nav.yml を読み込みました';
    statusDiv.className = 'success';
    setTimeout(() => statusDiv.textContent = '', 2000);
  } catch (err) {
    statusDiv.textContent = `エラー: ${err.message}`;
    statusDiv.className = 'error';
  }
}

// 簡易 YAML パーサー
function parseYaml(yaml) {
  const lines = yaml.split('\n');
  const result = { updated: '', categories: [] };
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    
    // updated の行
    if (line.includes('updated:')) {
      const match = line.match(/updated:\s*"([^"]*)"/);
      if (match) result.updated = match[1];
      i++;
      continue;
    }
    
    // categories の行
    if (line.includes('categories:')) {
      i++;
      while (i < lines.length && lines[i].startsWith('  - label:')) {
        const catMatch = lines[i].match(/label:\s*(.+)/);
        const category = { label: catMatch ? catMatch[1].trim() : '', items: [] };
        
        i++;
        while (i < lines.length && lines[i].startsWith('    items:')) {
          i++;
          while (i < lines.length && lines[i].startsWith('      - code:')) {
            const item = {};
            
            const codeMatch = lines[i].match(/code:\s*(.+)/);
            item.code = codeMatch ? codeMatch[1].trim() : '';
            i++;
            
            if (i < lines.length && lines[i].includes('desc:')) {
              const descMatch = lines[i].match(/desc:\s*(.+)/);
              item.desc = descMatch ? descMatch[1].trim() : '';
              i++;
            }
            
            if (i < lines.length && lines[i].includes('href:')) {
              const hrefMatch = lines[i].match(/href:\s*(.+)/);
              item.href = hrefMatch ? hrefMatch[1].trim() : '';
              i++;
            }
            
            category.items.push(item);
          }
          break;
        }
        
        result.categories.push(category);
      }
      break;
    }
    i++;
  }
  
  return result;
}

// UI をレンダリング
function renderUI() {
  // 左：カテゴリリスト
  categoryList.innerHTML = '';
  data.categories.forEach((cat, idx) => {
    const li = document.createElement('li');
    li.className = 'category-item';
    if (idx === 0) li.classList.add('active');
    li.textContent = cat.label || '（名前なし）';
    li.onclick = () => selectCategory(idx);
    categoryList.appendChild(li);
  });
  
  // 右：最初のカテゴリを表示
  if (data.categories.length > 0) {
    selectCategory(0);
  }
}

// カテゴリ選択
function selectCategory(idx) {
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
      <button onclick="addItem(${idx})" style="width: 100%; margin-top: 0.75rem;">+ アイテムを追加</button>
    </div>
    
    <button onclick="removeCategory(${idx})" style="width: 100%; margin-top: 1rem; background: #c33;">
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
      data.categories[idx].items[itemIdx][fields[fieldIdx]] = e.target.value;
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
  data.categories[catIdx].items.splice(itemIdx, 1);
  selectCategory(catIdx);
}

// カテゴリ削除
function removeCategory(idx) {
  if (confirm('このカテゴリを削除しますか？')) {
    data.categories.splice(idx, 1);
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
      <div style="margin-top: 0.75rem; font-size: 0.8rem; color: #666;">
        📝 このコンテンツをコピーして、GitHub に直接 push してください。
      </div>
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
reloadBtn.addEventListener('click', loadNavYml);
addCategoryBtn.addEventListener('click', addCategory);

// 初期化
loadNavYml();
