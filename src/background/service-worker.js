// Zendesk Chat Tracker - Service Worker
// Manages chat state, timers, and threshold evaluation

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
    state.settings = { ...state.settings, ...result.settings };
  }
});

function broadcastSoundAlert(soundType, volume) {
  console.log('[ServiceWorker] broadcastSoundAlert core logic called', { soundType, volume });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'PLAY_SOUND',
        soundType,
        volume,
      }).catch(() => {
        // Content script might not be ready
      });
    }
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

  // Broadcast to popup
  chrome.runtime.sendMessage({
    type: 'STATE_UPDATE',
    metrics: state.metrics,
  }).catch(() => {
    // Popup might not be open
  });

  // Broadcast to content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'UPDATE_ROWS',
        updates: rowUpdates,
      }).catch(() => {
        // Content script might not be ready
      });
    }
  });
}

// Message handlers
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'SCAN_RESULT') {
    console.log('[ServiceWorker] SCAN_RESULT message received', { candidateCount: request.candidates?.length });
    processScan(request.candidates, request.timestamp);
    sendResponse({ ok: true });
  } else if (request.type === 'SETTINGS_CHANGED') {
    console.log('[ServiceWorker] SETTINGS_CHANGED message received', request.settings);
    state.settings = { ...state.settings, ...request.settings };
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
    sendResponse({
      metrics: state.metrics,
      settings: state.settings,
    });
  }
});

console.log('[Chat Tracker] Service Worker loaded');
