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

// Skip controls DOM
const $skipControls = document.getElementById('skip-controls');
const $btnPrev      = document.getElementById('btn-prev');
const $btnNext      = document.getElementById('btn-next');

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
        // Defensive: some browsers may suspend AudioContext on hide
        if (audioCtx && audioCtx.state === 'suspended') {
            try { await audioCtx.resume(); } catch {}
        }
    }
});

// ============================================================
// Voice System — pre-generated ElevenLabs audio clips via Web Audio API
// ============================================================
// All coaching phrases are pre-generated MP3s in /audio/. Played through
// Web Audio API so cues can be PRE-SCHEDULED at workout start using
// AudioContext.currentTime — sample-accurate scheduling that fires even
// when Android Chrome background-throttles JS timers (the bug that
// made phase-switch announcements miss while the screen was off).
// SpeechSynthesis fallback if a clip fails to load/decode.

const $btnTestVoice = document.getElementById('btn-test-voice');
const AUDIO_PATH = './audio/';

const AUDIO_CLIPS = {
    "warmup":       "warmup.mp3",
    "run_1":        "run_1.mp3",
    "run_2":        "run_2.mp3",
    "run_3":        "run_3.mp3",
    "run_4":        "run_4.mp3",
    "run_5":        "run_5.mp3",
    "run_6":        "run_6.mp3",
    "run_7":        "run_7.mp3",
    "run_8":        "run_8.mp3",
    "walk_1":       "walk_1.mp3",
    "walk_2":       "walk_2.mp3",
    "walk_3":       "walk_3.mp3",
    "walk_4":       "walk_4.mp3",
    "walk_5":       "walk_5.mp3",
    "walk_6":       "walk_6.mp3",
    "walk_7":       "walk_7.mp3",
    "walk_8":       "walk_8.mp3",
    "cooldown":     "cooldown.mp3",
    "ready_run":    "ready_run.mp3",
    "ready_walk":   "ready_walk.mp3",
    "ready_switch": "ready_switch.mp3",
    "nearly_there": "nearly_there.mp3",
    "paused":       "paused.mp3",
    "resumed":      "resumed.mp3",
    "stopped":      "stopped.mp3",
    "completed":    "completed.mp3",
};

let audioCtx = null;
let audioGain = null;
let silentSource = null;
const audioRawBuffers = {};       // key -> ArrayBuffer (fetched MP3 bytes)
const audioBuffers = {};          // key -> AudioBuffer (decoded)
let audioFetched = false;
let audioDecoded = false;
let scheduledSources = [];        // BufferSourceNodes scheduled for the workout
let currentImmediateSource = null;

async function fetchAllAudio() {
    const entries = Object.entries(AUDIO_CLIPS);
    const results = await Promise.allSettled(entries.map(async ([key, file]) => {
        const res = await fetch(AUDIO_PATH + file);
        if (!res.ok) throw new Error('fetch failed: ' + file);
        audioRawBuffers[key] = await res.arrayBuffer();
    }));
    const ok = results.filter(r => r.status === 'fulfilled').length;
    audioFetched = ok > 0;
    console.log(`Audio fetched: ${ok}/${entries.length}`);
}

async function ensureAudioCtx() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioGain = audioCtx.createGain();
        audioGain.gain.value = parseFloat($volumeSlider.value);
        audioGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    return audioCtx;
}

async function decodeAllAudio() {
    if (audioDecoded) return;
    await ensureAudioCtx();
    await Promise.all(Object.entries(audioRawBuffers).map(async ([key, raw]) => {
        if (audioBuffers[key]) return;
        try {
            audioBuffers[key] = await audioCtx.decodeAudioData(raw.slice(0));
        } catch (err) {
            console.warn('decode failed:', key, err);
        }
    }));
    audioDecoded = true;
}

