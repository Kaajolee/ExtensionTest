// Zendesk Mock — Chat Monitor Test Harness
// Spawns synthetic chat rows with the same data-test-id selectors the
// extension's content script looks for. Lets you exercise the full flow
// without ever talking to real Zendesk.

(() => {
  // ---------- sample data ----------

  const SAMPLE_SUBJECTS = [
    'Cannot reset password',
    'Subscription billing question',
    'Feature request: dark mode',
    'Login redirect loop',
    'API rate limit exceeded',
    'Unable to upload attachment',
    'Refund request — order #482',
    'Email notifications not arriving',
    '2FA code never received',
    'Browser extension breaks layout',
    'Shipping address update',
    'Account merge request',
    'Webhook delivery failures',
    'Mobile app crash on launch',
  ];

  const SAMPLE_REQUESTERS = [
    'Alex Johnson', 'Maria Silva', 'Jordan Lee', 'Priya Patel',
    'Chen Wei', 'Sam Becker', 'Olivia Brown', 'Diego Ramirez',
    'Yuki Tanaka', 'Ahmed Hassan',
  ];

  const SAMPLE_ASSIGNEES = [
    'Lina Foster', 'Marcus Reed', 'Hana Park', 'Dimitri Kovac',
    'Eva Nilsson', 'Theo Bergmann',
  ];

  const ASSIGNEE_EMPTY_VARIANTS = ['', '-', '—', 'unassigned'];

  // ---------- DOM refs ----------

  const tbody = document.getElementById('ticket-rows');
  const emptyState = document.getElementById('empty-state');
  const statTotal = document.getElementById('stat-total');
  const statUnassigned = document.getElementById('stat-unassigned');
  const statAssigned = document.getElementById('stat-assigned');
  const statWarning = document.getElementById('stat-warning');
  const statOverdue = document.getElementById('stat-overdue');
  const extDot = document.getElementById('extension-status');
  const extText = document.getElementById('extension-status-text');
  const bulkCount = document.getElementById('bulk-count');
  const autoSpawnToggle = document.getElementById('auto-spawn');
  const autoSpawnInterval = document.getElementById('auto-spawn-interval');
  const chaosToggle = document.getElementById('chaos-mode');
  const logList = document.getElementById('log-list');
  const clearLogBtn = document.getElementById('clear-log');

  // ---------- state ----------

  let nextId = 1001;
  let autoSpawnTimer = null;
  let chaosTimer = null;

  // ---------- helpers ----------

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const makeTicketId = () => 'TICKET-' + nextId++;

  function log(msg) {
    const li = document.createElement('li');
    const ts = new Date().toLocaleTimeString();
    const tsSpan = document.createElement('span');
    tsSpan.className = 'ts';
    tsSpan.textContent = ts;
    li.appendChild(tsSpan);
    li.appendChild(document.createTextNode(msg));
    logList.insertBefore(li, logList.firstChild);
    // Keep the log bounded
    while (logList.children.length > 100) logList.removeChild(logList.lastChild);
  }

  function setAssigneeText(td, name) {
    if (!name || name === 'unassigned' || name === '-' || name === '—') {
      td.classList.add('assignee-empty');
      td.textContent = name || '-';
    } else {
      td.classList.remove('assignee-empty');
      td.textContent = name;
    }
  }

  function mkBtn(label, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------- row builder ----------

  function buildRow({ status, assigned, idOverride }) {
    const id = idOverride || makeTicketId();
    const subject = pick(SAMPLE_SUBJECTS);
    const requester = pick(SAMPLE_REQUESTERS);
    const assignee = assigned ? pick(SAMPLE_ASSIGNEES) : pick(ASSIGNEE_EMPTY_VARIANTS);

    const tr = document.createElement('tr');
    tr.setAttribute('data-test-id', 'ticket-row-' + id.toLowerCase());

    // Status cell — ticket id is a block-level <div> first so it lands on
    // line 1 of innerText (the extension's entryId source).
    const tdStatus = document.createElement('td');
    const idDiv = document.createElement('div');
    idDiv.className = 'ticket-id';
    idDiv.textContent = id;
    tdStatus.appendChild(idDiv);

    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.setAttribute('data-test-id', 'status-badge-' + status);
    badge.textContent = status === 'new' ? 'New' : 'Open';
    tdStatus.appendChild(badge);
    tr.appendChild(tdStatus);

    const tdSubject = document.createElement('td');
    const subjDiv = document.createElement('div');
    subjDiv.className = 'subject';
    subjDiv.textContent = subject;
    tdSubject.appendChild(subjDiv);
    tr.appendChild(tdSubject);

    const tdRequester = document.createElement('td');
    tdRequester.className = 'requester-name';
    tdRequester.textContent = requester;
    tr.appendChild(tdRequester);

    const tdAssignee = document.createElement('td');
    tdAssignee.setAttribute('data-test-id', 'ticket-table-cells-assignee');
    setAssigneeText(tdAssignee, assignee);
    tr.appendChild(tdAssignee);

    const tdUpdated = document.createElement('td');
    tdUpdated.textContent = 'just now';
    tr.appendChild(tdUpdated);

    const tdActions = document.createElement('td');
    tdActions.className = 'row-actions';
    tdActions.append(
      mkBtn('Assign', () => assignRow(tr)),
      mkBtn('Unassign', () => unassignRow(tr)),
      mkBtn('Delete', () => deleteRow(tr)),
    );
    tr.appendChild(tdActions);

    return tr;
  }

  function spawn(opts) {
    const tr = buildRow(opts);
    tbody.appendChild(tr);
    updateStats();
    return tr;
  }

  // ---------- single-row actions ----------

  function assignRow(tr) {
    const cell = tr.querySelector('td[data-test-id="ticket-table-cells-assignee"]');
    if (cell) setAssigneeText(cell, pick(SAMPLE_ASSIGNEES));
    updateStats();
  }

  function unassignRow(tr) {
    const cell = tr.querySelector('td[data-test-id="ticket-table-cells-assignee"]');
    if (cell) setAssigneeText(cell, pick(ASSIGNEE_EMPTY_VARIANTS));
    updateStats();
  }

  function deleteRow(tr) {
    tr.remove();
    updateStats();
  }

  // ---------- bulk ----------

  function bulkAdd(n, { assigned }) {
    n = Math.max(1, Math.min(200, Number(n) || 1));
    for (let i = 0; i < n; i++) {
      spawn({
        status: Math.random() > 0.5 ? 'new' : 'open',
        assigned,
      });
    }
    log(`Bulk +${n} ${assigned ? 'assigned' : 'unassigned'}`);
  }

  function clearAll() {
    const n = tbody.children.length;
    tbody.innerHTML = '';
    updateStats();
    log(`Cleared ${n} row${n === 1 ? '' : 's'}`);
  }

  // ---------- mass actions ----------

  function assignAll() {
    const rows = Array.from(tbody.querySelectorAll('tr'));
    let touched = 0;
    rows.forEach((tr) => {
      const cell = tr.querySelector('td[data-test-id="ticket-table-cells-assignee"]');
      if (!cell) return;
      const t = (cell.textContent || '').trim();
      if (t === '' || t === '-' || t === '—' || /^(unassigned|-)$/i.test(t)) {
        setAssigneeText(cell, pick(SAMPLE_ASSIGNEES));
        touched++;
      }
    });
    updateStats();
    log(`Assigned ${touched} row${touched === 1 ? '' : 's'}`);
  }

  function unassignAll() {
    const rows = Array.from(tbody.querySelectorAll('tr'));
    let touched = 0;
    rows.forEach((tr) => {
      const cell = tr.querySelector('td[data-test-id="ticket-table-cells-assignee"]');
      if (!cell) return;
      const t = (cell.textContent || '').trim();
      if (t !== '' && t !== '-' && t !== '—' && !/^(unassigned|-)$/i.test(t)) {
        setAssigneeText(cell, pick(ASSIGNEE_EMPTY_VARIANTS));
        touched++;
      }
    });
    updateStats();
    log(`Unassigned ${touched} row${touched === 1 ? '' : 's'}`);
  }

  function deleteRandom() {
    const rows = tbody.querySelectorAll('tr');
    if (!rows.length) return;
    const tr = rows[Math.floor(Math.random() * rows.length)];
    tr.remove();
    updateStats();
    log('Deleted random row');
  }

  // ---------- scenarios ----------

  const SCENARIOS = {
    quiet: () => {
      clearAll();
      for (let i = 0; i < 2; i++) spawn({ status: 'open', assigned: false });
      for (let i = 0; i < 3; i++) spawn({ status: 'open', assigned: true });
      log('Scenario: quiet day (2 unassigned, 3 assigned)');
    },
    busy: () => {
      clearAll();
      for (let i = 0; i < 7; i++) spawn({ status: 'open', assigned: false });
      for (let i = 0; i < 3; i++) spawn({ status: 'new', assigned: false });
      for (let i = 0; i < 5; i++) spawn({ status: 'open', assigned: true });
      log('Scenario: busy queue (10 unassigned, 5 assigned)');
    },
    stress: () => {
      clearAll();
      for (let i = 0; i < 50; i++) {
        spawn({
          status: Math.random() > 0.5 ? 'new' : 'open',
          assigned: false,
        });
      }
      for (let i = 0; i < 20; i++) spawn({ status: 'open', assigned: true });
      log('Scenario: stress test (70 rows)');
    },
    edge: () => {
      clearAll();
      // Long ID (the extension caps at 64 chars; this is exactly 64)
      spawn({ status: 'new', assigned: false, idOverride: 'A'.repeat(64) });
      // Just past the cap (extension should reject this one)
      spawn({ status: 'new', assigned: false, idOverride: 'B'.repeat(80) });
      // Hash-prefixed
      spawn({ status: 'open', assigned: false, idOverride: '#9001' });
      // Dot in name (allowed by sanitizer)
      spawn({ status: 'open', assigned: false, idOverride: 'TKT.42.X' });
      // Duplicate id — extension dedupes by id, so the second instance
      // shouldn't get its own timer.
      spawn({ status: 'open', assigned: false, idOverride: 'DUPE-1' });
      spawn({ status: 'open', assigned: false, idOverride: 'DUPE-1' });
      // Weird-but-empty assignee variants
      const tr1 = spawn({ status: 'open', assigned: false });
      const c1 = tr1.querySelector('td[data-test-id="ticket-table-cells-assignee"]');
      if (c1) setAssigneeText(c1, '—');
      const tr2 = spawn({ status: 'open', assigned: false });
      const c2 = tr2.querySelector('td[data-test-id="ticket-table-cells-assignee"]');
      if (c2) setAssigneeText(c2, 'UNASSIGNED');
      log('Scenario: edge cases (long IDs, dupes, weird assignees)');
    },
  };

  // ---------- auto-spawn ----------

  function startAutoSpawn() {
    stopAutoSpawn();
    const seconds = Math.max(1, Math.min(60, Number(autoSpawnInterval.value) || 5));
    autoSpawnTimer = setInterval(() => {
      spawn({
        status: Math.random() > 0.5 ? 'new' : 'open',
        assigned: false,
      });
    }, seconds * 1000);
    log(`Auto-spawn on (every ${seconds}s)`);
  }
  function stopAutoSpawn() {
    if (autoSpawnTimer) {
      clearInterval(autoSpawnTimer);
      autoSpawnTimer = null;
      log('Auto-spawn off');
    }
  }

  // ---------- chaos mode ----------

  function startChaos() {
    stopChaos();
    chaosTimer = setInterval(() => {
      const rows = tbody.querySelectorAll('tr');
      const choice = Math.random();
      if (rows.length === 0 || choice < 0.4) {
        spawn({ status: Math.random() > 0.5 ? 'new' : 'open', assigned: false });
      } else if (choice < 0.7) {
        const tr = rows[Math.floor(Math.random() * rows.length)];
        assignRow(tr);
      } else if (choice < 0.9) {
        const tr = rows[Math.floor(Math.random() * rows.length)];
        unassignRow(tr);
      } else {
        const tr = rows[Math.floor(Math.random() * rows.length)];
        tr.remove();
        updateStats();
      }
    }, 1500);
    log('Chaos mode on');
  }
  function stopChaos() {
    if (chaosTimer) {
      clearInterval(chaosTimer);
      chaosTimer = null;
      log('Chaos mode off');
    }
  }

  // ---------- stats ----------

  function updateStats() {
    const rows = Array.from(tbody.querySelectorAll('tr'));
    let unassigned = 0;
    let warning = 0;
    let overdue = 0;
    rows.forEach((tr) => {
      const cell = tr.querySelector('td[data-test-id="ticket-table-cells-assignee"]');
      if (cell) {
        const t = (cell.textContent || '').trim();
        if (t === '' || t === '-' || t === '—' || /^(unassigned|-)$/i.test(t)) unassigned++;
      }
      if (tr.getAttribute('data-warning') === 'true') warning++;
      if (tr.getAttribute('data-overdue') === 'true') overdue++;
    });
    statTotal.textContent = String(rows.length);
    statUnassigned.textContent = String(unassigned);
    statAssigned.textContent = String(rows.length - unassigned);
    statWarning.textContent = String(warning);
    statOverdue.textContent = String(overdue);
    emptyState.style.display = rows.length === 0 ? 'block' : 'none';
  }

  // ---------- extension activity detection ----------

  let extensionActive = false;
  function markExtensionActive() {
    if (extensionActive) return;
    extensionActive = true;
    extDot.classList.remove('dot-unknown', 'dot-inactive');
    extDot.classList.add('dot-active');
    extText.textContent = 'Extension: active';
    log('Extension detected (data attributes applied)');
  }

  function watchExtensionActivity() {
    const observer = new MutationObserver((mutations) => {
      let touched = false;
      for (const m of mutations) {
        if (
          m.type === 'attributes' &&
          (m.attributeName === 'data-timer-text' ||
            m.attributeName === 'data-warning' ||
            m.attributeName === 'data-overdue')
        ) {
          touched = true;
          markExtensionActive();
        }
      }
      if (touched) updateStats();
    });
    observer.observe(tbody, {
      attributes: true,
      attributeFilter: ['data-timer-text', 'data-warning', 'data-overdue'],
      subtree: true,
    });
  }

  setTimeout(() => {
    if (!extensionActive) {
      extDot.classList.remove('dot-unknown');
      extDot.classList.add('dot-inactive');
      extText.textContent =
        'Extension: not detected — load the unpacked dist/ and reload this page';
      log('Extension not detected after 5s');
    }
  }, 5000);

  // ---------- wiring ----------

  const ACTIONS = {
    'add-new': () => { spawn({ status: 'new', assigned: false }); log('+1 NEW unassigned'); },
    'add-open-unassigned': () => { spawn({ status: 'open', assigned: false }); log('+1 OPEN unassigned'); },
    'add-open-assigned': () => { spawn({ status: 'open', assigned: true }); log('+1 OPEN assigned'); },
    'bulk-add-unassigned': () => bulkAdd(bulkCount.value, { assigned: false }),
    'bulk-add-assigned': () => bulkAdd(bulkCount.value, { assigned: true }),
    'scenario-quiet': SCENARIOS.quiet,
    'scenario-busy': SCENARIOS.busy,
    'scenario-stress': SCENARIOS.stress,
    'scenario-edge': SCENARIOS.edge,
    'assign-all': assignAll,
    'unassign-all': unassignAll,
    'delete-random': deleteRandom,
    'clear-all': clearAll,
  };

  document.querySelectorAll('button[data-action]').forEach((btn) => {
    const action = btn.getAttribute('data-action');
    btn.addEventListener('click', () => {
      const handler = ACTIONS[action];
      if (handler) handler();
    });
  });

  autoSpawnToggle.addEventListener('change', () => {
    if (autoSpawnToggle.checked) startAutoSpawn();
    else stopAutoSpawn();
  });
  autoSpawnInterval.addEventListener('change', () => {
    if (autoSpawnToggle.checked) startAutoSpawn(); // restart with new interval
  });

  chaosToggle.addEventListener('change', () => {
    if (chaosToggle.checked) startChaos();
    else stopChaos();
  });

  clearLogBtn.addEventListener('click', () => {
    logList.innerHTML = '';
  });

  watchExtensionActivity();
  updateStats();
  log('Harness ready');
})();
