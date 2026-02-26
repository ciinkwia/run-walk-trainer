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

// Wall-clock timing (survives background throttling)
let startTimestamp = null;   // Date.now() when workout began
let pauseTimestamp = null;   // Date.now() when paused
let totalPausedMs = 0;       // cumulative ms spent paused

// Wake Lock (keeps screen on during workout)
let wakeLock = null;

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
// Wake Lock API — keep screen on during workout
// ============================================================
async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (err) {
        console.log('Wake Lock failed:', err.message);
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
    }
}

// Re-acquire wake lock when returning to the tab (browser releases it on hide)
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && isRunning && !isPaused) {
        // Force an immediate tick to catch up the timer
        tick();
        await acquireWakeLock();
    }
});

// ============================================================
// Voice System — pre-generated ElevenLabs audio clips
// ============================================================
// All coaching phrases are pre-generated as MP3 files in /audio/
// using ElevenLabs for natural, human-quality voice.
// Falls back to browser SpeechSynthesis if audio files not found.

const $btnTestVoice = document.getElementById('btn-test-voice');
const AUDIO_PATH = './audio/';

// Map every phrase to its audio filename
const AUDIO_CLIPS = {
    // Warm-up
    "warmup":           "warmup.mp3",
    // Run variants (8)
    "run_1":            "run_1.mp3",
    "run_2":            "run_2.mp3",
    "run_3":            "run_3.mp3",
    "run_4":            "run_4.mp3",
    "run_5":            "run_5.mp3",
    "run_6":            "run_6.mp3",
    "run_7":            "run_7.mp3",
    "run_8":            "run_8.mp3",
    // Walk variants (8)
    "walk_1":           "walk_1.mp3",
    "walk_2":           "walk_2.mp3",
    "walk_3":           "walk_3.mp3",
    "walk_4":           "walk_4.mp3",
    "walk_5":           "walk_5.mp3",
    "walk_6":           "walk_6.mp3",
    "walk_7":           "walk_7.mp3",
    "walk_8":           "walk_8.mp3",
    // Cooldown
    "cooldown":         "cooldown.mp3",
    // Countdown warnings
    "ready_run":        "ready_run.mp3",
    "ready_walk":       "ready_walk.mp3",
    "ready_switch":     "ready_switch.mp3",
    "nearly_there":     "nearly_there.mp3",
    // Controls
    "paused":           "paused.mp3",
    "resumed":          "resumed.mp3",
    "stopped":          "stopped.mp3",
    "completed":        "completed.mp3",
};

// Audio cache: preloaded Audio elements
const audioCache = {};
let audioReady = false;
let currentAudio = null;

// Preload all audio clips into memory
async function preloadAudio() {
    const entries = Object.entries(AUDIO_CLIPS);
    const results = await Promise.allSettled(
        entries.map(async ([key, file]) => {
            const audio = new Audio(AUDIO_PATH + file);
            audio.preload = 'auto';
            // Wait for it to be loadable
            await new Promise((resolve, reject) => {
                audio.oncanplaythrough = resolve;
                audio.onerror = reject;
                // Timeout after 5s
                setTimeout(resolve, 5000);
            });
            audioCache[key] = audio;
        })
    );

    const loaded = results.filter(r => r.status === 'fulfilled').length;
    audioReady = loaded > 0;
    console.log(`Audio: ${loaded}/${entries.length} clips loaded`);
}

// Play a clip by key
function playClip(key) {
    const vol = parseFloat($volumeSlider.value);
    if (vol === 0) return;

    // Stop any currently playing audio
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
    }

    const cached = audioCache[key];
    if (cached && audioReady) {
        cached.volume = vol;
        cached.currentTime = 0;
        currentAudio = cached;
        cached.play().catch(() => {
            // If playback fails, fall back to speech synthesis
            speakFallback(key);
        });
    } else {
        speakFallback(key);
    }
}

// Fallback text for each clip key (used if audio files are missing)
const FALLBACK_TEXT = {
    warmup:       "Let's begin. Warm up with a brisk walk.",
    run_1:        "Go! Run now!",
    run_2:        "Pick it up! Let's run!",
    run_3:        "Time to run. Push yourself!",
    run_4:        "Run! Give it everything!",
    run_5:        "Move! Run now, no excuses!",
    run_6:        "Let's go! Full effort!",
    run_7:        "Run! Stay strong!",
    run_8:        "Push it! Run hard!",
    walk_1:       "Walk. Recover.",
    walk_2:       "Ease off. Walk it out.",
    walk_3:       "Good work. Walk and breathe.",
    walk_4:       "Slow it down. Recover now.",
    walk_5:       "Walk. Control your breathing.",
    walk_6:       "Bring it down. Steady walk.",
    walk_7:       "Rest phase. Walk it off.",
    walk_8:       "Walk. You've earned this rest.",
    cooldown:     "Brilliant effort. Cool down. Slow your pace right down.",
    ready_run:    "Ready. Run in three.",
    ready_walk:   "Three seconds. Then walk.",
    ready_switch: "Switching in three.",
    nearly_there: "Nearly there. Three seconds.",
    paused:       "Paused. Take a moment.",
    resumed:      "Back to it. Let's go.",
    stopped:      "Session ended. Well done for showing up.",
    completed:    "That's it. Thirty minutes, done. Outstanding work.",
};

