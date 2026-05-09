// Zendesk Chat Tracker - Service Worker
// Manages chat state, timers, and threshold evaluation

// SECURITY: Trusted origins - only accept content-script messages from these patterns.
// Mirrors manifest.json content_scripts.matches; defense-in-depth verification.
// NOTE: localhost is permitted on this branch (offline-testing) so the mock
// harness in test/ can drive the extension. Remove before merging to main.

// trusted URL origins, if the URL does not match the specified 
// one the extension will reject the connection and will not operate on that link
const TRUSTED_URL_PATTERN =
  /^(https:\/\/([^/]+\.zendesk\.com|[^/]+\/hc\/agent)|http:\/\/(localhost|127\.0\.0\.1):8080)/i;

// entryId format validation
const ENTRY_ID_PATTERN = /^[a-zA-Z0-9_\-#.]{1,64}$/;

// hex color format validation
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

// allowed sound type values.
const ALLOWED_SOUND_TYPES = new Set(['beep', 'chime', 'alert']);

// settings that are stored in the chrome.storage.local space
const defaultSettings = {
  breachThreshold: 60,
  warningThreshold: 20,
  isMuted: false,
  volume: 25,
  soundType: 'beep',
  isDarkMode: false,
  breachColor: '#ff0000',
  warningColor: '#ffcc00',
};

// activeEntries is mirrored to chrome.storage.session so it survives the MV3
// service worker getting terminated after ~30s of idle. The session storage
// area lives in browser memory only and is wiped on browser restart, which is
// exactly the lifetime we want for "hanging chat" detection state.
const ACTIVE_ENTRIES_KEY = 'activeEntries';
const SESSION_TOTALS_KEY = 'sessionTotals';

// Metrics are cumulative session counters, not live snapshots:
//   breachedCount  - number of distinct chats that crossed the breach
//                    threshold during this browser session
//   warningCount   - number of distinct chats that crossed the warning
//                    threshold during this browser session
//   totalHanging   - LIVE count of chats currently being tracked (the
//                    one snapshot value the popup still shows)
//
// The cumulative counters are reset only by an explicit RESET from the
// popup or when chrome.storage.session itself is wiped (browser restart,
// extension reload). Per-entry flags below ensure each chat is only
// counted once even if it lingers in the warning/breach state for many
// scan ticks.
const state = {
  activeEntries: new Map(),
  settings: { ...defaultSettings },
  metrics: {
    breachedCount: 0,
    warningCount: 0,
    totalHanging: 0,
  },
};

// Load settings from storage on startup
chrome.storage.local.get('settings', (result) => {
  if (result.settings) {
    // SECURITY: Re-validate persisted settings to guard against tampering
    // (chrome.storage.local is readable/writable by the extension context).
    state.settings = sanitizeSettings({ ...state.settings, ...result.settings });
  }
});

// Restore activeEntries + session totals from session storage on (re)start.
// This lets a breached chat keep its original detectedAt and its
// already-counted flags across SW restarts so cumulative counters don't
// double-tick when the worker is silently respawned by Chrome.
function restoreSessionState() {
  if (!chrome.storage.session) return;
  chrome.storage.session.get([ACTIVE_ENTRIES_KEY, SESSION_TOTALS_KEY], (result) => {
    // Active entries
    const rawEntries = result && result[ACTIVE_ENTRIES_KEY];
    if (Array.isArray(rawEntries)) {
      let restored = 0;
      rawEntries.forEach(([id, entry]) => {
        const safeId = sanitizeEntryId(id);
        if (!safeId || !entry || typeof entry !== 'object') return;
        const detectedAt = typeof entry.detectedAt === 'number' && isFinite(entry.detectedAt)
          ? entry.detectedAt
          : Date.now();
        const source = entry.source === 'new' || entry.source === 'open' ? entry.source : 'open';
        state.activeEntries.set(safeId, {
          detectedAt,
          source,
          alerted: entry.alerted === true,
          warnedThisSession: entry.warnedThisSession === true,
          breachedThisSession: entry.breachedThisSession === true,
        });
        restored++;
      });
      if (restored > 0) {
        console.log('[ServiceWorker] Restored', restored, 'activeEntries from session storage');
      }
    }

    // Cumulative session totals
    const rawTotals = result && result[SESSION_TOTALS_KEY];
    if (rawTotals && typeof rawTotals === 'object') {
      if (typeof rawTotals.breachedCount === 'number' && rawTotals.breachedCount >= 0) {
        state.metrics.breachedCount = Math.floor(rawTotals.breachedCount);
      }
      if (typeof rawTotals.warningCount === 'number' && rawTotals.warningCount >= 0) {
        state.metrics.warningCount = Math.floor(rawTotals.warningCount);
      }
    }
  });
}
restoreSessionState();

// Mirror the in-memory activeEntries Map and the cumulative session totals
// to chrome.storage.session. Called after every mutation that matters.
// Storage writes are cheap because session storage is in-memory and the
// payload is small.
function persistSessionState() {
  if (!chrome.storage.session) return;
  const arr = Array.from(state.activeEntries.entries());
  chrome.storage.session.set({
    [ACTIVE_ENTRIES_KEY]: arr,
    [SESSION_TOTALS_KEY]: {
      breachedCount: state.metrics.breachedCount,
      warningCount: state.metrics.warningCount,
    },
  }).catch((err) => {
    console.warn('[ServiceWorker] Failed to persist session state:', err);
  });
}

// validation helpers

// Verify a message originated from one of our own content scripts on a trusted URL.
// Returns true for popup/internal messages (where sender.tab is undefined).
function isTrustedSender(sender) {
  if (!sender) return false;
  // Sender must be the same extension
  if (sender.id && sender.id !== chrome.runtime.id) {
    console.warn('[ServiceWorker] Rejected message from foreign extension:', sender.id);
    return false;
  }
  // Internal messages (popup, service worker self) have no tab; allow these.
  if (!sender.tab) return true;
  // Tab-originated messages must come from a trusted URL.
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
  // Cap at 500 to prevent memory exhaustion via floods of fake candidates.
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
  // Clamp absurd timestamps (more than 1 minute skewed from now)
  const now = Date.now();
  if (Math.abs(ts - now) > 60_000) return now;
  return ts;
}

function clampNumber(v, min, max, fallback) {
  if (typeof v !== 'number' || !isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

// Validate and clamp settings before applying them. Unknown keys are dropped.
function sanitizeSettings(raw) {
  const out = { ...defaultSettings };
  if (!raw || typeof raw !== 'object') return out;

  out.breachThreshold = clampNumber(raw.breachThreshold, 1, 86400, defaultSettings.breachThreshold);
  out.warningThreshold = clampNumber(raw.warningThreshold, 0, 86400, defaultSettings.warningThreshold);
  // Warning must be <= breach
  if (out.warningThreshold > out.breachThreshold) {
    out.warningThreshold = out.breachThreshold;
  }
  out.volume = clampNumber(raw.volume, 0, 100, defaultSettings.volume);
  out.isMuted = raw.isMuted === true;
  out.isDarkMode = raw.isDarkMode === true;
  out.soundType = ALLOWED_SOUND_TYPES.has(raw.soundType) ? raw.soundType : defaultSettings.soundType;
  out.breachColor = HEX_COLOR_PATTERN.test(raw.breachColor) ? raw.breachColor : defaultSettings.breachColor;
  out.warningColor = HEX_COLOR_PATTERN.test(raw.warningColor) ? raw.warningColor : defaultSettings.warningColor;
  return out;
}

// ---------- broadcasting ----------

// Send a message to the active tab, but only if its URL is a trusted Zendesk page.
function sendToActiveTrustedTab(payload) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    const tab = tabs[0];
    const url = tab.url || '';
    if (!TRUSTED_URL_PATTERN.test(url)) {
      // Active tab isn't Zendesk; don't leak chat state to unrelated pages.
      return;
    }
    chrome.tabs.sendMessage(tab.id, payload).catch((err) => {
      console.error('[ServiceWorker] Failed to send', payload.type, 'to content script', err);
    });
  });
}

