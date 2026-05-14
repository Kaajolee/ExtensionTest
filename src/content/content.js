// Zendesk Chat Tracker - Content Script
// Scans DOM for unassigned chats and maintains visual indicators

import './content.css'

// SECURITY (audit finding #1, CRITICAL): the entire content-script body is
// wrapped in an IIFE so that no identifier - config, sharedAudioCtx,
// sanitizeEntryId, scanForUnassignedChats, applyRowAttributes, playSound,
// etc. - is reachable from page-world scripts. Chrome's isolated worlds
// already prevent cross-context access in practice, but the audit asked for
// explicit module-scope isolation as defense-in-depth, and the IIFE makes
// the intent obvious for future maintainers.
(function () {
'use strict';

const config = {
  scanInterval: 1000, // 1 second
  // SECURITY: entryId pattern - only allow safe characters (alphanumeric, hyphens, underscores, hash, dot)
  // Prevents storing arbitrary strings extracted from the DOM if Zendesk markup is tampered with.
  entryIdPattern: /^[a-zA-Z0-9_\-#.]{1,64}$/,
};

let lastCandidates = new Set();

// SECURITY: Reusable AudioContext - matches standalone-script behavior, prevents resource churn.
// Created lazily because some browsers block AudioContext until a user gesture.
let sharedAudioCtx = null;

// SECURITY: Sanitize entryId extracted from DOM.
// DOM data is untrusted; if the page is compromised, an attacker could inject malicious IDs.
// Returning null causes the caller to skip the row.
function sanitizeEntryId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!config.entryIdPattern.test(trimmed)) {
    console.warn('[Content] Rejected invalid entryId:', trimmed.slice(0, 32));
    return null;
  }
  return trimmed;
}

// SECURITY: Validate UPDATE_ROWS message shape from service worker.
function isValidUpdateMessage(request) {
  if (!request || typeof request !== 'object') return false;
  if (!request.updates || typeof request.updates !== 'object') return false;
  return true;
}

// SECURITY: Validate PLAY_SOUND message shape from service worker.
function isValidPlaySoundMessage(request) {
  if (!request || typeof request !== 'object') return false;
  if (typeof request.volume !== 'number') return false;
  if (request.volume < 0 || request.volume > 100) return false;
  return true;
}

// SECURITY: Verify message originates from the extension itself, not from page scripts.
// Page scripts cannot use chrome.runtime.sendMessage, but defense-in-depth: confirm sender.id
// matches our extension when present.
function isTrustedSender(sender) {
  if (!sender) return false;
  // Messages from the extension's own service worker have sender.id === chrome.runtime.id
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
    // SECURITY: Sanitize entryId before storing/transmitting
    const rawId = row.innerText.split('\n')[0].trim() || row.getAttribute('data-test-id');
    const entryId = sanitizeEntryId(rawId);
    if (!entryId) return; // Skip rows with invalid IDs

    currentCandidateIds.add(entryId);
    candidates.push({ entryId, source, row });
  });

  // Only send message if the set of candidates changed
  const candidateIds = new Set(candidates.map(c => c.entryId));
  if (JSON.stringify(Array.from(candidateIds).sort()) !== JSON.stringify(Array.from(lastCandidates).sort())) {
    lastCandidates = candidateIds;

    const scanData = candidates.map(c => ({ entryId: c.entryId, source: c.source }));
    chrome.runtime.sendMessage({
      type: 'SCAN_RESULT',
      candidates: scanData,
      timestamp: Date.now(),
    }).catch((err) => {
      // Service worker might not be ready, ignore
      console.error('[Content] Failed to send SCAN_RESULT message to service worker', err);
    });
  }

  // Store row references for later attribute updates
  window.__chatTrackerRows = new Map(candidates.map(c => [c.entryId, c.row]));
}

function applyRowAttributes(updates) {
  console.log('[Content] applyRowAttributes core logic called', { updateCount: Object.keys(updates).length });
  const rows = window.__chatTrackerRows || new Map();

  Object.entries(updates).forEach(([entryId, attrs]) => {
    // SECURITY: Re-validate entryId on the receiving side as defense-in-depth.
    const safeId = sanitizeEntryId(entryId);
    if (!safeId) return;

    const row = rows.get(safeId);
    if (!row) return;

    // SECURITY: Coerce attribute values - only strings/booleans accepted, no objects/functions.
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

  // SECURITY: Reuse a single AudioContext rather than creating one per beep.
  // Prevents resource leaks if PLAY_SOUND messages arrive in rapid succession.
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

  // SECURITY: Clamp volume to [0, 100] before normalizing to prevent extreme gain values.
  const safeVolume = Math.max(0, Math.min(100, volume));
  const normalizedVolume = safeVolume / 100;

  gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(normalizedVolume * 0.25, audioCtx.currentTime + 0.02);
  gain.gain.setValueAtTime(normalizedVolume * 0.25, audioCtx.currentTime + 0.18);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);

  osc.start();
  osc.stop(audioCtx.currentTime + 0.23);
}

// Listen for updates from service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // SECURITY: Reject messages from untrusted senders (defense-in-depth).
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

// ---------- Audit finding #11 (LOW): selector health check ----------
//
// All Zendesk DOM selectors the extension depends on are listed here. If
// Zendesk renames any of these data-test-id attributes (which has happened
// before and will happen again), the extension stops detecting chats
// silently - agents would believe they are being monitored when they are
// not. We poll for these selectors during the first ~10 seconds after the
// content script loads and surface a visible warning banner on the Zendesk
// page if anything still resolves to zero matches.
const REQUIRED_SELECTORS = [
  // At least one status badge must exist on the agent filters page. If
  // BOTH are missing the queue is either empty (acceptable) or the markup
  // has changed (not acceptable) - we treat persistent absence of either
  // selector definition as a markup change.
  { selector: 'div[data-test-id="status-badge-new"]',           label: 'status-badge-new'           },
  { selector: 'div[data-test-id="status-badge-open"]',          label: 'status-badge-open'          },
  { selector: 'td[data-test-id="ticket-table-cells-assignee"]', label: 'ticket-table-cells-assignee' },
];

function findMissingSelectors() {
  // A selector is considered "missing" if its CSS rule itself produces no
  // matches anywhere in the document. An empty queue legitimately yields
  // zero status-badge-* rows, so the health check waits past the initial
  // page render before deciding the selectors are broken.
  return REQUIRED_SELECTORS.filter(({ selector }) => {
    try {
      return document.querySelector(selector) === null;
    } catch (_e) {
      // Malformed selector (e.g. due to a typo in a future change) also
      // counts as missing.
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
  // Inline styles so we don't depend on a CSS rule being injected/loaded.
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
  // Make the banner dismissible so it isn't permanently in the agent's face.
  healthWarningEl.addEventListener('click', () => healthWarningEl?.remove());
  document.body && document.body.appendChild(healthWarningEl);
}

function validateSelectors() {
  // Poll up to 10 times at 1s intervals. The page may be lazy-loading the
  // queue, so we give it a generous window to settle before flagging.
  const MAX_ATTEMPTS = 10;
  let attempts = 0;
  const check = () => {
    attempts++;
    const missing = findMissingSelectors();
    if (missing.length === 0) {
      // Found everything at least once - we're confident the markup hasn't
      // moved. Stop polling.
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
  // Wait a tick for the initial DOM render before we even start polling.
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

})(); // end IIFE
