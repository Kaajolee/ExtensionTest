// Zendesk Chat Tracker - Content Script
// Scans DOM for unassigned chats and maintains visual indicators

import './content.css'


(function () {
'use strict';

const config = {
  scanInterval: 1000, // 1 second
  entryIdPattern: /^[a-zA-Z0-9_\-#.]{1,64}$/,
};

// Per-entry timer metadata fed by SW UPDATE_ROWS - drives the local 1s tick.
// Map<entryId, { detectedAt, breachThreshold, warningThreshold }>
const timerMeta = new Map();

let sharedAudioCtx = null;

function sanitizeEntryId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!config.entryIdPattern.test(trimmed)) {
    console.warn('[Content] Rejected invalid entryId:', trimmed.slice(0, 32));
    return null;
  }
  return trimmed;
}

function isValidUpdateMessage(request) {
  if (!request || typeof request !== 'object') return false;
  if (!request.updates || typeof request.updates !== 'object') return false;
  return true;
}

function isValidPlaySoundMessage(request) {
  if (!request || typeof request !== 'object') return false;
  if (typeof request.volume !== 'number') return false;
  if (request.volume < 0 || request.volume > 100) return false;
  return true;
}


function isTrustedSender(sender) {
  if (!sender) return false;
  if (sender.id && sender.id !== chrome.runtime.id) {
    console.warn('[Content] Rejected message from untrusted sender:', sender.id);
    return false;
  }
  return true;
}

function isRowUnassigned(row) {
  const cell = row.querySelector('td[data-test-id="ticket-table-cells-assignee"]');
  if (!cell) return false;
  const text = (cell.textContent || '').trim();
  return text === '' || text === '-' || text === '—' || /^(unassigned|-)$/i.test(text);
}

function scanForUnassignedChats() {
  console.log('[Content] scanForUnassignedChats core logic called');
  const newBadges = document.querySelectorAll('div[data-test-id="status-badge-new"]');
  const openBadges = document.querySelectorAll('div[data-test-id="status-badge-open"]');

  const candidateRows = new Map();

  newBadges.forEach(badge => {
    const row = badge.closest('tr');
    if (row) candidateRows.set(row, 'new');
  });

  openBadges.forEach(badge => {
    const row = badge.closest('tr');
    if (!row) return;
    if (isRowUnassigned(row)) {
      if (!candidateRows.has(row)) candidateRows.set(row, 'open');
    }
  });

  const candidates = [];
  const currentCandidateIds = new Set();

  candidateRows.forEach((source, row) => {
  
    const rawId = row.innerText.split('\n')[0].trim() || row.getAttribute('data-test-id');
    const entryId = sanitizeEntryId(rawId);
    if (!entryId) return; // Skip rows with invalid IDs

    currentCandidateIds.add(entryId);
    candidates.push({ entryId, source, row });
  });

  // Always send - SW needs every tick to fire breach sounds during stable queues.
  // Visual countdown ticks locally regardless, see tickTimers().
  const scanData = candidates.map(c => ({ entryId: c.entryId, source: c.source }));
  chrome.runtime.sendMessage({
    type: 'SCAN_RESULT',
    candidates: scanData,
    timestamp: Date.now(),
  }).catch((err) => {
    console.error('[Content] Failed to send SCAN_RESULT message to service worker', err);
  });

  window.__chatTrackerRows = new Map(candidates.map(c => [c.entryId, c.row]));
}

// Apply SW snapshot - stores per-entry detectedAt + thresholds for local ticking.
// Missing detectedAt means the SW dropped the entry; we clear it locally too.
function applyRowAttributes(updates) {
  console.log('[Content] applyRowAttributes core logic called', { updateCount: Object.keys(updates).length });
  const rows = window.__chatTrackerRows || new Map();

  Object.entries(updates).forEach(([entryId, attrs]) => {
    const safeId = sanitizeEntryId(entryId);
    if (!safeId) return;

    if (attrs && typeof attrs === 'object' && typeof attrs.detectedAt === 'number') {
      timerMeta.set(safeId, {
        detectedAt: attrs.detectedAt,
        breachThreshold: typeof attrs.breachThreshold === 'number' ? attrs.breachThreshold : 60,
        warningThreshold: typeof attrs.warningThreshold === 'number' ? attrs.warningThreshold : 20,
      });
    } else {
      // Dropped - clear local state and any lingering DOM attrs.
      timerMeta.delete(safeId);
      const row = rows.get(safeId);
      if (row) {
        row.removeAttribute('data-timer-text');
        row.removeAttribute('data-warning');
        row.removeAttribute('data-overdue');
      }
    }
  });

  // Render immediately so the user sees fresh values without waiting for the next tick.
  tickTimers();
}

// Local 1s tick - computes countdown + warning/overdue from cached metadata.
// Runs independently of SCAN_RESULT round-trips, so timers stay live.
function tickTimers() {
  const rows = window.__chatTrackerRows || new Map();
  const now = Date.now();

  for (const [entryId, meta] of timerMeta.entries()) {
    const row = rows.get(entryId);
    if (!row) {
      // Row no longer in DOM-derived map - drop the stale meta entry.
      timerMeta.delete(entryId);
      continue;
    }

    const elapsed = (now - meta.detectedAt) / 1000;
    const remaining = Math.max(0, Math.ceil(meta.breachThreshold - elapsed));
    const isBreached = elapsed >= meta.breachThreshold;
    const isWarning = !isBreached && elapsed >= meta.warningThreshold;

    row.setAttribute('data-timer-text', remaining + 's');

    if (isWarning) row.setAttribute('data-warning', 'true');
    else row.removeAttribute('data-warning');

    if (isBreached) row.setAttribute('data-overdue', 'true');
    else row.removeAttribute('data-overdue');
  }
}

function cleanupRemovedRows(currentIds) {
  const rows = window.__chatTrackerRows || new Map();

  for (const [entryId, row] of rows.entries()) {
    if (!currentIds.has(entryId)) {
      row.removeAttribute('data-timer-text');
      row.removeAttribute('data-warning');
      row.removeAttribute('data-overdue');
      timerMeta.delete(entryId);
    }
  }
}

// Web Audio synthesis — produces distinct tones per sound type.
function getAudioCtx() {
  if (!sharedAudioCtx) {
    sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();
  return sharedAudioCtx;
}

function playSound(soundType, volume) {
  console.log('[Content] playSound called', { soundType, volume });
  const ctx = getAudioCtx();
  const t = ctx.currentTime;
  const vol = Math.max(0, Math.min(100, volume)) / 100;

  if (soundType === 'chime') {
    // Two ascending sine notes (C5 → E5).
    const o1 = ctx.createOscillator(), g1 = ctx.createGain();
    o1.connect(g1); g1.connect(ctx.destination);
    o1.type = 'sine'; o1.frequency.setValueAtTime(523.25, t);
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.exponentialRampToValueAtTime(vol * 0.3, t + 0.02);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o1.start(t); o1.stop(t + 0.22);

    const o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o2.connect(g2); g2.connect(ctx.destination);
    o2.type = 'sine'; o2.frequency.setValueAtTime(659.25, t + 0.15);
    g2.gain.setValueAtTime(0.0001, t + 0.15);
    g2.gain.exponentialRampToValueAtTime(vol * 0.3, t + 0.17);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o2.start(t + 0.15); o2.stop(t + 0.47);

  } else if (soundType === 'alert') {
    // Urgent sawtooth double-pulse at 660 Hz.
    const o1 = ctx.createOscillator(), g1 = ctx.createGain();
    o1.connect(g1); g1.connect(ctx.destination);
    o1.type = 'sawtooth'; o1.frequency.setValueAtTime(660, t);
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.exponentialRampToValueAtTime(vol * 0.2, t + 0.01);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o1.start(t); o1.stop(t + 0.13);

    const o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o2.connect(g2); g2.connect(ctx.destination);
    o2.type = 'sawtooth'; o2.frequency.setValueAtTime(660, t + 0.16);
    g2.gain.setValueAtTime(0.0001, t + 0.16);
    g2.gain.exponentialRampToValueAtTime(vol * 0.2, t + 0.17);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o2.start(t + 0.16); o2.stop(t + 0.3);

  } else if (soundType === 'bell') {
    // Sine fundamental (800 Hz) + quiet 3rd-harmonic overtone, long decay.
    const o1 = ctx.createOscillator(), g1 = ctx.createGain();
    o1.connect(g1); g1.connect(ctx.destination);
    o1.type = 'sine'; o1.frequency.setValueAtTime(800, t);
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.exponentialRampToValueAtTime(vol * 0.3, t + 0.01);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o1.start(t); o1.stop(t + 0.62);

    const o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o2.connect(g2); g2.connect(ctx.destination);
    o2.type = 'sine'; o2.frequency.setValueAtTime(2400, t);
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(vol * 0.1, t + 0.005);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o2.start(t); o2.stop(t + 0.32);

  } else if (soundType === 'notification') {
    // Three quick ascending triangle notes (G5 → B5 → D6).
    const notes = [783.99, 987.77, 1174.66];
    notes.forEach((freq, i) => {
      const off = i * 0.12;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'triangle'; osc.frequency.setValueAtTime(freq, t + off);
      gain.gain.setValueAtTime(0.0001, t + off);
      gain.gain.exponentialRampToValueAtTime(vol * 0.3, t + off + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.12);
      osc.start(t + off); osc.stop(t + off + 0.14);
    });

  } else {
    // Beep (default): single square-wave pulse at 880 Hz.
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'square'; osc.frequency.setValueAtTime(880, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol * 0.25, t + 0.02);
    gain.gain.setValueAtTime(vol * 0.25, t + 0.18);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.start(t); osc.stop(t + 0.23);
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isTrustedSender(sender)) return;

  if (request.type === 'UPDATE_ROWS') {
    if (!isValidUpdateMessage(request)) {
      console.warn('[Content] Rejected malformed UPDATE_ROWS message');
      return;
    }
    console.log('[Content] UPDATE_ROWS message received', { updateCount: Object.keys(request.updates).length });
    applyRowAttributes(request.updates);
    cleanupRemovedRows(new Set(Object.keys(request.updates)));
  } else if (request.type === 'PLAY_SOUND') {
    if (!isValidPlaySoundMessage(request)) {
      console.warn('[Content] Rejected malformed PLAY_SOUND message');
      return;
    }
    console.log('[Content] PLAY_SOUND message received', { soundType: request.soundType, volume: request.volume });
    playSound(request.soundType, request.volume);
  }
});

//---------------SELECTORS AND THEIR IDS------------------------------------
const REQUIRED_SELECTORS = [
  { selector: 'div[data-test-id="status-badge-new"]',           label: 'status-badge-new'           },
  { selector: 'div[data-test-id="status-badge-open"]',          label: 'status-badge-open'          },
  { selector: 'td[data-test-id="ticket-table-cells-assignee"]', label: 'ticket-table-cells-assignee' },
];

function findMissingSelectors() {
  return REQUIRED_SELECTORS.filter(({ selector }) => {
    try {
      return document.querySelector(selector) === null;
    } catch (_e) {
      // EXCEPTION NOT DONE YET
      return true;
    }
  });
}

let healthWarningEl = null;
function showSelectorHealthWarning(missing) {
  if (healthWarningEl) return; // already shown
  healthWarningEl = document.createElement('div');
  healthWarningEl.setAttribute('role', 'alert');
  healthWarningEl.setAttribute('aria-live', 'polite');
  healthWarningEl.style.cssText = [
    'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
    'max-width:360px', 'padding:10px 14px',
    'background:#b71c1c', 'color:#fff',
    'font:600 12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif',
    'border-radius:6px', 'box-shadow:0 4px 12px rgba(0,0,0,.25)',
    'pointer-events:auto',
  ].join(';');
  healthWarningEl.textContent =
    'Chat Monitor: Zendesk page markup may have changed — selectors missing: ' +
    missing.map((m) => m.label).join(', ') +
    '. Monitoring may be inaccurate. Please update the extension.';
  healthWarningEl.addEventListener('click', () => healthWarningEl?.remove());
  document.body && document.body.appendChild(healthWarningEl);
}

function validateSelectors() {
  const MAX_ATTEMPTS = 10;
  let attempts = 0;
  const check = () => {
    attempts++;
    const missing = findMissingSelectors();
    if (missing.length === 0) {
      console.log('[Content] Selector health check passed');
      return;
    }
    if (attempts >= MAX_ATTEMPTS) {
      console.warn('[Content] Selector health check failed:', missing.map((m) => m.label));
      showSelectorHealthWarning(missing);
      return;
    }
    setTimeout(check, 1000);
  };
  setTimeout(check, 1000);
}

// Start scanning
const scanIntervalId = setInterval(scanForUnassignedChats, config.scanInterval);

// Visual timer tick - independent of SCAN_RESULT round-trips.
const tickIntervalId = setInterval(tickTimers, 1000);

// Initial scan
scanForUnassignedChats();

// Kick off the selector health check.
validateSelectors();

// Cleanup on unload
window.addEventListener('unload', () => {
  clearInterval(scanIntervalId);
  clearInterval(tickIntervalId);
});

console.log('[Chat Tracker] Content script loaded');

})();