// Like sendToActiveTrustedTab but fans out to every tab whose URL matches
// the trusted pattern, regardless of focus. Used for UPDATE_ROWS so a
// Zendesk tab sitting in a background window still gets timer updates
// while the user is on an unrelated window. The data we send is identical
// across recipients - all Zendesk tabs are showing the same queue.
function sendToAllTrustedTabs(payload) {
  chrome.tabs.query({}, (tabs) => {
    if (!tabs || !tabs.length) return;
    tabs.forEach((tab) => {
      const url = tab.url || '';
      if (!TRUSTED_URL_PATTERN.test(url)) return;
      chrome.tabs.sendMessage(tab.id, payload).catch(() => {
        // Content script may not be ready in this tab yet - ignore.
      });
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
        source: source,
        alerted: false,                // breach sound has played
        warnedThisSession: false,      // counted toward warning session total
        breachedThisSession: false,    // counted toward breach session total
      });
    }

    const entry = state.activeEntries.get(entryId);
    const elapsedSeconds = (timestamp - entry.detectedAt) / 1000;

    let isWarning = false;
    let isBreached = false;

    if (elapsedSeconds >= state.settings.breachThreshold) {
      isBreached = true;

      // First time this chat crosses the breach threshold this session -
      // bump the cumulative counter. After this it stays counted no matter
      // how long the chat lingers, gets removed, or the SW restarts.
      if (!entry.breachedThisSession) {
        entry.breachedThisSession = true;
        state.metrics.breachedCount++;

        // A chat that jumps straight to breach (e.g. high warningThreshold,
        // or first scan after a long gap) should still count as having
        // entered the warning zone.
        if (!entry.warnedThisSession) {
          entry.warnedThisSession = true;
          state.metrics.warningCount++;
        }
      }

      if (!entry.alerted) {
        entry.alerted = true;
        if (!state.settings.isMuted) {
          broadcastSoundAlert(state.settings.soundType, state.settings.volume);
        }
      }
    } else if (elapsedSeconds >= state.settings.warningThreshold) {
      isWarning = true;

      if (!entry.warnedThisSession) {
        entry.warnedThisSession = true;
        state.metrics.warningCount++;
      }
    }

    const timer = Math.ceil(state.settings.breachThreshold - elapsedSeconds) + 's';
    rowUpdates[entryId] = {
      timer,
      warning: isWarning,
      overdue: isBreached,
    };
  });

  // Clean up removed entries. Cumulative counters do NOT decrement here -
  // a chat that has been counted stays counted for the session.
  for (const [id] of state.activeEntries) {
    if (!seenThisPass.has(id)) {
      state.activeEntries.delete(id);
    } else if (!rowUpdates[id]) {
      // Entry still exists but wasn't in this scan, shouldn't happen
      rowUpdates[id] = { timer: undefined, warning: false, overdue: false };
    }
  }

  // Live count of currently tracked chats. Purely a snapshot; the popup
  // doesn't display this today but it's still useful telemetry.
  state.metrics.totalHanging = state.activeEntries.size;

  // Persist after every scan so that any add/removal/alert flip and any
  // bump to the cumulative counters survives a SW termination.
  persistSessionState();

  // Broadcast to popup (popup is internal, no tab URL check needed)
  chrome.runtime.sendMessage({
    type: 'STATE_UPDATE',
    metrics: state.metrics,
  }).catch(() => {
    // Popup might not be open - this is normal, do not log as error
  });

  // Broadcast to every trusted Zendesk tab, even ones in background windows.
  // The active-only variant is reserved for sounds (where firing in multiple
  // tabs would be obnoxious); timer chip updates are idempotent across tabs.
  sendToAllTrustedTabs({
    type: 'UPDATE_ROWS',
    updates: rowUpdates,
  });
}

