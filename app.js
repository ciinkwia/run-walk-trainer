// ============================================================
// Firebase imports
// ============================================================
import {
    auth, firestore, googleProvider,
    signInWithPopup, signOut, onAuthStateChanged,
    collection, addDoc, getDocs, deleteDoc, doc, query, orderBy, serverTimestamp
} from './firebase-config.js';

// ============================================================
// Workout Structure
// ============================================================
// Total: 30 minutes (1800 seconds)
// Warm-up:  0:00 - 5:00  (300s)
// Intervals: 5:00 - 25:00 (1200s) — 60s run / 90s walk, repeating
// Cool-down: 25:00 - 30:00 (300s)

const TOTAL_DURATION = 1800;
const WARMUP_END = 300;
const INTERVAL_END = 1500;
const RUN_DURATION = 60;
const WALK_DURATION = 90;

// ============================================================
// Build phase schedule
// ============================================================
function buildPhaseSchedule() {
    const phases = [];
    phases.push({ type: 'warmup', label: 'Warm Up', start: 0, end: WARMUP_END });

    let t = WARMUP_END;
    while (t < INTERVAL_END) {
        const runEnd = Math.min(t + RUN_DURATION, INTERVAL_END);
        phases.push({ type: 'run', label: 'Run', start: t, end: runEnd });
        t = runEnd;
        if (t < INTERVAL_END) {
            const walkEnd = Math.min(t + WALK_DURATION, INTERVAL_END);
            phases.push({ type: 'walk', label: 'Walk', start: t, end: walkEnd });
            t = walkEnd;
        }
    }

    phases.push({ type: 'cooldown', label: 'Cool Down', start: INTERVAL_END, end: TOTAL_DURATION });
    return phases;
}

const PHASES = buildPhaseSchedule();

// ============================================================
// DOM references
// ============================================================
const $phaseLabel   = document.getElementById('phase-label');
const $timerDisplay = document.getElementById('timer-display');
const $phaseTimer   = document.getElementById('phase-timer');
const $elapsed      = document.getElementById('elapsed-time');
const $remaining    = document.getElementById('remaining-time');
const $currentPhase = document.getElementById('current-phase');
const $progressSegs = document.getElementById('progress-segments');
const $progressMark = document.getElementById('progress-marker');
const $ringProgress = document.querySelector('.timer-ring-progress');
const $ringContainer= document.querySelector('.timer-ring-container');
const $btnStart     = document.getElementById('btn-start');
const $btnPause     = document.getElementById('btn-pause');
const $btnStop      = document.getElementById('btn-stop');
const $volumeSlider = document.getElementById('volume-slider');
const $historyList  = document.getElementById('history-list');
const $btnClear     = document.getElementById('btn-clear-history');

// Auth DOM
const $btnSignIn    = document.getElementById('btn-sign-in');
const $btnSignOut   = document.getElementById('btn-sign-out');
const $userInfo     = document.getElementById('user-info');
const $userName     = document.getElementById('user-name');
const $userAvatar   = document.getElementById('user-avatar');
const $syncStatus   = document.getElementById('sync-status');
const $syncText     = document.getElementById('sync-text');
const $syncDot      = document.querySelector('.sync-dot');

// Nav
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.view + '-view').classList.add('active');
        if (btn.dataset.view === 'history') renderHistory();
    });
});

// ============================================================
// State
// ============================================================
let elapsedSeconds = 0;
let timerInterval = null;
let isRunning = false;
let isPaused = false;
let currentPhaseIndex = -1;
let sessionStartTime = null;

const RING_CIRCUMFERENCE = 2 * Math.PI * 90;

// ============================================================
// Auth state
// ============================================================
let currentUser = null;
let isOnline = navigator.onLine;

window.addEventListener('online', () => {
    isOnline = true;
    updateSyncStatus('synced');
    if (currentUser) syncLocalToCloud();
});

window.addEventListener('offline', () => {
    isOnline = false;
    updateSyncStatus('offline');
});

// ============================================================
// Voice System — selectable voices + Google TTS option
// ============================================================
const GOOGLE_TTS_KEY = '__google_tts__';
const $voiceSelect = document.getElementById('voice-select');
const $btnTestVoice = document.getElementById('btn-test-voice');

