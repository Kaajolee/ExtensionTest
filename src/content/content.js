// Zendesk Chat Tracker - Content Script
// Scans DOM for unassigned chats and maintains visual indicators

import './content.css'

const config = {
  scanInterval: 1000, // 1 second
  // SECURITY: entryId pattern - only allow safe characters (alphanumeric, hyphens, underscores, hash, dot)
  // Prevents storing arbitrary strings extracted from the DOM if Zendesk markup is tampered with.
  entryIdPattern: /^[a-zA-Z0-9_\-#.]{1,64}$/,
};

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

// Resolve the entryId for a row, caching the result on the row itself.
// Caching matters because the timer chip we inject below would otherwise
// pollute row.innerText on subsequent scans (the timer text would shift the
// first-line lookup). It also avoids re-running the regex every tick.
function getEntryId(row) {
  let cached = row.getAttribute('data-chat-tracker-id');
  if (cached) return cached;
  // Use the timer chip's textContent excluded version: read innerText but
  // strip the chip first if it's already present.
  const chip = row.querySelector('.chat-tracker-timer');
  const raw = chip
    ? (() => {
        const txt = chip.textContent;
        chip.textContent = '';
        const v = row.innerText.split('\n')[0].trim();
        chip.textContent = txt;
        return v;
      })()
    : row.innerText.split('\n')[0].trim();
  const fallback = row.getAttribute('data-test-id');
  const id = sanitizeEntryId(raw) || sanitizeEntryId(fallback);
  if (id) row.setAttribute('data-chat-tracker-id', id);
  return id;
}

// Inject (or fetch) the timer chip element for a row. The chip is a real
// DOM node rather than a CSS ::after pseudo so that it renders reliably on
// table rows and so it can be styled / inspected directly in DevTools.
function ensureTimerChip(row) {
  let chip = row.querySelector(':scope > td .chat-tracker-timer');
  if (chip) return chip;
  // Append into the first <td> as the last child. Putting it after the
  // ticket-id text means the row's innerText still has the id on line 1
  // (defense-in-depth; getEntryId also caches the result).
  const firstCell = row.firstElementChild;
  if (!firstCell || firstCell.tagName !== 'TD') return null;
  chip = document.createElement('div');
  chip.className = 'chat-tracker-timer';
  // Hide from accessibility/innerText harvesters.
  chip.setAttribute('aria-hidden', 'true');
  firstCell.appendChild(chip);
  return chip;
}

function removeTimerChip(row) {
  const chip = row.querySelector('.chat-tracker-timer');
  if (chip) chip.remove();
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
    const entryId = getEntryId(row);
    if (!entryId) return; // Skip rows with invalid IDs
    currentCandidateIds.add(entryId);
    candidates.push({ entryId, source, row });
  });

  // Always send SCAN_RESULT every scan tick (even if the candidate set is
  // unchanged). Reasons:
  //  1. The service worker needs the latest timestamp every second to compute
  //     elapsed time and emit fresh data-timer-text values back to us.
  //  2. Each message resets the MV3 service worker's idle timer; without
  //     periodic traffic the SW gets terminated after ~30s and timer state
  //     is lost.
  const scanData = candidates.map(c => ({ entryId: c.entryId, source: c.source }));
  chrome.runtime.sendMessage({
    type: 'SCAN_RESULT',
    candidates: scanData,
    timestamp: Date.now(),
  }).catch((err) => {
    // Service worker might not be ready, ignore
    console.error('[Content] Failed to send SCAN_RESULT message to service worker', err);
  });

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
        // Drive the injected chip so the user has a visible countdown
        // regardless of host-page CSS quirks around tr::after.
        const chip = ensureTimerChip(row);
        if (chip) chip.textContent = attrs.timer;
      } else {
        row.removeAttribute('data-timer-text');
        removeTimerChip(row);
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
      row.removeAttribute('data-chat-tracker-id');
      removeTimerChip(row);
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

// Start scanning
const scanIntervalId = setInterval(scanForUnassignedChats, config.scanInterval);

// Initial scan
scanForUnassignedChats();

// Cleanup on unload
window.addEventListener('unload', () => {
  clearInterval(scanIntervalId);
});

console.log('[Chat Tracker] Content script loaded');
