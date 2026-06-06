import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyCtpHqAY9oXWdQdr-DaGFnJWmIfpHUy0ZA",
  authDomain: "roreki.firebaseapp.com",
  projectId: "roreki",
  storageBucket: "roreki.firebasestorage.app",
  messagingSenderId: "627587600943",
  appId: "1:627587600943:web:9d895c71e14eeaa2502cda"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const snap = await getDoc(doc(db, 'map', 'japan'));
const { grid, colors, cols } = snap.data();

const table = document.getElementById('grid');
for (let r = 0; r < cols; r++) {
  const tr = document.createElement('tr');
  for (let c = 0; c < cols; c++) {
    const td = document.createElement('td');
    td.dataset.r = r;
    td.dataset.c = c;
    const cell = grid[r * cols + c];
    if (colors[cell]) td.style.background = colors[cell];
    tr.appendChild(td);
  }
  table.appendChild(tr);
}