let selectedVoiceId = localStorage.getItem('rw_voice') || GOOGLE_TTS_KEY;
let audioPlaying = null;

// Populate voice dropdown with all available browser voices + Google TTS
function populateVoiceList() {
    const voices = ('speechSynthesis' in window) ? speechSynthesis.getVoices() : [];

    // Remember current selection
    const current = $voiceSelect.value || selectedVoiceId;

    // Clear and rebuild
    $voiceSelect.innerHTML = '';

    // Google TTS option always first
    const gttsOpt = document.createElement('option');
    gttsOpt.value = GOOGLE_TTS_KEY;
    gttsOpt.textContent = 'Google TTS (British)';
    $voiceSelect.appendChild(gttsOpt);

    // Group voices by language
    const english = voices.filter(v => v.lang.startsWith('en'));

    // Sort: en-GB first, then en-US, then others. Within each, "Natural/Enhanced" first
    english.sort((a, b) => {
        const aGB = a.lang === 'en-GB' ? 0 : a.lang === 'en-US' ? 1 : 2;
        const bGB = b.lang === 'en-GB' ? 0 : b.lang === 'en-US' ? 1 : 2;
        if (aGB !== bGB) return aGB - bGB;
        const aNat = /Natural|Enhanced|Premium/i.test(a.name) ? 0 : 1;
        const bNat = /Natural|Enhanced|Premium/i.test(b.name) ? 0 : 1;
        if (aNat !== bNat) return aNat - bNat;
        return a.name.localeCompare(b.name);
    });

    if (english.length > 0) {
        const sep = document.createElement('option');
        sep.disabled = true;
        sep.textContent = '── Device Voices ──';
        $voiceSelect.appendChild(sep);
    }

    english.forEach((v, i) => {
        const opt = document.createElement('option');
        opt.value = `__voice_${i}`;
        opt.dataset.voiceUri = v.voiceURI;
        opt.dataset.lang = v.lang;
        // Clean up the display name
        let label = v.name.replace('Microsoft ', '').replace('Google ', '');
        const tag = v.lang === 'en-GB' ? 'UK' : v.lang === 'en-US' ? 'US' : v.lang.split('-')[1] || '';
        opt.textContent = `${label} (${tag})`;
        $voiceSelect.appendChild(opt);
    });

    // Restore selection
    const exists = Array.from($voiceSelect.options).some(o => o.value === current);
    $voiceSelect.value = exists ? current : GOOGLE_TTS_KEY;
    selectedVoiceId = $voiceSelect.value;
}

// Initialize voices
if ('speechSynthesis' in window) {
    populateVoiceList();
    speechSynthesis.addEventListener('voiceschanged', populateVoiceList);
}

$voiceSelect.addEventListener('change', () => {
    selectedVoiceId = $voiceSelect.value;
    localStorage.setItem('rw_voice', selectedVoiceId);
});

// Test button
$btnTestVoice.addEventListener('click', () => {
    speak("Ready. Run in three.");
});

// ============================================================
// Speak function — routes to Google TTS or browser voice
// ============================================================
function speak(text) {
    const vol = parseFloat($volumeSlider.value);
    if (vol === 0) return;

    // Stop anything currently playing
    if (audioPlaying) {
        audioPlaying.pause();
        audioPlaying = null;
    }
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }

    if (selectedVoiceId === GOOGLE_TTS_KEY) {
        speakGoogleTTS(text, vol);
    } else {
        speakBrowserVoice(text, vol);
    }
}

