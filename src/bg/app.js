const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const statusDiv = document.getElementById('status');
const saveBtn = document.getElementById('saveBtn');
const clearBtn = document.getElementById('clearBtn');

const STORAGE_KEY = 'bg_yml_content';
const STORAGE_TIMESTAMP = 'bg_yml_timestamp';

// ローカルストレージから読み込み
function loadFromStorage() {
  const content = localStorage.getItem(STORAGE_KEY);
  if (content) {
    editor.value = content;
    updatePreview();
    const timestamp = localStorage.getItem(STORAGE_TIMESTAMP);
    if (timestamp) {
      statusDiv.textContent = `前回保存: ${timestamp}`;
      statusDiv.className = '';
    }
  }
}

// YML テキストを JSON 風にプレビュー
function updatePreview() {
  const yaml = editor.value.trim();
  
  if (!yaml) {
    preview.textContent = '（入力してください）';
    return;
  }

  try {
    // 簡易パース: YML -> JavaScript オブジェクト
    const obj = parseSimpleYaml(yaml);
    
    // JSON 形式で表示
    preview.textContent = JSON.stringify(obj, null, 2);
    preview.style.color = '#333';
  } catch (err) {
    preview.textContent = `❌ パースエラー:\n${err.message}`;
    preview.style.color = '#c33';
  }
}

// シンプルな YML パーサー（基本的な構造のみ対応）
function parseSimpleYaml(yaml) {
  const lines = yaml.split('\n');
  const result = {};
  const stack = [{ depth: -1, obj: result }];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue; // 空行・コメント スキップ
    
    const match = line.match(/^(\s*)(.+?):\s*(.*)$/);
    if (!match) continue;
    
    const depth = match[1].length / 2;
    const key = match[2];
    const value = match[3];
    
    // スタックの深さに合わせて調整
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    
    const parent = stack[stack.length - 1].obj;
    
    if (value === '' || value === '-') {
      // ネストされたオブジェクトまたは配列
      if (value === '-') {
        if (!parent[key]) parent[key] = [];
        const item = {};
        parent[key].push(item);
        stack.push({ depth, obj: item });
      } else {
        parent[key] = {};
        stack.push({ depth, obj: parent[key] });
      }
    } else {
      // スカラー値
      parent[key] = parseValue(value);
    }
  }
  
  return result;
}

function parseValue(str) {
  if (str === 'true') return true;
  if (str === 'false') return false;
  if (str === 'null') return null;
  if (!isNaN(str) && str !== '') return Number(str);
  return str.replace(/^["']|["']$/g, ''); // クォート削除
}

// 保存
function save() {
  const content = editor.value;
  const now = new Date().toLocaleString('ja-JP');
  
  try {
    localStorage.setItem(STORAGE_KEY, content);
    localStorage.setItem(STORAGE_TIMESTAMP, now);
    
    statusDiv.textContent = `✓ 保存しました (${now})`;
    statusDiv.className = 'success';
  } catch (err) {
    statusDiv.textContent = `✗ 保存エラー: ${err.message}`;
    statusDiv.className = 'error';
  }
  
  setTimeout(() => {
    statusDiv.textContent = '';
  }, 3000);
}

// クリア
function clear() {
  if (confirm('エディタをクリアしますか？')) {
    editor.value = '';
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_TIMESTAMP);
    updatePreview();
    statusDiv.textContent = 'クリアしました';
  }
}

// イベント
editor.addEventListener('input', updatePreview);
saveBtn.addEventListener('click', save);
clearBtn.addEventListener('click', clear);

// 初期化
loadFromStorage();
