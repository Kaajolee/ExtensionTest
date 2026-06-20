// Zendesk Chat Tracker - Service Worker
// Manages chat state, timers, and threshold evaluation


// Allows real Zendesk subdomains over HTTPS, plus http://localhost:<port>
// for the FakeZendesk simulator. The path prefix /agent/filters/ is
// enforced for both so non-agent-view pages can't talk to the SW even
// if they happen to be on a trusted origin.
const TRUSTED_URL_PATTERN = /^(https:\/\/[^/]+\.zendesk\.com|http:\/\/localhost(:\d+)?)\/agent\/filters\//i;

const ENTRY_ID_PATTERN = /^[a-zA-Z0-9_\-#.]{1,64}$/;

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

// SECURITY: Allowed sound type values.
const ALLOWED_SOUND_TYPES = new Set(['beep', 'chime', 'alert', 'bell', 'notification']);


const defaultSettings = {
  breachThreshold: 60,
  warningThreshold: 20,
  isMuted: false,
  volume: 25,
  soundType: 'beep',
  isDarkMode: false,
  breachColor: '#ff0000',
  warningColor: '#ffcc00',
  isEnabled: true,
  refreshFrequency: 30,
};

const state = {
  activeEntries: new Map(),
  settings: { ...defaultSettings },
  metrics: {
    breachedCount: 0,
    warningCount: 0,
    totalHanging: 0,
  },
  runtimeAccumulatedMs: 0,
  sessionStartedAt: null,
};

const RUNTIME_HEARTBEAT_ALARM = 'runtime-heartbeat';
const RUNTIME_HEARTBEAT_PERIOD_MIN = 1;

// Storage keys.
const RUNTIME_ACCUMULATED_KEY = 'runtimeAccumulatedMs';
const RUNTIME_SESSION_KEY = 'runtimeLastActiveAt';

// Cap resume gap - stale/tampered flags fall back to a fresh start.
const RUNTIME_RESUME_MAX_GAP_MS = 5 * 60 * 1000;

// Load persisted settings + accumulated runtime; popup awaits this before responding.
const stateReady = new Promise((resolve) => {
  chrome.storage.local.get(['settings', RUNTIME_ACCUMULATED_KEY], (localResult) => {
    if (localResult.settings) {
      // Re-validate on read - storage.local is disk-backed and tamperable.
      state.settings = sanitizeSettings({ ...state.settings, ...localResult.settings });
      console.log('[ServiceWorker] Restored settings from local storage');
    } else {
      console.log('[ServiceWorker] No saved settings found - using defaults');
    }

    // Validate accumulated runtime: finite, non-negative, under 100-year ceiling.
    const persistedAccum = localResult[RUNTIME_ACCUMULATED_KEY];
    if (
      typeof persistedAccum === 'number' &&
      Number.isFinite(persistedAccum) &&
      persistedAccum >= 0 &&
      persistedAccum < 3.15e15
    ) {
      state.runtimeAccumulatedMs = persistedAccum;
    } else {
      state.runtimeAccumulatedMs = 0;
      if (persistedAccum !== undefined) {
        console.warn('[ServiceWorker] Rejected malformed runtimeAccumulatedMs:', persistedAccum);
      }
    }

    // storage.session flag is wiped on browser close -> distinguishes resume vs. fresh launch.
    chrome.storage.session.get(RUNTIME_SESSION_KEY, (sessionResult) => {
      const now = Date.now();
      const lastActiveAt = sessionResult[RUNTIME_SESSION_KEY];
      if (
        typeof lastActiveAt === 'number' &&
        Number.isFinite(lastActiveAt) &&
        lastActiveAt > 0 &&
        lastActiveAt <= now &&
        now - lastActiveAt < RUNTIME_RESUME_MAX_GAP_MS
      ) {
        // Resume: count the SW-eviction gap on next flush.
        state.sessionStartedAt = lastActiveAt;
        console.log('[ServiceWorker] Resuming runtime tracking from', new Date(lastActiveAt).toISOString());
      } else {
        // Fresh browser launch - don't count anything before now.
        state.sessionStartedAt = now;
        console.log('[ServiceWorker] Fresh runtime session');
      }
      // Refresh the session flag so an immediate eviction still resumes.
      chrome.storage.session.set({ [RUNTIME_SESSION_KEY]: now }).catch(() => {});

      // Heartbeat alarm (idempotent).
      chrome.alarms.create(RUNTIME_HEARTBEAT_ALARM, {
        periodInMinutes: RUNTIME_HEARTBEAT_PERIOD_MIN,
      });

      resolve();
    });
  });
});

// Flush in-memory delta to disk and re-anchor the tracking window.
function flushRuntime() {
  if (state.sessionStartedAt === null) return;
  const now = Date.now();
  // Clock-skew guard against NTP correction / user clock change.
  const delta = Math.max(0, now - state.sessionStartedAt);
  state.runtimeAccumulatedMs += delta;
  state.sessionStartedAt = now;
  chrome.storage.local.set({ [RUNTIME_ACCUMULATED_KEY]: state.runtimeAccumulatedMs }).catch((err) => {
    console.warn('[ServiceWorker] runtime flush to local failed', err);
  });
  chrome.storage.session.set({ [RUNTIME_SESSION_KEY]: now }).catch(() => {});
}

// Heartbeat: persist a snapshot every minute and wake SW from idle.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RUNTIME_HEARTBEAT_ALARM) {
    flushRuntime();
  }
});

