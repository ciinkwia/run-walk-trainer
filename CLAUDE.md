# Run/Walk Interval Trainer

> **⚠️ INSTRUCTION TO CLAUDE:** This file is the source of truth for the project. **Any time we make a meaningful change to the Run/Walk Trainer — new feature, architectural decision, deploy gotcha, dependency change, file restructure, schema change, workout structure tweak, or hard-won bug fix — you must update this CLAUDE.md before considering the task done.** Treat it as part of the deliverable. Bump the "Last updated" date at the bottom every time you edit it. If you're unsure whether something is worth recording, record it.

---

A PWA that runs a **fixed 30-minute run/walk interval workout** with a ringed timer, color-coded phase bar, and pre-recorded Australian-female voice coaching (Microsoft Edge TTS, voice `en-AU-NatashaNeural`). Offline-first via IndexedDB with optional Google sign-in for Firestore cross-device sync.

**Owner:** ciinkwia (jarridbaldwin@gmail.com)
**Stack:** Vanilla HTML/CSS/JS (ES modules), Firebase Web SDK v11, IndexedDB, service worker
**Firebase project:** `run-walk-trainer` (separate from everything else)

---

## The workout (hardcoded in `app.js`)

30 minutes total = 1800s, split into three blocks:

1. **Warm-up** — 0:00 → 5:00 (300s)
2. **Intervals** — 5:00 → 25:00 (1200s)
   - Alternating **60s run / 90s walk**, repeating until the interval block ends
3. **Cool-down** — 25:00 → 30:00 (300s)

Constants at the top of `app.js`: `TOTAL_DURATION`, `WARMUP_END`, `INTERVAL_END`, `RUN_DURATION`, `WALK_DURATION`. **If you change these, re-record/re-generate audio clips if they reference specific times**, and update this file.

---

## Architecture

```
Browser (PWA, mobile-first, dark theme)
   │
   ├── Service Worker (sw.js, CACHE_NAME 'runwalk-v11')
   │     ├── App shell: index.html, style.css, app.js, firebase-config.js, manifest, icons
   │     └── Audio clips: ./audio/*.mp3 (warm-up, 8 run variants, 8 walk variants, cooldown, cues)
   │
   ├── app.js — single-file controller
   │     ├── Phase schedule (buildPhaseSchedule)
   │     ├── Wall-clock timer (startTimestamp + totalPausedMs, tick every 250ms)
   │     ├── Wake Lock API (keeps screen on; re-acquired on visibilitychange)
   │     ├── Web Audio engine (AudioContext, AudioBuffers, master gain, silent keep-alive)
   │     │     └── PRE-SCHEDULED cues — all phase announcements + 3s warnings
   │     │         scheduled via audioCtx.currentTime at workout start so they
   │     │         fire even when Android background-throttles JS timers
   │     ├── MediaSession metadata + handlers (lock-screen title/controls)
   │     ├── IndexedDB sessions store (WorkoutTrainerDB/sessions)
   │     ├── Firebase dual-write (IndexedDB first, Firestore if signed in + online)
   │     └── Sync: bidirectional local↔cloud merge on sign-in and on `online` event
   │
   ├── firebase-config.js — Firebase v11 modular SDK, Google auth + Firestore
   │
   └── audio/*.mp3 — pre-generated ElevenLabs British-voice coaching clips
```

Single HTML file, one JS file, one CSS file. No framework, no build step.

---

## Timer design (important)

The timer is **wall-clock based**, NOT an accumulating counter. This is critical because mobile browsers throttle background tabs and `setInterval` drifts.

```js
startTimestamp       // Date.now() when workout began
totalPausedMs        // cumulative ms spent paused
realElapsed = (Date.now() - startTimestamp - totalPausedMs) / 1000
```

`setInterval(tick, 250)` just re-reads the wall clock and updates the UI. If the tab sleeps and the user returns, one `tick()` catches everything up instantly.

`visibilitychange` listener forces an immediate `tick()` and re-acquires the wake lock when the tab becomes visible. Don't break this — it's what makes the app usable when the phone locks/unlocks mid-workout.

**Skip/rewind** (`jumpToSecond`) works by rewriting `totalPausedMs` so that the wall-clock formula yields the target second. `currentPhaseIndex = -1` forces a re-announce.

---

## Audio / voice (Web Audio API, pre-scheduled, chime + voice layered)

