import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const app = initializeApp({
  apiKey: "AIzaSyCtpHqAY9oXWdQdr-DaGFnJWmIfpHUy0ZA",
  authDomain: "roreki.firebaseapp.com",
  projectId: "roreki",
  storageBucket: "roreki.firebasestorage.app",
  messagingSenderId: "627587600943",
  appId: "1:627587600943:web:9d895c71e14eeaa2502cda"
});

const auth = getAuth(app);
const provider = new GoogleAuthProvider();

onAuthStateChanged(auth, user => {
  if (user) location.href = 'admin.html';
});

document.getElementById('loginBtn').addEventListener('click', () => {
  signInWithPopup(auth, provider).catch(console.error);
});