// Best-effort final flush on SW termination (not guaranteed in MV3).
chrome.runtime.onSuspend.addListener(() => {
  flushRuntime();
});

// One-time cleanup of the deprecated `runtimeStartedAt` key.
chrome.storage.local.remove('runtimeStartedAt').catch(() => {});

//#region------SECURITY HELPERS----------------

// Allow popup/SW (no tab) and content scripts on trusted Zendesk URLs.
function isTrustedSender(sender) {
  if (!sender) return false;
  if (sender.id && sender.id !== chrome.runtime.id) {
    console.warn('[ServiceWorker] Rejected message from foreign extension:', sender.id);
    return false;
  }
  if (!sender.tab) return true;
  const url = sender.tab.url || sender.url || '';
  if (!TRUSTED_URL_PATTERN.test(url)) {
    console.warn('[ServiceWorker] Rejected message from untrusted URL:', url.slice(0, 80));
    return false;
  }
  return true;
}

function sanitizeEntryId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!ENTRY_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function sanitizeCandidates(raw) {
  if (!Array.isArray(raw)) return null;
  // Cap at 500 to prevent memory-exhaustion floods.
  if (raw.length > 500) {
    console.warn('[ServiceWorker] SCAN_RESULT exceeded candidate cap, truncating');
    raw = raw.slice(0, 500);
  }
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const entryId = sanitizeEntryId(c.entryId);
    if (!entryId) continue;
    const source = c.source === 'new' || c.source === 'open' ? c.source : 'open';
    out.push({ entryId, source });
  }
  return out;
}

function sanitizeTimestamp(ts) {
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return Date.now();
  // Clamp absurd timestamps (>1 minute skew).
  const now = Date.now();
  if (Math.abs(ts - now) > 60_000) return now;
  return ts;
}

function clampNumber(v, min, max, fallback) {
  if (typeof v !== 'number' || !isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

// Clamp/validate settings; unknown keys dropped.
function sanitizeSettings(raw) {
  const out = { ...defaultSettings };
  if (!raw || typeof raw !== 'object') return out;

  out.breachThreshold = clampNumber(raw.breachThreshold, 1, 86400, defaultSettings.breachThreshold);
  out.warningThreshold = clampNumber(raw.warningThreshold, 0, 86400, defaultSettings.warningThreshold);
  // Warning must be <= breach.
  if (out.warningThreshold > out.breachThreshold) {
    out.warningThreshold = out.breachThreshold;
  }
  out.volume = clampNumber(raw.volume, 0, 100, defaultSettings.volume);
  out.isMuted = raw.isMuted === true;
  out.isDarkMode = raw.isDarkMode === true;
  out.soundType = ALLOWED_SOUND_TYPES.has(raw.soundType) ? raw.soundType : defaultSettings.soundType;
  out.breachColor = HEX_COLOR_PATTERN.test(raw.breachColor) ? raw.breachColor : defaultSettings.breachColor;
  out.warningColor = HEX_COLOR_PATTERN.test(raw.warningColor) ? raw.warningColor : defaultSettings.warningColor;
  // Default = enabled (only explicit `false` disables).
  out.isEnabled = raw.isEnabled === false ? false : true;
  // 1..3600s - 0 would peg CPU, >1h is meaningless.
  out.refreshFrequency = clampNumber(raw.refreshFrequency, 1, 3600, defaultSettings.refreshFrequency);
  return out;
}

//#endregion------SECURITY HELPERS----------------

//#region------BROADCASTING----------------

// Only sends to the active tab when its URL matches the trusted pattern.
function sendToActiveTrustedTab(payload) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    const tab = tabs[0];
    const url = tab.url || '';
    if (!TRUSTED_URL_PATTERN.test(url)) return;
    chrome.tabs.sendMessage(tab.id, payload).catch((err) => {
      const msg = (err && err.message) || String(err);
      // Benign + expected: the matching tab has no content script yet
      // (e.g. it hasn't been reloaded since the extension last started, or
      // is still loading). Settings are persisted regardless and the
      // content script syncs to current state on its next scan once live.
      if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
        return;
      }
      console.warn('[ServiceWorker] Failed to send', payload.type, 'to content script:', msg);
    });
  });
}

