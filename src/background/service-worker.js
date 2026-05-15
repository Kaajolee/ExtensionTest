// Zendesk Chat Tracker - Service Worker
// Manages chat state, timers, and threshold evaluation


const TRUSTED_URL_PATTERN = /^https:\/\/[^/]+\.zendesk\.com\/agent\/filters\//i;

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
      console.error('[ServiceWorker] Failed to send', payload.type, 'to content script', err);
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
  let activeBreaches = 0;
  let activeWarnings = 0;
  const rowUpdates = {};

  candidates.forEach(({ entryId, source }) => {
    seenThisPass.add(entryId);

    if (!state.activeEntries.has(entryId)) {
      state.activeEntries.set(entryId, {
        detectedAt: timestamp,
        alerted: false,
        source: source,
      });
    }

    const entry = state.activeEntries.get(entryId);
    const elapsedSeconds = (timestamp - entry.detectedAt) / 1000;

    let isWarning = false;
    let isBreached = false;

    if (elapsedSeconds >= state.settings.breachThreshold) {
      isBreached = true;
      activeBreaches++;
      if (!entry.alerted) {
        entry.alerted = true;
        if (!state.settings.isMuted) {
          broadcastSoundAlert(state.settings.soundType, state.settings.volume);
        }
      }
    } else if (elapsedSeconds >= state.settings.warningThreshold) {
      isWarning = true;
      activeWarnings++;
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

  state.metrics.breachedCount = activeBreaches;
  state.metrics.warningCount = activeWarnings;
  state.metrics.totalHanging = state.activeEntries.size;

  // Popup is internal; silent-fail if not open.
  chrome.runtime.sendMessage({
    type: 'STATE_UPDATE',
    metrics: state.metrics,
  }).catch(() => {});

  sendToActiveTrustedTab({
    type: 'UPDATE_ROWS',
    updates: rowUpdates,
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

    // Reset alerted flags so new thresholds can re-trigger sounds.
    state.activeEntries.forEach((entry) => {
      entry.alerted = false;
    });

    // Re-evaluate all chats against the new thresholds.
    const candidates = Array.from(state.activeEntries.entries()).map(([id, entry]) => ({
      entryId: id,
      source: entry.source,
    }));
    processScan(candidates, Date.now());
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