All coaching lines are **pre-generated MP3s in `audio/`** using **Microsoft Edge TTS, voice `en-AU-NatashaNeural`** (Australian female, friendly + positive — coach-y). Free, no API key. Re-generate any time by editing `lines` in `C:\Users\jarri\AI Projects\agentmail\generate_runwalk_audio.py` and running `python generate_runwalk_audio.py` (requires `pip install edge-tts`). Played through the **Web Audio API**, not `<Audio>` elements — this is critical for the background-cue fix below.

**Voice clips** (defined in `AUDIO_CLIPS` map in `app.js`):
- `warmup`, `cooldown`
- `run_1` ... `run_8` — 8 variants, randomly selected each run interval
- `walk_1` ... `walk_8` — 8 variants, randomly selected each walk interval
- `paused`, `resumed`, `stopped`, `completed` — control state announcements
- `ready_run`, `ready_walk`, `ready_switch`, `nearly_there` — **kept in audio/ but no longer scheduled** (v8 cut them — chime is the cue now). Removed from `buildCueEvents` but files remain on disk for possible future use.

**Chimes** (synthesized at runtime — no MP3 round-trip):
- `chime_run` — ascending two-tone bell G5→C6 (energetic, "gear up")
- `chime_walk` — descending two-tone bell C6→G5 (calming; also used for warmup + cooldown)
- Generated once per session in `generateChimeBuffers()` via `synthesizeBellBuffer(freq1, freq2, durationSec)` — sine fundamental + 2nd & 3rd harmonics, exponential decay envelope

