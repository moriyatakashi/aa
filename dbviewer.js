import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { app } from './firebase.js';

const auth = getAuth(app);
const db = getFirestore(app);
let fullData = null;

onAuthStateChanged(auth, user => {
  if (!user) location.href = 'login.html';
});

document.getElementById('fetchBtn').addEventListener('click', async () => {
  const col = document.getElementById('collection').value.trim();
  const docId = document.getElementById('docSelect').value;
  const status = document.getElementById('status');
  const output = document.getElementById('output');
  status.textContent = 'loading...';
  fullData = null;
  try {
    const snap = await getDoc(doc(db, col, docId));
    if (!snap.exists()) { status.textContent = 'not found'; output.textContent = ''; return; }
    fullData = snap.data();
    const display = { ...fullData };
    if (display.grid && display.grid.length > 64) {
      display.grid = [...display.grid.slice(0, 64), '...' + display.grid.length + ' items'];
    }
    output.textContent = JSON.stringify(display, null, 2);
    status.textContent = 'done (' + Object.keys(fullData).length + ' fields)';
  } catch (e) {
    status.textContent = 'error: ' + e.message;
  }
});

document.getElementById('copyBtn').addEventListener('click', () => {
  const btn = document.getElementById('copyBtn');
  const text = fullData ? JSON.stringify(fullData) : document.getElementById('output').textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'ok';
    setTimeout(() => { btn.textContent = 'copy'; }, 1500);
  });
});