function broadcastSoundAlert(soundType, volume) {
  console.log('[ServiceWorker] broadcastSoundAlert core logic called', { soundType, volume });
  const safeSoundType = ALLOWED_SOUND_TYPES.has(soundType) ? soundType : 'beep';
  const safeVolume = clampNumber(volume, 0, 100, 25);
  sendToActiveTrustedTab({
    type: 'PLAY_SOUND',
    soundType: safeSoundType,
    volume: safeVolume,
  });
}

function processScan(candidates, timestamp) {
  console.log('[ServiceWorker] processScan core logic called', { candidateCount: candidates.length, timestamp });
  const seenThisPass = new Set();
  const rowUpdates = {};

  candidates.forEach(({ entryId, source }) => {
    seenThisPass.add(entryId);

    if (!state.activeEntries.has(entryId)) {
      state.activeEntries.set(entryId, {
        detectedAt: timestamp,
        alerted: false,
        // High-watermark severity this chat has been tallied at:
        //   0 = none, 1 = warning, 2 = breached.
        // Each chat contributes to exactly ONE cumulative total — its
        // highest tier reached. A chat that warns then breaches is moved
        // out of the warning total into the breached total. The tier only
        // ever climbs; only the Reset button (which clears all entries)
        // starts the tally over.
        countedTier: 0,
        source: source,
      });
    }

    const entry = state.activeEntries.get(entryId);
    const elapsedSeconds = (timestamp - entry.detectedAt) / 1000;

    if (elapsedSeconds >= state.settings.breachThreshold) {
      if (!entry.alerted) {
        entry.alerted = true;
        if (!state.settings.isMuted) {
          broadcastSoundAlert(state.settings.soundType, state.settings.volume);
        }
      }
      // Promote to the breached bucket. If this chat was previously
      // tallied as a warning, take it back out of the warning total so it
      // only counts toward breached.
      if (entry.countedTier < 2) {
        if (entry.countedTier === 1) {
          state.metrics.warningCount--;
        }
        entry.countedTier = 2;
        state.metrics.breachedCount++;
      }
    } else {
      // Entry is below the breach threshold. Clear `alerted` so that if
      // the user later lowers the threshold (or the entry crosses back
      // over for any other reason) we treat it as a fresh breach and
      // re-fire the sound. This replaces the blanket reset that used
      // to live in the SETTINGS_CHANGED handler.
      entry.alerted = false;
      if (elapsedSeconds >= state.settings.warningThreshold && entry.countedTier === 0) {
        entry.countedTier = 1;
        state.metrics.warningCount++;
      }
    }

    // Content script ticks the visual countdown locally - feed it the inputs it needs.
    rowUpdates[entryId] = {
      detectedAt: entry.detectedAt,
      breachThreshold: state.settings.breachThreshold,
      warningThreshold: state.settings.warningThreshold,
    };
  });

  // Drop entries no longer in the queue.
  // Send an explicit "cleared" record (no detectedAt) so the content script clears local meta + DOM.
  for (const [id] of state.activeEntries) {
    if (!seenThisPass.has(id)) {
      state.activeEntries.delete(id);
      rowUpdates[id] = { cleared: true };
    }
  }

  // breachedCount / warningCount are cumulative and incremented above;
  // do NOT overwrite them here. Only the live hanging total is recomputed.
  state.metrics.totalHanging = state.activeEntries.size;

  // Popup is internal; silent-fail if not open.
  chrome.runtime.sendMessage({
    type: 'STATE_UPDATE',
    metrics: state.metrics,
  }).catch(() => {});

  sendToActiveTrustedTab({
    type: 'UPDATE_ROWS',
    updates: rowUpdates,
    // Piggyback the user's chosen colors so the content script can write
    // them to CSS custom properties without an extra round-trip. Cheap
    // (two short hex strings) and keeps row painting always in sync.
    colors: {
      warning: state.settings.warningColor,
      breach: state.settings.breachColor,
    },
    // Stamp the master switch so a freshly-loaded content script that
    // missed the SET_ENABLED push still self-corrects.
    enabled: state.settings.isEnabled,
    // Drive the content script's auto-refresh cadence (seconds).
    refreshFrequency: state.settings.refreshFrequency,
  });
}

//#endregion------BROADCASTING----------------

