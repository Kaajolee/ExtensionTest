// Zendesk Chat Tracker - Content Script
// Scans DOM for unassigned chats and maintains visual indicators

import './content.css'


(function () {
'use strict';

const config = {
  scanInterval: 1000, // 1 second
  entryIdPattern: /^[a-zA-Z0-9_\-#.]{1,64}$/,
};

let lastCandidates = new Set();

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

  const candidateIds = new Set(candidates.map(c => c.entryId));
  if (JSON.stringify(Array.from(candidateIds).sort()) !== JSON.stringify(Array.from(lastCandidates).sort())) {
    lastCandidates = candidateIds;

    const scanData = candidates.map(c => ({ entryId: c.entryId, source: c.source }));
    chrome.runtime.sendMessage({
      type: 'SCAN_RESULT',
      candidates: scanData,
      timestamp: Date.now(),
    }).catch((err) => {
      console.error('[Content] Failed to send SCAN_RESULT message to service worker', err);
    });
  }

  window.__chatTrackerRows = new Map(candidates.map(c => [c.entryId, c.row]));
}

function applyRowAttributes(updates) {
  console.log('[Content] applyRowAttributes core logic called', { updateCount: Object.keys(updates).length });
  const rows = window.__chatTrackerRows || new Map();

  Object.entries(updates).forEach(([entryId, attrs]) => {
    const safeId = sanitizeEntryId(entryId);
    if (!safeId) return;

    const row = rows.get(safeId);
    if (!row) return;

    if (attrs && typeof attrs === 'object') {
      if (attrs.timer !== undefined && typeof attrs.timer === 'string') {
        row.setAttribute('data-timer-text', attrs.timer);
      } else {
        row.removeAttribute('data-timer-text');
      }

      if (attrs.warning === true) {
        row.setAttribute('data-warning', 'true');
      } else {
        row.removeAttribute('data-warning');
      }

      if (attrs.overdue === true) {
        row.setAttribute('data-overdue', 'true');
      } else {
        row.removeAttribute('data-overdue');
      }
    }
  });
}

function cleanupRemovedRows(currentIds) {
  const rows = window.__chatTrackerRows || new Map();

  for (const [entryId, row] of rows.entries()) {
    if (!currentIds.has(entryId)) {
      row.removeAttribute('data-timer-text');
      row.removeAttribute('data-warning');
      row.removeAttribute('data-overdue');
    }
  }
}

function playSound(soundType, volume) {
  console.log('[Content] playSound core logic called', { soundType, volume });

  if (!sharedAudioCtx) {
    sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const audioCtx = sharedAudioCtx;

  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.type = 'square';
  osc.frequency.setValueAtTime(880, audioCtx.currentTime);

  const safeVolume = Math.max(0, Math.min(100, volume));
  const normalizedVolume = safeVolume / 100;

  gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(normalizedVolume * 0.25, audioCtx.currentTime + 0.02);
  gain.gain.setValueAtTime(normalizedVolume * 0.25, audioCtx.currentTime + 0.18);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);

  osc.start();
  osc.stop(audioCtx.currentTime + 0.23);
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

// Initial scan
scanForUnassignedChats();

// Kick off the selector health check.
validateSelectors();

// Cleanup on unload
window.addEventListener('unload', () => {
  clearInterval(scanIntervalId);
});

console.log('[Chat Tracker] Content script loaded');

})();
