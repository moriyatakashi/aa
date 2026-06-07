import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { app } from './firebase.js';

const auth = getAuth(app);
const provider = new GoogleAuthProvider();

onAuthStateChanged(auth, user => {
  if (user) location.href = 'admin.html';
});

document.getElementById('loginBtn').addEventListener('click', () => {
  signInWithPopup(auth, provider).catch(console.error);
});
