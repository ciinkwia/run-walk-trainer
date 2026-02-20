// ============================================================
// Workout Structure
// ============================================================
// Total: 30 minutes (1800 seconds)
// Warm-up:  0:00 - 5:00  (300s)
// Intervals: 5:00 - 25:00 (1200s) — 60s run / 90s walk, repeating
// Cool-down: 25:00 - 30:00 (300s)

const TOTAL_DURATION = 1800; // 30 minutes in seconds
const WARMUP_END = 300;      // 5 min
const INTERVAL_END = 1500;   // 25 min
const RUN_DURATION = 60;
const WALK_DURATION = 90;

// ============================================================
// Build phase schedule (precompute every phase boundary)
// ============================================================
function buildPhaseSchedule() {
    const phases = [];
    // Warm-up
    phases.push({ type: 'warmup', label: 'Warm Up', start: 0, end: WARMUP_END });

    // Intervals
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

    // Cool-down
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

const RING_CIRCUMFERENCE = 2 * Math.PI * 90; // ~565.48

// ============================================================
// Voice / Speech Synthesis
// ============================================================
let preferredVoice = null;

function findBestVoice() {
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return null;

    // Priority list: prefer natural/premium male English (British) voices
    const priorities = [
        // Microsoft Edge / Windows natural voices
        (v) => /\b(Ryan|George)\b/i.test(v.name) && /Natural/i.test(v.name),
        // Google UK English Male
        (v) => /Google UK English Male/i.test(v.name),
        // Any British English male natural voice
        (v) => v.lang.startsWith('en-GB') && /male|ryan|george|daniel|james/i.test(v.name),
        // Any English natural/enhanced voice (male-sounding names)
        (v) => v.lang.startsWith('en') && /Natural|Enhanced|Premium/i.test(v.name) && /male|ryan|george|daniel|james|david/i.test(v.name),
        // Any British English voice
        (v) => v.lang.startsWith('en-GB'),
        // Any English voice with "Natural" or "Enhanced"
        (v) => v.lang.startsWith('en') && /Natural|Enhanced|Premium/i.test(v.name),
        // Fallback: any English voice
        (v) => v.lang.startsWith('en'),
    ];

    for (const test of priorities) {
        const match = voices.find(test);
        if (match) return match;
    }
    return null;
}

// Voices load asynchronously on some browsers
if ('speechSynthesis' in window) {
    preferredVoice = findBestVoice();
    speechSynthesis.addEventListener('voiceschanged', () => {
        preferredVoice = findBestVoice();
    });
}

function speak(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (preferredVoice) utterance.voice = preferredVoice;
    utterance.rate = 0.95;
    utterance.pitch = 0.9;
    utterance.volume = parseFloat($volumeSlider.value);
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
    return PHASES.length - 1; // last phase
}

// ============================================================
// Update display
// ============================================================
function updateDisplay() {
    const remaining = TOTAL_DURATION - elapsedSeconds;
    $timerDisplay.textContent = fmt(remaining);
    $elapsed.textContent = fmt(elapsedSeconds);
    $remaining.textContent = fmt(remaining);

    // Ring progress (counts down)
    const offset = RING_CIRCUMFERENCE * (1 - elapsedSeconds / TOTAL_DURATION);
    $ringProgress.style.strokeDasharray = RING_CIRCUMFERENCE;
    $ringProgress.style.strokeDashoffset = offset;

    // Phase detection
    const pi = getPhaseAt(elapsedSeconds);
    const phase = PHASES[pi];
    const phaseRemaining = phase.end - elapsedSeconds;

    $phaseLabel.textContent = phase.label;
    $phaseTimer.textContent = fmt(phaseRemaining);
    $currentPhase.textContent = phase.label;

    // Phase color class
    $ringContainer.className = 'timer-ring-container phase-active phase-' + phase.type;

    // Announce phase transitions
    if (pi !== currentPhaseIndex) {
        currentPhaseIndex = pi;
        announcePhase(phase);
    }

    updateProgressBar();
}

function announcePhase(phase) {
    const messages = {
        warmup: "Warm up. Start walking at a comfortable pace.",
        run: "Run! Pick up the pace.",
        walk: "Walk. Slow it down and recover.",
        cooldown: "Cool down. Great job! Slow your pace."
    };
    speak(messages[phase.type]);
}

// ============================================================
// Timer tick
// ============================================================
function tick() {
    elapsedSeconds++;
    updateDisplay();

    // Countdown warnings at 3 seconds before phase ends
    const pi = getPhaseAt(elapsedSeconds);
    const phase = PHASES[pi];
    const phaseRemaining = phase.end - elapsedSeconds;
    if (phaseRemaining === 3) {
        if (pi < PHASES.length - 1) {
            const next = PHASES[pi + 1];
            speak("Get ready to " + (next.type === 'run' ? 'run' : next.type === 'walk' ? 'walk' : next.label.toLowerCase()));
        } else {
            speak("Almost done! 3 seconds left.");
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

    // Fresh start
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
        // Resume
        isPaused = false;
        timerInterval = setInterval(tick, 1000);
        $btnPause.textContent = 'PAUSE';
        speak("Resumed.");
    } else {
        // Pause
        isPaused = true;
        clearInterval(timerInterval);
        timerInterval = null;
        $btnPause.textContent = 'RESUME';
        speak("Paused.");
    }
}

function stopWorkout() {
    if (!isRunning) return;
    clearInterval(timerInterval);
    timerInterval = null;

    speak("Workout stopped.");

    saveSession(false);
    resetUI();
}

function completeWorkout() {
    clearInterval(timerInterval);
    timerInterval = null;

    speak("Workout complete! Amazing job!");

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
// IndexedDB — long-term storage
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

    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).add(session);
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    } catch (err) {
        console.error('Failed to save session:', err);
    }
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
// History rendering
// ============================================================
async function getAllSessions() {
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

async function renderHistory() {
    const sessions = await getAllSessions();

    if (sessions.length === 0) {
        $historyList.innerHTML = '<p class="empty-msg">No workouts yet. Start your first session!</p>';
        return;
    }

    // Sort newest first
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
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
        renderHistory();
    } catch (err) {
        console.error('Failed to clear history:', err);
    }
}

$btnClear.addEventListener('click', clearHistory);

// ============================================================
// Init
// ============================================================
buildProgressBar();

// Add legend above progress bar
const legendHTML = `
<div class="progress-legend">
    <div class="legend-item"><div class="legend-dot" style="background:var(--warmup)"></div>Warm Up</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--run)"></div>Run</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--walk)"></div>Walk</div>
    <div class="legend-item"><div class="legend-dot" style="background:var(--cooldown)"></div>Cool Down</div>
</div>`;
document.querySelector('.progress-bar-container').insertAdjacentHTML('beforebegin', legendHTML);