**Pipeline:** `fetchAllAudio()` runs at page load and pulls every voice clip into `ArrayBuffer`s. `decodeAllAudio()` + `generateChimeBuffers()` run the first time the user starts a workout (must be inside a user gesture so `AudioContext` can be created). SpeechSynthesis fallback (`speakFallback`) covers any voice clip that failed to load/decode (chimes never fail — they're synthesized on demand).

### CRITICAL: cues are PRE-SCHEDULED, not fired from `tick()`
Old version called `playClip(...)` from inside `tick()` when a phase boundary was crossed. Android Chrome throttles `setInterval` to ~1Hz when the tab is hidden (and to nothing when the screen locks for long), so cues missed by minutes if the user pocketed their phone.

New version: `scheduleAllCues(fromSec)` builds the full cue event list and calls `audioBufferSource.start(audioCtx.currentTime + offsetSec)` for each. Web Audio scheduling is sample-accurate and **fires regardless of JS timer throttling**. Triggered from `startWorkout()` (fromSec=0), `pauseWorkout()` resume branch, and `jumpToSecond()`.

Each phase boundary produces TWO scheduled events:
1. **Chime** at exact `p.start` (offset 0 from boundary) — fire-and-forget via `playChimeNow`-style source, doesn't interrupt anything
2. **Voice** at `p.start + 0.5` — randomly chosen run/walk variant, layered just behind the chime

`cancelAllScheduled()` stops every pending source — called on pause, skip, stop, complete.

### Silent keep-alive
A 1-second silent buffer on a looping `BufferSource` (`startSilentKeepalive`) plays continuously while a workout is active. Keeps the AudioContext engaged so the OS treats the tab as "playing audio" — needed for MediaSession lock-screen controls and to reduce the chance of Android killing the tab in deep background.

### Volume
`audioGain` is a `GainNode` between every source and `audioCtx.destination`. The `$volumeSlider` input listener writes `audioGain.gain.value` in real time — affects both currently-playing and future-scheduled cues.

### Skip-into-phase quirk
`scheduleAllCues(targetSec)` only schedules phase starts where `p.start >= targetSec`. If the user skips into the *middle* of a phase (e.g., jumps to second 30 of a 60-second run), no scheduled cue announces it. `jumpToSecond()` handles this by calling `announcePhaseImmediate(phase)` for the current phase right after re-scheduling.

---

## Storage

### IndexedDB (primary, always written)
- Database: `WorkoutTrainerDB` v1
- Object store: `sessions`, keyPath `id` (autoIncrement), index on `date`
- Schema per session:
  ```js
  {
    id, date: ISO string, dateLabel, timeLabel,
    totalSeconds, totalFormatted, completed: bool,
    phases: { warmup, run, walk, cooldown }  // seconds in each phase type
  }
  ```

### Firestore (optional, signed-in only)
- `users/{uid}/sessions/{docId}` — same shape plus `createdAt: serverTimestamp()`
- Written on save only if `currentUser && isOnline`
- Bidirectional sync in `syncLocalToCloud` and `syncCloudToLocal`, deduped by `date` string (ISO)

**Ordering rule:** IndexedDB is written FIRST, then Firestore. If Firestore fails, the session is still preserved locally. Never reverse this order.

---

## MediaSession (lock-screen)

`setupMediaSessionHandlers()` registers `play`/`pause`/`stop` action handlers once at page load — these wire the Android lock-screen media controls to `pauseWorkout()` / `stopWorkout()`.

`updateMediaSession(refreshMetadata)` is called from:
- `updateDisplay()` on every phase change (`refreshMetadata=true`) — refreshes title, artist, artwork
- `updateDisplay()` on every elapsed-second tick (`false`) — refreshes `setPositionState` only
- `pauseWorkout()` / `stopWorkout()` / `completeWorkout()` — updates `playbackState`

Title is the current phase label ("Run", "Walk", "Warm Up", "Cool Down"). Artist is `'Run/Walk Trainer'`. Artwork uses the SVG icons from the manifest — Android may or may not render SVG on the lock screen, but title + transport controls always appear.

## Auth

`firebase-config.js` imports Firebase v11 modular SDK from `gstatic.com` CDN. Project `run-walk-trainer`. Google sign-in via `signInWithPopup`. No redirect fallback currently — if popup is blocked on mobile, user sees the popup error and the code just catches `auth/popup-closed-by-user` quietly and alerts otherwise.

`onAuthStateChanged` persists sign-in across refreshes and triggers a bidirectional sync on rehydrate.

---

## Deploy

No deploy target committed. Runs as a static PWA — drop the folder on any static host (Netlify, GitHub Pages, Render static, Firebase Hosting). Service worker requires HTTPS (or localhost) to register.

Firebase config in `firebase-config.js` is a **web API key** which is fine to ship in the client — it's not a secret for Firebase, access is controlled by security rules in the Firebase console (not in this repo).

---

## Gotchas / things to know

### 1. Bump `CACHE_NAME` in `sw.js` when shipping code/asset changes
Currently `runwalk-v11`. If you change `app.js`, `style.css`, `index.html`, or any audio clip, bump this. The SW activate step cleans old caches keyed on the version.

### 2. Wall-clock timer, not accumulating counter
Don't "simplify" the timer to `elapsed += 1` on each tick. Mobile browsers throttle background intervals and the workout will drift by minutes. The `Date.now()` math is intentional.

### 3. Wake Lock releases on tab hide — must re-acquire
`visibilitychange` listener re-acquires the wake lock when the tab comes back into view. Don't remove this. Without it, locking the phone mid-workout kills the wake lock permanently.

### 4. Audio is fetched eagerly, decoded lazily on first workout start
`fetchAllAudio()` runs at page load (no AudioContext needed — just `fetch` → `ArrayBuffer`). Decoding into `AudioBuffer`s happens on the first `startWorkout()` call because `AudioContext` requires a user gesture. Any clip that fails fetch or decode falls back to `speakFallback()` (SpeechSynthesis) at play time. Deliberate — slow network on one clip shouldn't block the rest.

### 5. IndexedDB is the source of truth; Firestore is a cache
Save order: IndexedDB → Firestore. Merge rule in `getAllSessions`: local takes precedence on duplicates. If you add fields, update both the IndexedDB write and the Firestore write, and update `syncCloudToLocal`'s field stripping (`firestoreId`, `createdAt`).

### 6. Sync dedupes by ISO date string
`localDates = new Set(localSessions.map(s => s.date))`. Two sessions at the exact same millisecond would collide, but that's impossible for this app. Don't change `date` to be non-unique.

### 7. Popup sign-in with no redirect fallback
Unlike Booktracker/SolarNotes, this app only uses `signInWithPopup`. If mobile popup blocking becomes an issue, copy the pattern from Booktracker's `js/firebase.js` (catch `auth/popup-blocked`, `auth/popup-closed-by-user`, `auth/cancelled-popup-request` → `signInWithRedirect`).

### 8. 8 run + 8 walk variants for variety
The app randomly picks one of 8 run or walk clips at each phase transition to avoid repetition fatigue over a 30-minute session. If you add or remove variants, update the modulo math in **both** `buildCueEvents()` (used by the scheduler) and `announcePhaseImmediate()` (used by skip): `Math.floor(Math.random() * 8) + 1`.

### 9. 30-minute workout is hardcoded
This is NOT a general interval trainer — it's the user's specific run/walk progression. Changing the duration or intervals means re-recording audio cues that reference timing (if any) and bumping the cache version.

### 10. Firestore security rules are NOT in this repo
They live in the Firebase console for the `run-walk-trainer` project. If you see permission-denied errors, check the rules allow read/write on `users/{uid}/sessions/{docId}` where `request.auth.uid == uid`.

### 11. Cues fire from Web Audio scheduler, not `tick()`
Don't move phase/warning audio back into `tick()`. The whole point of the v7 refactor was to break that dependency: `tick()` only updates the visual UI now, and Android Chrome's background timer throttling no longer affects when cues play. Audio is owned by `scheduleAllCues()` + `cancelAllScheduled()`, called from start/pause/resume/skip/stop.

### 12. AudioContext requires a user gesture to create
`ensureAudioCtx()` is only called from inside event handlers (`startWorkout`, `pauseWorkout` resume branch, test-voice button click). Don't move the AudioContext construction to page-load init — it'll fail with "AudioContext was not allowed to start" until the user clicks something.

### 13. MediaSession won't show on lock screen if no audio is playing
The silent keep-alive buffer (`startSilentKeepalive`) is what keeps the OS treating the tab as actively playing media. Without it, MediaSession metadata exists in JS but Android won't surface it on the lock screen. Don't remove it.

### 14. Chime layers — never use `playClip` for chimes
`playClip` stops `currentImmediateSource` so it doesn't overlap with itself (good for control announcements). But the chime + voice are MEANT to layer (chime → 500ms gap → voice). Use `playChimeNow` for chimes — it's a separate fire-and-forget source path that doesn't touch `currentImmediateSource`. If you ever consolidate the two, you'll cut the chime off mid-ring.

### 15. Pre-warning voice cues are intentionally NOT scheduled
`ready_run`, `ready_walk`, `ready_switch`, `nearly_there` MP3s still exist in `audio/` but are not in `buildCueEvents`. The chime at the phase boundary is the cue. If you re-add scheduling for them, also add a "voice density" preference UI — running them again will spike voice events ~2x.

---

## Coding conventions

- Vanilla ES modules (`<script type="module">`)
- jQuery-style `$var` DOM reference naming
- All state as module-level `let` variables (no framework, no store)
- Dark theme, slate/navy palette, `#0f172a` bg
- Audio-first coaching — don't add pure-text cues without a clip or fallback text

---

## Pending / future ideas

- Voice density preference UI (chime-only mode, or re-enable pre-warnings for users who want more verbosity)
- Re-record run/walk voice clips shorter — current ElevenLabs lines are ~2-3s each; ~1s would feel less talky
- Popup→redirect fallback for mobile sign-in (copy Booktracker's pattern)
- Configurable workout length / interval ratio (currently hardcoded)
- Weekly streak / stats view in History
- Background audio during phone-locked state on iOS (currently Android-tested only; iOS likely needs `playsinline` Audio + more aggressive MediaSession work)

---

**Last updated:** 2026-05-03 — v11: filled previously-empty `audio/` folder with all 26 voice clips generated via Microsoft Edge TTS (`en-AU-NatashaNeural`, Australian female). Was missing since project inception — voice cues had been silently no-op'ing through the Web Audio scheduler (only chimes played). Generation script at `agentmail/generate_runwalk_audio.py`. v10: full-screen layout — body/`.app` use `100dvh` flex column with safe-area-inset padding; `.voice-settings` pinned to bottom via `margin-top: auto`; timer ring scales with `min(280px, 70vw)` + `aspect-ratio: 1`. Was rendering content in top ~40% of tall phones with empty space below — now fills viewport like a native app. v9: PNG icons for Android Chrome install prompt (manifest icons were SVG-only, blocking install). v8: synthesized two-tone chimes at every phase boundary, voice announcement layered 500ms behind chime; pre-warning cues dropped to cut chatter (~31 → ~17 voice events). v7: Web Audio refactor for background-proof scheduled cues + MediaSession lock-screen controls.