// ============================================================
// Chime synthesis — pleasant two-tone bells generated via Web Audio
// (no MP3 round-trip; ~1KB of code instead of two extra audio files)
// ============================================================
function synthesizeBellBuffer(freq1, freq2, durationSec) {
    const sr = audioCtx.sampleRate;
    const length = Math.floor(sr * durationSec);
    const buf = audioCtx.createBuffer(1, length, sr);
    const data = buf.getChannelData(0);
    const tone2Start = 0.18;  // 2nd note enters 180ms after the 1st

    for (let i = 0; i < length; i++) {
        const t = i / sr;
        let sample = 0;
        // Tone 1 — fundamental + 2nd & 3rd harmonics, exponential decay envelope
        const t1 = t;
        const env1 = Math.exp(-2.8 * t1) * (1 - Math.exp(-300 * t1));
        sample += env1 * (
            0.60 * Math.sin(2 * Math.PI * freq1     * t1) +
            0.25 * Math.sin(2 * Math.PI * freq1 * 2 * t1) +
            0.10 * Math.sin(2 * Math.PI * freq1 * 3 * t1)
        );
        // Tone 2 — same shape, delayed
        if (t >= tone2Start) {
            const t2 = t - tone2Start;
            const env2 = Math.exp(-2.8 * t2) * (1 - Math.exp(-300 * t2));
            sample += env2 * (
                0.60 * Math.sin(2 * Math.PI * freq2     * t2) +
                0.25 * Math.sin(2 * Math.PI * freq2 * 2 * t2) +
                0.10 * Math.sin(2 * Math.PI * freq2 * 3 * t2)
            );
        }
        data[i] = sample * 0.35;
    }
    return buf;
}

function generateChimeBuffers() {
    if (!audioCtx) return;
    if (audioBuffers['chime_run'] && audioBuffers['chime_walk']) return;
    // Ascending G5 → C6 — energetic, "gear up"
    audioBuffers['chime_run']  = synthesizeBellBuffer(784, 1047, 1.0);
    // Descending C6 → G5 — calming, "ease down" (also used for warmup/cooldown)
    audioBuffers['chime_walk'] = synthesizeBellBuffer(1047, 784, 1.0);
}

function chimeKeyFor(phaseType) {
    return phaseType === 'run' ? 'chime_run' : 'chime_walk';
}

// Fire-and-forget chime (does NOT interrupt currentImmediateSource — chime
// and voice announcement layer cleanly when called back-to-back)
function playChimeNow(key) {
    if (!audioCtx || !audioBuffers[key]) return;
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuffers[key];
    src.connect(audioGain);
    src.start();
}

// Silent looping buffer keeps the AudioContext "active" so MediaSession
// stays engaged (lock-screen controls + reduced chance of OS killing tab).
function startSilentKeepalive() {
    if (silentSource || !audioCtx) return;
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
    silentSource = audioCtx.createBufferSource();
    silentSource.buffer = buf;
    silentSource.loop = true;
    silentSource.connect(audioCtx.destination);
    silentSource.start();
}

function stopSilentKeepalive() {
    if (silentSource) {
        try { silentSource.stop(); } catch {}
        silentSource = null;
    }
}

// Play a clip immediately (paused/resumed/stopped/completed/test/skip-into-phase)
function playClip(key) {
    if (!audioCtx || !audioBuffers[key]) {
        speakFallback(key);
        return;
    }
    if (currentImmediateSource) {
        try { currentImmediateSource.stop(); } catch {}
    }
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuffers[key];
    src.connect(audioGain);
    src.start();
    currentImmediateSource = src;
    src.onended = () => {
        if (currentImmediateSource === src) currentImmediateSource = null;
    };
}

function scheduleCueAt(key, when) {
    const buf = audioBuffers[key];
    if (!buf || !audioCtx) return null;
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioGain);
    try { src.start(when); }
    catch { src.start(audioCtx.currentTime); }
    scheduledSources.push(src);
    src.onended = () => {
        const i = scheduledSources.indexOf(src);
        if (i >= 0) scheduledSources.splice(i, 1);
    };
    return src;
}

function cancelAllScheduled() {
    scheduledSources.forEach(s => { try { s.stop(0); } catch {} });
    scheduledSources = [];
}