// Google Translate TTS — natural British English
function speakGoogleTTS(text, vol) {
    const encoded = encodeURIComponent(text);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en-GB&client=tw-ob&q=${encoded}`;

    const audio = new Audio(url);
    audio.volume = vol;
    audioPlaying = audio;

    audio.onended = () => { audioPlaying = null; };
    audio.onerror = () => {
        audioPlaying = null;
        // Fallback to any browser voice if Google TTS fails
        speakBrowserVoice(text, vol);
    };

    audio.play().catch(() => {
        audioPlaying = null;
        speakBrowserVoice(text, vol);
    });
}

// Browser SpeechSynthesis — uses the selected voice
function speakBrowserVoice(text, vol) {
    if (!('speechSynthesis' in window)) return;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = vol;
    utterance.rate = 0.92;
    utterance.pitch = 0.8;

    // Find the selected voice by voiceURI
    const selectedOption = $voiceSelect.selectedOptions[0];
    if (selectedOption && selectedOption.dataset.voiceUri) {
        const voices = speechSynthesis.getVoices();
        const match = voices.find(v => v.voiceURI === selectedOption.dataset.voiceUri);
        if (match) {
            utterance.voice = match;
            utterance.lang = match.lang;
        }
    } else {
        utterance.lang = 'en-GB';
    }

    window.speechSynthesis.speak(utterance);
}

// ============================================================
// Progress bar segments
// ============================================================
function buildProgressBar() {
    $progressSegs.innerHTML = '';
    PHASES.forEach(phase => {
        const pct = ((phase.end - phase.start) / TOTAL_DURATION) * 100;
        const seg = document.createElement('div');
        seg.className = `progress-segment ${phase.type} future`;
        seg.style.width = pct + '%';
        $progressSegs.appendChild(seg);
    });
}

function updateProgressBar() {
    const segments = $progressSegs.querySelectorAll('.progress-segment');
    segments.forEach((seg, i) => {
        if (elapsedSeconds >= PHASES[i].end) {
            seg.classList.remove('future');
        } else if (elapsedSeconds >= PHASES[i].start) {
            seg.classList.remove('future');
        } else {
            seg.classList.add('future');
        }
    });
    const pct = (elapsedSeconds / TOTAL_DURATION) * 100;
    $progressMark.style.left = pct + '%';
}

// ============================================================
// Format helpers
// ============================================================
function fmt(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ============================================================
// Get current phase
// ============================================================
function getPhaseAt(sec) {
    for (let i = 0; i < PHASES.length; i++) {
        if (sec >= PHASES[i].start && sec < PHASES[i].end) return i;
    }
    return PHASES.length - 1;
}

// ============================================================
// Update display
// ============================================================
function updateDisplay() {
    const remaining = TOTAL_DURATION - elapsedSeconds;
    $timerDisplay.textContent = fmt(remaining);
    $elapsed.textContent = fmt(elapsedSeconds);
    $remaining.textContent = fmt(remaining);

    const offset = RING_CIRCUMFERENCE * (1 - elapsedSeconds / TOTAL_DURATION);
    $ringProgress.style.strokeDasharray = RING_CIRCUMFERENCE;
    $ringProgress.style.strokeDashoffset = offset;

    const pi = getPhaseAt(elapsedSeconds);
    const phase = PHASES[pi];
    const phaseRemaining = phase.end - elapsedSeconds;

    $phaseLabel.textContent = phase.label;
    $phaseTimer.textContent = fmt(phaseRemaining);
    $currentPhase.textContent = phase.label;

    $ringContainer.className = 'timer-ring-container phase-active phase-' + phase.type;

    if (pi !== currentPhaseIndex) {
        currentPhaseIndex = pi;
        announcePhase(phase);
    }

    updateProgressBar();
}

function announcePhase(phase) {
    // Vary the messages to keep it fresh across intervals
    const runMessages = [
        "Go! Run now!",
        "Pick it up! Let's run!",
        "Time to run. Push yourself!",
        "Run! Give it everything!",
        "Move! Run now, no excuses!",
        "Let's go! Full effort!",
        "Run! Stay strong!",
        "Push it! Run hard!",
    ];
    const walkMessages = [
        "Walk. Recover.",
        "Ease off. Walk it out.",
        "Good work. Walk and breathe.",
        "Slow it down. Recover now.",
        "Walk. Control your breathing.",
        "Bring it down. Steady walk.",
        "Rest phase. Walk it off.",
        "Walk. You've earned this rest.",
    ];

    switch (phase.type) {
        case 'warmup':
            speak("Let's begin. Warm up with a brisk walk.");
            break;
        case 'run':
            speak(runMessages[Math.floor(Math.random() * runMessages.length)]);
            break;
        case 'walk':
            speak(walkMessages[Math.floor(Math.random() * walkMessages.length)]);
            break;
        case 'cooldown':
            speak("Brilliant effort. Cool down. Slow your pace right down.");
            break;
    }
}

// ============================================================
// Timer tick
// ============================================================
function tick() {
    elapsedSeconds++;
    updateDisplay();

    const pi = getPhaseAt(elapsedSeconds);
    const phase = PHASES[pi];
    const phaseRemaining = phase.end - elapsedSeconds;
    if (phaseRemaining === 3) {
        if (pi < PHASES.length - 1) {
            const next = PHASES[pi + 1];
            if (next.type === 'run') {
                speak("Ready. Run in three.");
            } else if (next.type === 'walk') {
                speak("Three seconds. Then walk.");
            } else {
                speak("Switching in three.");
            }
        } else {
            speak("Nearly there. Three seconds.");
        }
    }

    if (elapsedSeconds >= TOTAL_DURATION) {
        completeWorkout();
    }
}

// ============================================================
// Controls
// ============================================================
function startWorkout() {
    if (isRunning) return;

    elapsedSeconds = 0;
    currentPhaseIndex = -1;
    isRunning = true;
    isPaused = false;
    sessionStartTime = new Date();

    buildProgressBar();
    updateDisplay();

    timerInterval = setInterval(tick, 1000);

    $btnStart.disabled = true;
    $btnPause.disabled = false;
    $btnStop.disabled = false;
}

function pauseWorkout() {
    if (!isRunning) return;

    if (isPaused) {
        isPaused = false;
        timerInterval = setInterval(tick, 1000);
        $btnPause.textContent = 'PAUSE';
        speak("Back to it. Let's go.");
    } else {
        isPaused = true;
        clearInterval(timerInterval);
        timerInterval = null;
        $btnPause.textContent = 'RESUME';
        speak("Paused. Take a moment.");
    }
}

function stopWorkout() {
    if (!isRunning) return;
    clearInterval(timerInterval);
    timerInterval = null;

    speak("Session ended. Well done for showing up.");

    saveSession(false);
    resetUI();
}

function completeWorkout() {
    clearInterval(timerInterval);
    timerInterval = null;

    speak("That's it. Thirty minutes, done. Outstanding work.");

    saveSession(true);
    resetUI();
}

function resetUI() {
    isRunning = false;
    isPaused = false;
    elapsedSeconds = 0;
    currentPhaseIndex = -1;

    $btnStart.disabled = false;
    $btnPause.disabled = true;
    $btnStop.disabled = true;
    $btnPause.textContent = 'PAUSE';

    $phaseLabel.textContent = 'READY';
    $timerDisplay.textContent = '30:00';
    $phaseTimer.textContent = '';
    $elapsed.textContent = '00:00';
    $remaining.textContent = '30:00';
    $currentPhase.textContent = '--';
    $ringContainer.className = 'timer-ring-container';

    $ringProgress.style.strokeDasharray = RING_CIRCUMFERENCE;
    $ringProgress.style.strokeDashoffset = 0;

    buildProgressBar();
    $progressMark.style.left = '0%';
}

$btnStart.addEventListener('click', startWorkout);
$btnPause.addEventListener('click', pauseWorkout);
$btnStop.addEventListener('click', stopWorkout);

// ============================================================
// IndexedDB — local storage (offline-first)
// ============================================================
const DB_NAME = 'WorkoutTrainerDB';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('date', 'date', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function summarizePhases() {
    let runSeconds = 0;
    let walkSeconds = 0;
    let warmupSeconds = 0;
    let cooldownSeconds = 0;

    for (const phase of PHASES) {
        if (elapsedSeconds <= phase.start) break;
        const activeTime = Math.min(elapsedSeconds, phase.end) - phase.start;
        switch (phase.type) {
            case 'warmup':   warmupSeconds += activeTime; break;
            case 'run':      runSeconds += activeTime; break;
            case 'walk':     walkSeconds += activeTime; break;
            case 'cooldown': cooldownSeconds += activeTime; break;
        }
    }

    return { warmup: warmupSeconds, run: runSeconds, walk: walkSeconds, cooldown: cooldownSeconds };
}

// ============================================================
// Save session — dual write (IndexedDB + Firestore)
// ============================================================
async function saveSession(completed) {
    const session = {
        date: sessionStartTime.toISOString(),
        dateLabel: sessionStartTime.toLocaleDateString('en-US', {
            weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
        }),
        timeLabel: sessionStartTime.toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit'
        }),
        totalSeconds: elapsedSeconds,
        totalFormatted: fmt(elapsedSeconds),
        completed: completed,
        phases: summarizePhases()
    };

    // 1. Always save to IndexedDB (works offline)
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).add(session);
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    } catch (err) {
        console.error('Failed to save to IndexedDB:', err);
    }

    // 2. If signed in and online, also save to Firestore
    if (currentUser && isOnline) {
        await saveToFirestore(session);
    }
}

// ============================================================
// Firestore helpers
// ============================================================
async function saveToFirestore(session) {
    try {
        updateSyncStatus('syncing');
        const userSessionsRef = collection(firestore, 'users', currentUser.uid, 'sessions');
        await addDoc(userSessionsRef, {
            ...session,
            createdAt: serverTimestamp()
        });
        updateSyncStatus('synced');
    } catch (err) {
        console.error('Failed to save to Firestore:', err);
        updateSyncStatus('error');
    }
}

async function getCloudSessions() {
    try {
        const userSessionsRef = collection(firestore, 'users', currentUser.uid, 'sessions');
        const q = query(userSessionsRef, orderBy('date', 'desc'));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(d => ({
            firestoreId: d.id,
            ...d.data()
        }));
    } catch (err) {
        console.error('Failed to fetch from Firestore:', err);
        return [];
    }
}

async function clearFirestoreSessions() {
    try {
        const userSessionsRef = collection(firestore, 'users', currentUser.uid, 'sessions');
        const snapshot = await getDocs(userSessionsRef);
        const deletes = snapshot.docs.map(d =>
            deleteDoc(doc(firestore, 'users', currentUser.uid, 'sessions', d.id))
        );
        await Promise.all(deletes);
    } catch (err) {
        console.error('Failed to clear Firestore:', err);
    }
}

// ============================================================
// Sync functions
// ============================================================
async function syncLocalToCloud() {
    if (!currentUser || !isOnline) return;

    updateSyncStatus('syncing');

    try {
        const localSessions = await getLocalSessions();
        const cloudSessions = await getCloudSessions();

        // Find sessions in local but not in cloud (by date string)
        const cloudDates = new Set(cloudSessions.map(s => s.date));
        const toUpload = localSessions.filter(s => !cloudDates.has(s.date));

        for (const session of toUpload) {
            const { id, ...data } = session; // strip IndexedDB id
            await saveToFirestore(data);
        }

        updateSyncStatus('synced');
        console.log(`Synced ${toUpload.length} sessions to cloud`);
    } catch (err) {
        console.error('Sync to cloud failed:', err);
        updateSyncStatus('error');
    }
}

async function syncCloudToLocal() {
    if (!currentUser || !isOnline) return;

    try {
        const cloudSessions = await getCloudSessions();
        const localSessions = await getLocalSessions();

        const localDates = new Set(localSessions.map(s => s.date));
        const toDownload = cloudSessions.filter(s => !localDates.has(s.date));

        if (toDownload.length > 0) {
            const db = await openDB();
            for (const session of toDownload) {
                const { firestoreId, createdAt, ...localSession } = session;
                const tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).add(localSession);
                await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
            }
        }

        console.log(`Downloaded ${toDownload.length} sessions from cloud`);
    } catch (err) {
        console.error('Sync from cloud failed:', err);
    }
}

// ============================================================
// Get sessions (local + cloud merged)
// ============================================================
async function getLocalSessions() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        return new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch {
        return [];
    }
}

async function getAllSessions() {
    const localSessions = await getLocalSessions();

    // If not signed in or offline, return local only
    if (!currentUser || !isOnline) {
        return localSessions;
    }

    // Merge with cloud (local takes precedence on duplicates)
    try {
        const cloudSessions = await getCloudSessions();
        const merged = new Map();

        localSessions.forEach(s => merged.set(s.date, s));
        cloudSessions.forEach(s => {
            if (!merged.has(s.date)) {
                const { firestoreId, createdAt, ...clean } = s;
                merged.set(s.date, clean);
            }
        });

        return Array.from(merged.values());
    } catch {
        return localSessions;
    }
}

// ============================================================
// History rendering
// ============================================================
async function renderHistory() {
    const sessions = await getAllSessions();

    if (sessions.length === 0) {
        $historyList.innerHTML = '<p class="empty-msg">No workouts yet. Start your first session!</p>';
        return;
    }

    sessions.sort((a, b) => new Date(b.date) - new Date(a.date));

    $historyList.innerHTML = sessions.map(s => `
        <div class="history-entry ${s.completed ? '' : 'incomplete'}">
            <div class="history-date">${s.dateLabel} at ${s.timeLabel}</div>
            <div class="history-stats">
                <div class="history-stat">
                    <span class="history-stat-label">Status</span>
                    <span class="history-stat-value ${s.completed ? 'completed' : 'stopped'}">${s.completed ? 'Completed' : 'Stopped Early'}</span>
                </div>
                <div class="history-stat">
                    <span class="history-stat-label">Duration</span>
                    <span class="history-stat-value">${s.totalFormatted}</span>
                </div>
                <div class="history-stat">
                    <span class="history-stat-label">Running</span>
                    <span class="history-stat-value">${fmt(s.phases.run)}</span>
                </div>
                <div class="history-stat">
                    <span class="history-stat-label">Walking</span>
                    <span class="history-stat-value">${fmt(s.phases.walk)}</span>
                </div>
            </div>
        </div>
    `).join('');
}

async function clearHistory() {
    if (!confirm('Delete all workout history? This cannot be undone.')) return;

    // Clear IndexedDB
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    } catch (err) {
        console.error('Failed to clear IndexedDB:', err);
    }

    // Clear Firestore if signed in
    if (currentUser && isOnline) {
        await clearFirestoreSessions();
    }

    renderHistory();
}

$btnClear.addEventListener('click', clearHistory);

// ============================================================
// Auth UI
// ============================================================
function updateAuthUI() {
    if (currentUser) {
        $btnSignIn.style.display = 'none';
        $userInfo.style.display = 'flex';
        $userName.textContent = currentUser.displayName || 'User';
        $userAvatar.src = currentUser.photoURL || '';
        $syncStatus.style.display = 'flex';
        updateSyncStatus(isOnline ? 'synced' : 'offline');
    } else {
        $btnSignIn.style.display = 'flex';
        $userInfo.style.display = 'none';
        $syncStatus.style.display = 'none';
    }
}

function updateSyncStatus(state) {
    if (!$syncDot || !$syncText) return;
    switch (state) {
        case 'synced':
            $syncDot.className = 'sync-dot';
            $syncText.textContent = 'Synced';
            break;
        case 'syncing':
            $syncDot.className = 'sync-dot syncing';
            $syncText.textContent = 'Syncing...';
            break;
        case 'offline':
            $syncDot.className = 'sync-dot error';
            $syncText.textContent = 'Offline';
            break;
        case 'error':
            $syncDot.className = 'sync-dot error';
            $syncText.textContent = 'Sync failed';
            break;
    }
}

async function handleSignIn() {
    try {
        $btnSignIn.disabled = true;
        $btnSignIn.textContent = 'Signing in...';
        const result = await signInWithPopup(auth, googleProvider);
        currentUser = result.user;
        updateAuthUI();
        // Sync both directions
        await syncLocalToCloud();
        await syncCloudToLocal();
    } catch (err) {
        console.error('Sign-in error:', err);
        if (err.code !== 'auth/popup-closed-by-user') {
            alert('Sign-in failed. Please try again.');
        }
    } finally {
        $btnSignIn.disabled = false;
        $btnSignIn.innerHTML = `
            <svg viewBox="0 0 48 48" width="18" height="18"><path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            Sign In`;
    }
}

async function handleSignOut() {
    try {
        await signOut(auth);
        currentUser = null;
        updateAuthUI();
    } catch (err) {
        console.error('Sign-out error:', err);
    }
}

// Listen for auth state changes (persists across refreshes)
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    updateAuthUI();
    if (user && isOnline) {
        await syncCloudToLocal();
        await syncLocalToCloud();
    }
});

$btnSignIn.addEventListener('click', handleSignIn);
$btnSignOut.addEventListener('click', handleSignOut);

// ============================================================
// Init
// ============================================================
buildProgressBar();

const legendHTML = `
<div class="progress-legend">
    <div class="legend-item"><div class="legend-dot" style="background:var(--warmup)"></div>Warm Up</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--run)"></div>Run</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--walk)"></div>Walk</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--cooldown)"></div>Cool Down</div>
</div>`;
document.querySelector('.progress-bar-container').insertAdjacentHTML('beforebegin', legendHTML);