// ---------- message handlers ----------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // SECURITY: Reject all messages from untrusted senders before doing any work.
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
    // SECURITY: Sanitize incoming settings - clamp numbers, validate enums, drop unknown keys.
    const safeSettings = sanitizeSettings({ ...state.settings, ...(request.settings || {}) });
    state.settings = safeSettings;
    chrome.storage.local.set({ settings: state.settings });

    // Reset alerted flags so sounds can trigger again
    state.activeEntries.forEach((entry) => {
      entry.alerted = false;
    });

    // Re-evaluate all chats
    const candidates = Array.from(state.activeEntries.entries()).map(([id, entry]) => ({
      entryId: id,
      source: entry.source,
    }));
    processScan(candidates, Date.now());
    sendResponse({ ok: true });
    
  } else if (request.type === 'RESET') {
    console.log('[ServiceWorker] RESET message received');
    state.activeEntries.clear();
    // Zero out both live + cumulative counters explicitly. RESET is the only
    // intentional path that decrements the session totals.
    state.metrics = { breachedCount: 0, warningCount: 0, totalHanging: 0 };
    persistSessionState(); // wipe session-storage copy too

    chrome.runtime.sendMessage({
      type: 'STATE_UPDATE',
      metrics: state.metrics,
    }).catch(() => {});
    sendResponse({ ok: true });

  } else if (request.type === 'PLAY_SOUND') {
    console.log('[ServiceWorker] PLAY_SOUND message received', { soundType: request.soundType, volume: request.volume });
    broadcastSoundAlert(request.soundType, request.volume);
    sendResponse({ ok: true });

  } else if (request.type === 'REQUEST_CURRENT_STATE') {
    console.log('[ServiceWorker] REQUEST_CURRENT_STATE message received');
    sendResponse({
      metrics: state.metrics,
      settings: state.settings,
    });
  } else {
    sendResponse({ ok: false, error: 'unknown_type' });
  }
});

// ---------- background-tab keep-alive ----------
//
// Chrome / Edge throttle setInterval in tabs whose window is not in focus -
// the content script's 1s scan can drop to once per minute when the user
// switches to an unrelated window. Without an independent ticker the SW
// stops receiving SCAN_RESULTs, the timer chip in the Zendesk tab freezes,
// and breach detection lags by however long the throttle keeps the tab
// suspended.
//
// chrome.alarms is not subject to that throttling. We schedule a tick every
// 30 seconds (the MV3 minimum) which re-runs processScan against the cached
// activeEntries. That keeps elapsed-time computations, cumulative counters,
// and the broadcast UPDATE_ROWS flowing even while the Zendesk window is
// backgrounded, so the chip is up to date the moment the user switches back.
const TICK_ALARM_NAME = 'chat-tracker-tick';

if (chrome.alarms) {
  chrome.alarms.create(TICK_ALARM_NAME, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== TICK_ALARM_NAME) return;
    if (state.activeEntries.size === 0) return; // nothing to tick
    console.log('[ServiceWorker] Alarm tick - re-evaluating', state.activeEntries.size, 'entries');
    const candidates = Array.from(state.activeEntries.entries()).map(([id, entry]) => ({
      entryId: id,
      source: entry.source,
    }));
    processScan(candidates, Date.now());
  });
}

console.log('[Chat Tracker] Service Worker loaded');