//#region------MESSAGE HANDLERS----------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Reject untrusted senders before any work.
  if (!isTrustedSender(sender)) {
    sendResponse({ ok: false, error: 'untrusted_sender' });
    return;
  }

  if (!request || typeof request !== 'object' || typeof request.type !== 'string') {
    sendResponse({ ok: false, error: 'malformed_request' });
    return;
  }

  if (request.type === 'SCAN_RESULT') {
    console.log('[ServiceWorker] SCAN_RESULT message received', { candidateCount: request.candidates?.length });
    // Disabled: ignore the scan entirely and tell the content script to
    // switch off (covers a content script that loaded while disabled).
    if (!state.settings.isEnabled) {
      sendToActiveTrustedTab({ type: 'SET_ENABLED', enabled: false });
      sendResponse({ ok: true, disabled: true });
      return;
    }
    const safeCandidates = sanitizeCandidates(request.candidates);
    if (!safeCandidates) {
      sendResponse({ ok: false, error: 'invalid_candidates' });
      return;
    }
    const safeTimestamp = sanitizeTimestamp(request.timestamp);
    processScan(safeCandidates, safeTimestamp);
    sendResponse({ ok: true });
  } else if (request.type === 'SETTINGS_CHANGED') {
    console.log('[ServiceWorker] SETTINGS_CHANGED message received', request.settings);
    // Clamp numbers, validate enums, drop unknown keys.
    const safeSettings = sanitizeSettings({ ...state.settings, ...(request.settings || {}) });
    state.settings = safeSettings;
    chrome.storage.local.set({ settings: state.settings }).catch((err) => {
      console.warn('[ServiceWorker] storage.local.set failed', err);
    });

    // NOTE: we intentionally do NOT reset entry.alerted here. Toggling
    // mute, changing sound type, swapping colours, etc. would otherwise
    // re-fire the breach sound for every currently-overdue chat on
    // every settings touch. processScan() now clears `alerted` on its
    // own whenever an entry drops below the breach threshold, so a
    // legitimate re-breach (e.g. user lowers the threshold below the
    // current elapsed time after raising it above) still fires.

    // Push the master switch to the content script directly. This is the
    // re-enable path too: a disabled content script has stopped sending
    // SCAN_RESULT, so the SW must tell it to switch back on.
    sendToActiveTrustedTab({ type: 'SET_ENABLED', enabled: state.settings.isEnabled });

    if (state.settings.isEnabled) {
      // Re-evaluate all chats against the new thresholds.
      const candidates = Array.from(state.activeEntries.entries()).map(([id, entry]) => ({
        entryId: id,
        source: entry.source,
      }));
      processScan(candidates, Date.now());
    }
    sendResponse({ ok: true });
  } else if (request.type === 'RESET') {
    console.log('[ServiceWorker] RESET message received');
    state.activeEntries.clear();
    state.metrics = { breachedCount: 0, warningCount: 0, totalHanging: 0 };

    // Zero accumulated runtime and re-anchor the window; persist immediately.
    const now = Date.now();
    state.runtimeAccumulatedMs = 0;
    state.sessionStartedAt = now;
    chrome.storage.local.set({ [RUNTIME_ACCUMULATED_KEY]: 0 }).catch((err) => {
      console.warn('[ServiceWorker] Failed to persist reset accumulated', err);
    });
    chrome.storage.session.set({ [RUNTIME_SESSION_KEY]: now }).catch(() => {});

    chrome.runtime.sendMessage({
      type: 'STATE_UPDATE',
      metrics: state.metrics,
      runtimeAccumulatedMs: state.runtimeAccumulatedMs,
      sessionStartedAt: state.sessionStartedAt,
    }).catch(() => {});

    sendResponse({
      ok: true,
      runtimeAccumulatedMs: state.runtimeAccumulatedMs,
      sessionStartedAt: state.sessionStartedAt,
    });
  } else if (request.type === 'PLAY_SOUND') {
    console.log('[ServiceWorker] PLAY_SOUND message received', { soundType: request.soundType, volume: request.volume });
    broadcastSoundAlert(request.soundType, request.volume);
    sendResponse({ ok: true });
  } else if (request.type === 'REQUEST_CURRENT_STATE') {
    console.log('[ServiceWorker] REQUEST_CURRENT_STATE message received');
    // Await stateReady so cold-SW popups don't see defaults; `return true` keeps MV3 channel open.
    stateReady.then(() => {
      sendResponse({
        metrics: state.metrics,
        settings: state.settings,
        runtimeAccumulatedMs: state.runtimeAccumulatedMs,
        sessionStartedAt: state.sessionStartedAt,
      });
    });
    return true;
  } else {
    sendResponse({ ok: false, error: 'unknown_type' });
  }
});

//#endregion------MESSAGE HANDLERS----------------

console.log('[Chat Tracker] Service Worker loaded');
