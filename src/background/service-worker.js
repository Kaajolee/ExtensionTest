// Zendesk Chat Tracker - Service Worker
// Manages chat state, timers, and threshold evaluation

// SECURITY: Trusted origins - only accept content-script messages from these patterns.
// Mirrors manifest.json content_scripts.matches; defense-in-depth verification.
// Audit finding #3 (HIGH): pattern is now scoped to the Zendesk agent filter
// view (the "All Chats" / queue page) only - not the whole *.zendesk.com
// domain or arbitrary /hc/agent/ paths, so a compromised marketing page on
// the same subdomain cannot inject SCAN_RESULT messages.
const TRUSTED_URL_PATTERN = /^https:\/\/[^/]+\.zendesk\.com\/agent\/filters\//i;

// SECURITY: entryId pattern (mirrors content script). Reject anything else.
const ENTRY_ID_PATTERN = /^[a-zA-Z0-9_\-#.]{1,64}$/;

// SECURITY: Hex color pattern for breachColor / warningColor settings.
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

// SECURITY: Allowed sound type values.
const ALLOWED_SOUND_TYPES = new Set(['beep', 'chime', 'alert']);

// SETTINGS PERSISTENCE
// ---------------------
// Settings are persisted in `chrome.storage.local` for long-term, single-user
// use. Behaviour:
//   - Survives:  popup close, service-worker idle eviction, tab close,
//                extension reload, browser restart, OS reboot. Settings
//                stick around until the user uninstalls the extension or
//                clears extension data manually.
//   - Cleared:   uninstall, "Clear extension data" in chrome://settings,
//                or an explicit `chrome.storage.local.clear()` call.
//
// SECURITY notes:
//   - `chrome.storage.local` writes to disk in PLAINTEXT (the extension's
//     profile directory). It is forensically recoverable after the browser
//     exits. Treat anything stored here as readable by anyone with file-
//     system access to the user's profile.
//   - Do NOT store secrets, API tokens, credentials, or PII here. Only UI
//     preferences and thresholds.
//   - `chrome.storage.local` does NOT support setAccessLevel - that API is
//     session-storage only. Content scripts in this extension *could*
//     technically read it, but the manifest only injects our content script
//     on https://*.zendesk.com/agent/filters/*, so the attack surface is
//     limited to that trusted page.
//   - Loaded values are re-validated through sanitizeSettings() on every
//     read. This matters more now than in session mode because disk-backed
//     storage can be edited (chrome://extensions devtools, or another
//     compromised extension the user installs). Defense in depth.
const defaultSettings = {
  breachThreshold: 60,
  warningThreshold: 20,
  isMuted: false,
  volume: 25,
  soundType: 'beep',
  isDarkMode: false,
  breachColor: '#ff0000',
  warningColor: '#ffcc00',
  // Master on/off toggle from the popup. Currently UI-only (doesn't gate
  // processScan), but persisted so the popup re-opens in the same state the
  // user left it.
  isEnabled: true,
  // How often the content script re-scans the queue for new rows, in seconds.
  // Clamped to 1..3600 in sanitizeSettings.
  refreshFrequency: 30,
};

// State lives only in service worker memory; not persisted.
// activeEntries values are derived from DOM data and treated as untrusted strings.
const state = {
  activeEntries: new Map(),
  settings: { ...defaultSettings },
  metrics: {
    breachedCount: 0,
    warningCount: 0,
    totalHanging: 0,
  },
};

// Load settings from local storage on startup. The SW runs this every time
// it spins up (cold start, wake from idle, browser restart), so settings
// survive across all of those.
//
// `settingsReady` resolves once the first read completes. Any handler that
// needs a fully-restored settings object should await it before responding -
// otherwise a popup opening at the exact moment the SW wakes from idle could
// race the async read and see defaultSettings.
const settingsReady = new Promise((resolve) => {
  chrome.storage.local.get('settings', (result) => {
    if (result.settings) {
      // SECURITY: Re-validate persisted settings before applying.
      // chrome.storage.local is on-disk and modifiable via devtools or a
      // compromised co-installed extension, so a stored value could be
      // out-of-range or a totally unexpected shape. sanitizeSettings clamps
      // numbers, validates enums, drops unknown keys, and falls back to
      // defaults for anything malformed.
      state.settings = sanitizeSettings({ ...state.settings, ...result.settings });
      console.log('[ServiceWorker] Restored settings from local storage');
    } else {
      console.log('[ServiceWorker] No saved settings found - using defaults');
    }
    resolve();
  });
});

// ---------- SECURITY: validation helpers ----------

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
  // isEnabled: strict boolean coerce, default = true (matches popup default).
  // Treating only `=== false` as off (rather than `!== true`) so an absent
  // or malformed key falls back to enabled rather than silently disabling.
  out.isEnabled = raw.isEnabled === false ? false : true;
  // refreshFrequency: clamp to 1..3600 seconds. 0 would peg CPU; >1h is
  // meaningless for a queue-monitor refresh and likely indicates a bad
  // value coming from somewhere unexpected.
  out.refreshFrequency = clampNumber(raw.refreshFrequency, 1, 3600, defaultSettings.refreshFrequency);
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

    const timer = Math.ceil(state.settings.breachThreshold - elapsedSeconds) + 's';
    rowUpdates[entryId] = {
      timer,
      warning: isWarning,
      overdue: isBreached,
    };
  });

  // Clean up removed entries
  for (const [id] of state.activeEntries) {
    if (!seenThisPass.has(id)) {
      state.activeEntries.delete(id);
    } else if (!rowUpdates[id]) {
      // Entry still exists but wasn't in this scan, shouldn't happen
      rowUpdates[id] = { timer: undefined, warning: false, overdue: false };
    }
  }

  // Update metrics
  state.metrics.breachedCount = activeBreaches;
  state.metrics.warningCount = activeWarnings;
  state.metrics.totalHanging = state.activeEntries.size;

  // Broadcast to popup (popup is internal, no tab URL check needed)
  chrome.runtime.sendMessage({
    type: 'STATE_UPDATE',
    metrics: state.metrics,
  }).catch(() => {
    // Popup might not be open - this is normal, do not log as error
  });

  // Broadcast to content script (only if active tab is trusted Zendesk page)
  sendToActiveTrustedTab({
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
    // Persist to local storage so settings survive popup close, SW idle
    // eviction, browser restart, and OS reboot. Cleared only on uninstall
    // or explicit clear from chrome://settings.
    chrome.storage.local.set({ settings: state.settings }).catch((err) => {
      console.warn('[ServiceWorker] storage.local.set failed', err);
    });

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
    state.metrics = { breachedCount: 0, warningCount: 0, totalHanging: 0 };

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
    // Defer the response until the session-storage read has populated
    // state.settings. Otherwise a popup opening on a cold SW could see
    // defaultSettings and the user's persisted edits would flash to defaults
    // for one render before being replaced. `return true` keeps the message
    // channel open for the async sendResponse - required by MV3.
    settingsReady.then(() => {
      sendResponse({
        metrics: state.metrics,
        settings: state.settings,
      });
    });
    return true;
  } else {
    sendResponse({ ok: false, error: 'unknown_type' });
  }
});

console.log('[Chat Tracker] Service Worker loaded');
