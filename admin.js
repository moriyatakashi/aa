import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { app } from './firebase.js';

const auth = getAuth(app);
const db = getFirestore(app);

onAuthStateChanged(auth, user => {
  if (!user) location.href = 'login.html';
});

let currentGrid = [];
let currentColors = {};
let selectedColor = '0';

const status = document.getElementById('status');
const snap = await getDoc(doc(db, 'map', 'japan'));
const data = snap.data();
const COLS = data.cols || 16;
currentGrid = [...data.grid];
currentColors = data.colors;

const picker = document.getElementById('colorPicker');
Object.entries(currentColors).forEach(([key, color]) => {
  const sw = document.createElement('div');
  sw.className = 'swatch' + (key === '0' ? ' selected' : '');
  sw.style.background = color || '#0a0a0a';
  sw.style.border = key === '0' ? '2px solid #fff' : '2px solid #444';
  sw.title = data.labels?.[key] || (key === '0' ? 'sea' : key);
  sw.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach(s => s.style.border = '2px solid #444');
    sw.style.border = '2px solid #fff';
    selectedColor = key;
  });
  picker.appendChild(sw);
});

const table = document.getElementById('grid');
for (let r = 0; r < COLS; r++) {
  const tr = document.createElement('tr');
  for (let c = 0; c < COLS; c++) {
    const td = document.createElement('td');
    const idx = r * COLS + c;
    const cell = currentGrid[idx];
    if (currentColors[cell]) td.style.background = currentColors[cell];
    td.addEventListener('click', () => {
      currentGrid[idx] = parseInt(selectedColor);
      td.style.background = currentColors[selectedColor] || '#0a0a0a';
    });
    tr.appendChild(td);
  }
  table.appendChild(tr);
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  status.textContent = 'saving...';
  await setDoc(doc(db, 'map', 'japan'), { ...data, grid: currentGrid });
  status.textContent = 'saved!';
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  signOut(auth).then(() => location.href = 'login.html');
});
