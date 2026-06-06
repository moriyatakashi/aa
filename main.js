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

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const CELL = 3; // 1セル=3px
canvas.width = cols * CELL;
canvas.height = cols * CELL;

for (let r = 0; r < cols; r++) {
  for (let c = 0; c < cols; c++) {
    const cell = grid[r * cols + c];
    const color = colors[String(cell)];
    if (color) {
      ctx.fillStyle = color;
      ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
    }
  }
}

// グリッド線（薄く）
ctx.strokeStyle = 'rgba(255,255,255,0.03)';
ctx.lineWidth = 0.5;
for (let i = 0; i <= cols; i++) {
  ctx.beginPath();
  ctx.moveTo(i * CELL, 0);
  ctx.lineTo(i * CELL, cols * CELL);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, i * CELL);
  ctx.lineTo(cols * CELL, i * CELL);
  ctx.stroke();
}