// Build the cue event list starting at fromSec. Each phase boundary gets:
//   1. Chime (immediate, at p.start)             — the unmissable switch cue
//   2. Voice announcement (~500ms after chime)   — tells you which phase
// Pre-3s-warning voice cues (ready_run/walk/switch, nearly_there) were
// removed in v8 to cut chatter — the chime IS the cue.
function buildCueEvents(fromSec) {
    const events = [];
    for (let i = 0; i < PHASES.length; i++) {
        const p = PHASES[i];
        if (p.start >= fromSec) {
            // Chime — exactly at phase boundary
            events.push({
                offsetSec: p.start - fromSec,
                key: chimeKeyFor(p.type)
            });
            // Voice — slight delay so chime hits crisp first
            let voiceKey;
            switch (p.type) {
                case 'warmup':   voiceKey = 'warmup'; break;
                case 'run':      voiceKey = 'run_'  + (Math.floor(Math.random() * 8) + 1); break;
                case 'walk':     voiceKey = 'walk_' + (Math.floor(Math.random() * 8) + 1); break;
                case 'cooldown': voiceKey = 'cooldown'; break;
            }
            events.push({
                offsetSec: (p.start - fromSec) + 0.5,
                key: voiceKey
            });
        }
    }
    return events;
}

function scheduleAllCues(fromSec) {
    cancelAllScheduled();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    for (const ev of buildCueEvents(fromSec)) {
        scheduleCueAt(ev.key, t0 + ev.offsetSec);
    }
}

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

// Volume slider drives the master gain in real time
$volumeSlider.addEventListener('input', () => {
    if (audioGain) audioGain.gain.value = parseFloat($volumeSlider.value);
});

// Test button — preview a real switch: chime + voice, just like mid-workout
$btnTestVoice.addEventListener('click', async () => {
    await ensureAudioCtx();
    await decodeAllAudio();
    generateChimeBuffers();
    playChimeNow('chime_run');
    setTimeout(() => playClip('run_1'), 500);
});

// ============================================================
// MediaSession — lock-screen metadata + transport controls
// ============================================================
function setupMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.setActionHandler('play',  () => { if (isRunning && isPaused)  pauseWorkout(); });
        navigator.mediaSession.setActionHandler('pause', () => { if (isRunning && !isPaused) pauseWorkout(); });
        navigator.mediaSession.setActionHandler('stop',  () => { if (isRunning) stopWorkout(); });
    } catch {}
}

function updateMediaSession(refreshMetadata = false) {
    if (!('mediaSession' in navigator)) return;
    if (!isRunning) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
        return;
    }
    if (refreshMetadata) {
        const pi = getPhaseAt(elapsedSeconds);
        const phase = PHASES[pi];
        navigator.mediaSession.metadata = new MediaMetadata({
            title:  phase.label,
            artist: 'Run/Walk Trainer',
            album:  '30-minute interval session',
            artwork: [
                { src: 'icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
                { src: 'icon-512.svg', sizes: '512x512', type: 'image/svg+xml' },
            ]
        });
    }
    navigator.mediaSession.playbackState = isPaused ? 'paused' : 'playing';
    if ('setPositionState' in navigator.mediaSession) {
        try {
            navigator.mediaSession.setPositionState({
                duration: TOTAL_DURATION,
                position: Math.min(elapsedSeconds, TOTAL_DURATION),
                playbackRate: 1
            });
        } catch {}
    }
}

// Kick off audio fetch + register MediaSession handlers
fetchAllAudio();
setupMediaSessionHandlers();

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
        updateMediaSession(true);   // lock-screen title now reflects current phase
    } else {
        updateMediaSession(false);  // refresh position only
    }

    updateProgressBar();
}