// Browser SpeechSynthesis fallback (if audio files not loaded)
function speakFallback(key) {
    const text = FALLBACK_TEXT[key] || key;
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-GB';
    utterance.rate = 0.92;
    utterance.pitch = 0.8;
    utterance.volume = parseFloat($volumeSlider.value);
    const voices = speechSynthesis.getVoices();
    const brit = voices.find(v => v.lang === 'en-GB') ||
                 voices.find(v => v.lang.startsWith('en'));
    if (brit) utterance.voice = brit;
    window.speechSynthesis.speak(utterance);
}

// Legacy speak() wrapper — used by non-phase code
function speak(clipKey) {
    playClip(clipKey);
}

// Test button
$btnTestVoice.addEventListener('click', () => {
    playClip('ready_run');
});

// Start preloading audio immediately
preloadAudio();

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
    switch (phase.type) {
        case 'warmup':
            playClip('warmup');
            break;
        case 'run':
            playClip('run_' + (Math.floor(Math.random() * 8) + 1));
            break;
        case 'walk':
            playClip('walk_' + (Math.floor(Math.random() * 8) + 1));
            break;
        case 'cooldown':
            playClip('cooldown');
            break;
    }
}

// ============================================================
// Timer tick — wall-clock based
// ============================================================
function tick() {
    if (!isRunning || isPaused) return;

    const now = Date.now();
    const realElapsed = Math.floor((now - startTimestamp - totalPausedMs) / 1000);
    const prev = elapsedSeconds;
    elapsedSeconds = Math.min(realElapsed, TOTAL_DURATION);

    // If no time has actually passed, skip
    if (elapsedSeconds === prev) return;

    updateDisplay();

    // Check countdown warnings (only if we haven't jumped past them)
    const pi = getPhaseAt(elapsedSeconds);
    const phase = PHASES[pi];
    const phaseRemaining = phase.end - elapsedSeconds;
    if (phaseRemaining === 3 || (prev < phase.end - 3 && elapsedSeconds >= phase.end - 3 && phaseRemaining <= 3 && phaseRemaining > 0)) {
        if (pi < PHASES.length - 1) {
            const next = PHASES[pi + 1];
            if (next.type === 'run') {
                playClip('ready_run');
            } else if (next.type === 'walk') {
                playClip('ready_walk');
            } else {
                playClip('ready_switch');
            }
        } else {
            playClip('nearly_there');
        }
    }

    if (elapsedSeconds >= TOTAL_DURATION) {
        completeWorkout();
    }
}

// ============================================================
// Controls
// ============================================================
async function startWorkout() {
    if (isRunning) return;

    elapsedSeconds = 0;
    currentPhaseIndex = -1;
    isRunning = true;
    isPaused = false;
    sessionStartTime = new Date();
    startTimestamp = Date.now();
    totalPausedMs = 0;
    pauseTimestamp = null;

    buildProgressBar();
    updateDisplay();

    // Use 250ms interval for snappy catch-up (wall-clock does the math)
    timerInterval = setInterval(tick, 250);

    $btnStart.disabled = true;
    $btnPause.disabled = false;
    $btnStop.disabled = false;

    await acquireWakeLock();
}

async function pauseWorkout() {
    if (!isRunning) return;

    if (isPaused) {
        // Resume — account for time spent paused
        totalPausedMs += Date.now() - pauseTimestamp;
        pauseTimestamp = null;
        isPaused = false;
        timerInterval = setInterval(tick, 250);
        $btnPause.textContent = 'PAUSE';
        playClip('resumed');
        await acquireWakeLock();
    } else {
        // Pause
        pauseTimestamp = Date.now();
        isPaused = true;
        clearInterval(timerInterval);
        timerInterval = null;
        $btnPause.textContent = 'RESUME';
        playClip('paused');
        releaseWakeLock();
    }
}

function stopWorkout() {
    if (!isRunning) return;
    clearInterval(timerInterval);
    timerInterval = null;

    playClip('stopped');
    releaseWakeLock();

    saveSession(false);
    resetUI();
}

function completeWorkout() {
    clearInterval(timerInterval);
    timerInterval = null;

    playClip('completed');
    releaseWakeLock();

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
