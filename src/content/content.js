// ontent Script
// Scans DOM for unassigned chats and maintains visual indicators

import './content.css'

const config = {
  scanInterval: 1000, // 1 second
};

let lastCandidates = new Set();

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
    const entryId = row.innerText.split('\n')[0].trim() || row.getAttribute('data-test-id');
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
    }).catch(() => {
      // Service worker might not be ready, ignore
      console.logerror("[Content] Failed to send SCAN_RESULT message to service worker");
    });
  }

  // Store row references for later attribute updates
  window.__chatTrackerRows = new Map(candidates.map(c => [c.entryId, c.row]));
}

function applyRowAttributes(updates) {
  console.log('[Content] applyRowAttributes core logic called', { updateCount: Object.keys(updates).length });
  const rows = window.__chatTrackerRows || new Map();

  Object.entries(updates).forEach(([entryId, attrs]) => {
    const row = rows.get(entryId);
    if (!row) return;

    if (attrs.timer !== undefined) {
      row.setAttribute('data-timer-text', attrs.timer);
    } else {
      row.removeAttribute('data-timer-text');
    }

    if (attrs.warning) {
      row.setAttribute('data-warning', 'true');
    } else {
      row.removeAttribute('data-warning');
    }

    if (attrs.overdue) {
      row.setAttribute('data-overdue', 'true');
    } else {
      row.removeAttribute('data-overdue');
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
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.type = 'square';
  osc.frequency.setValueAtTime(880, audioCtx.currentTime);

  const normalizedVolume = volume / 100;
  gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(normalizedVolume * 0.25, audioCtx.currentTime + 0.02);
  gain.gain.setValueAtTime(normalizedVolume * 0.25, audioCtx.currentTime + 0.18);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);

  osc.start();
  osc.stop(audioCtx.currentTime + 0.23);
}

// Listen for updates from service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'UPDATE_ROWS') {
    console.log('[Content] UPDATE_ROWS message received', { updateCount: Object.keys(request.updates).length });
    applyRowAttributes(request.updates);
    cleanupRemovedRows(new Set(Object.keys(request.updates)));
  } else if (request.type === 'PLAY_SOUND') {
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