// Used when the user skips into the middle of a phase (scheduled cue won't fire
// because the phase already started before the new fromSec). Plays chime + voice
// just like a normal phase boundary.
function announcePhaseImmediate(phase) {
    playChimeNow(chimeKeyFor(phase.type));
    let voiceKey;
    switch (phase.type) {
        case 'warmup':   voiceKey = 'warmup'; break;
        case 'run':      voiceKey = 'run_'  + (Math.floor(Math.random() * 8) + 1); break;
        case 'walk':     voiceKey = 'walk_' + (Math.floor(Math.random() * 8) + 1); break;
        case 'cooldown': voiceKey = 'cooldown'; break;
    }
    setTimeout(() => playClip(voiceKey), 500);
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

    if (elapsedSeconds === prev) return;

    updateDisplay();

    // NOTE: phase announcements + 3s warnings are pre-scheduled via Web Audio
    // in scheduleAllCues() at workout/resume/skip time — no audio fired here.
    // This is what makes cues fire on time when Android background-throttles
    // this setInterval (down to ~1Hz when the tab is hidden).

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

    // Bring up Web Audio (we're inside a user gesture — required for AudioContext)
    await ensureAudioCtx();
    await decodeAllAudio();
    generateChimeBuffers();
    startSilentKeepalive();
    scheduleAllCues(0);     // pre-schedules chimes + voice for every phase boundary

    updateDisplay();         // also fires updateMediaSession(true) since phase index changed
    timerInterval = setInterval(tick, 250);

    $btnStart.disabled = true;
    $btnPause.disabled = false;
    $btnStop.disabled = false;
    $skipControls.style.display = 'flex';

    await acquireWakeLock();
}

async function pauseWorkout() {
    if (!isRunning) return;

    if (isPaused) {
        // Resume — account for time spent paused, then re-schedule cues from current position
        totalPausedMs += Date.now() - pauseTimestamp;
        pauseTimestamp = null;
        isPaused = false;
        timerInterval = setInterval(tick, 250);
        $btnPause.textContent = 'PAUSE';
        await ensureAudioCtx();
        playClip('resumed');
        scheduleAllCues(elapsedSeconds);
        await acquireWakeLock();
        updateMediaSession(true);
    } else {
        // Pause — cancel pending cues so they don't fire while paused
        pauseTimestamp = Date.now();
        isPaused = true;
        clearInterval(timerInterval);
        timerInterval = null;
        $btnPause.textContent = 'RESUME';
        cancelAllScheduled();
        playClip('paused');
        releaseWakeLock();
        updateMediaSession(false);
    }
}

function stopWorkout() {
    if (!isRunning) return;
    clearInterval(timerInterval);
    timerInterval = null;
    cancelAllScheduled();

    playClip('stopped');
    releaseWakeLock();
    stopSilentKeepalive();

    saveSession(false);
    resetUI();
    updateMediaSession(false);   // clears lock-screen metadata (isRunning is false now)
}

function completeWorkout() {
    clearInterval(timerInterval);
    timerInterval = null;
    cancelAllScheduled();

    playClip('completed');
    releaseWakeLock();
    stopSilentKeepalive();

    saveSession(true);
    resetUI();
    updateMediaSession(false);
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
    $skipControls.style.display = 'none';

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
// Skip / Rewind
// ============================================================
function jumpToSecond(targetSec) {
    targetSec = Math.max(0, Math.min(targetSec, TOTAL_DURATION));
    // Adjust totalPausedMs so wall-clock formula yields the target
    totalPausedMs = Date.now() - startTimestamp - targetSec * 1000;
    elapsedSeconds = targetSec;
    currentPhaseIndex = -1; // force MediaSession metadata refresh in updateDisplay
    updateDisplay();

    if (isRunning && !isPaused) {
        scheduleAllCues(targetSec);
        // If we jumped INTO the middle of a phase, the scheduler won't include
        // that phase's start announcement — fire it immediately.
        const pi = getPhaseAt(targetSec);
        const phase = PHASES[pi];
        if (targetSec > phase.start) {
            announcePhaseImmediate(phase);
        }
    }
}

function skipNext() {
    if (!isRunning) return;
    const pi = getPhaseAt(elapsedSeconds);
    if (pi < PHASES.length - 1) {
        jumpToSecond(PHASES[pi + 1].start);
    }
}

function skipPrev() {
    if (!isRunning) return;
    const pi = getPhaseAt(elapsedSeconds);
    const phase = PHASES[pi];
    const intoPhase = elapsedSeconds - phase.start;
    // If more than 3s into current phase, restart it; otherwise go to previous
    if (intoPhase > 3 && pi >= 0) {
        jumpToSecond(phase.start);
    } else if (pi > 0) {
        jumpToSecond(PHASES[pi - 1].start);
    } else {
        jumpToSecond(0);
    }
}

$btnPrev.addEventListener('click', skipPrev);
$btnNext.addEventListener('click', skipNext);

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
