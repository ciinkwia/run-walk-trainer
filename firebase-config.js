// Firebase SDK v11 — modular imports from CDN
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged }
    from 'https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js';
import { getFirestore, collection, addDoc, getDocs, deleteDoc, doc, query, orderBy, serverTimestamp }
    from 'https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js';

const firebaseConfig = {
    apiKey: "AIzaSyDqh67qB348uZ9JXX8oBG0LsKZpMB1WMnc",
    authDomain: "run-walk-trainer.firebaseapp.com",
    projectId: "run-walk-trainer",
    storageBucket: "run-walk-trainer.firebasestorage.app",
    messagingSenderId: "941697098071",
    appId: "1:941697098071:web:5b2a19251d1b9c94f85e12"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const firestore = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

export {
    auth, firestore, googleProvider,
    signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged,
    collection, addDoc, getDocs, deleteDoc, doc, query, orderBy, serverTimestamp
};
