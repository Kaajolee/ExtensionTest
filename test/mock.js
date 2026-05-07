// Zendesk Mock — Chat Monitor Test Harness
// Spawns synthetic chat rows with the same data-test-id selectors the
// extension's content script looks for. Lets you exercise the full flow
// without ever talking to real Zendesk.

(() => {
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
  ];

  const SAMPLE_REQUESTERS = [
    'Alex Johnson', 'Maria Silva', 'Jordan Lee', 'Priya Patel',
    'Chen Wei', 'Sam Becker', 'Olivia Brown', 'Diego Ramirez',
    'Yuki Tanaka', 'Ahmed Hassan',
  ];

  const SAMPLE_ASSIGNEES = [
    'Lina Foster', 'Marcus Reed', 'Hana Park', 'Dimitri Kovac',
  ];

  const ASSIGNEE_EMPTY_VARIANTS = ['', '-', '—', 'unassigned'];

  let nextId = 1001;

  const tbody = document.getElementById('ticket-rows');
  const emptyState = document.getElementById('empty-state');
  const statTotal = document.getElementById('stat-total');
  const statUnassigned = document.getElementById('stat-unassigned');
  const statAssigned = document.getElementById('stat-assigned');
  const extDot = document.getElementById('extension-status');
  const extText = document.getElementById('extension-status-text');

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function makeTicketId() {
    return 'TICKET-' + (nextId++);
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

  // Builds a row whose first text line is the ticket id (so the extension's
  //   row.innerText.split('\n')[0].trim()
  // returns a clean ID like "TICKET-1001". The status badge sits below it
  // inside the same status cell, then the rest of the columns follow.
  function buildRow({ status, assigned }) {
    const id = makeTicketId();
    const subject = pick(SAMPLE_SUBJECTS);
    const requester = pick(SAMPLE_REQUESTERS);
    const assignee = assigned
      ? pick(SAMPLE_ASSIGNEES)
      : pick(ASSIGNEE_EMPTY_VARIANTS);

    const tr = document.createElement('tr');
    tr.setAttribute('data-test-id', 'ticket-row-' + id.toLowerCase());

    // Status cell — the ticket id goes first as a block-level <div> so
    // innerText puts it on line 1; the badge sits below it.
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

    // Subject
    const tdSubject = document.createElement('td');
    const subjDiv = document.createElement('div');
    subjDiv.className = 'subject';
    subjDiv.textContent = subject;
    tdSubject.appendChild(subjDiv);
    tr.appendChild(tdSubject);

    // Requester
    const tdRequester = document.createElement('td');
    tdRequester.className = 'requester-name';
    tdRequester.textContent = requester;
    tr.appendChild(tdRequester);

    // Assignee — must carry data-test-id="ticket-table-cells-assignee"
    const tdAssignee = document.createElement('td');
    tdAssignee.setAttribute('data-test-id', 'ticket-table-cells-assignee');
    setAssigneeText(tdAssignee, assignee);
    tr.appendChild(tdAssignee);

    // Updated
    const tdUpdated = document.createElement('td');
    tdUpdated.textContent = 'just now';
    tr.appendChild(tdUpdated);

    // Actions
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

  function spawn(opts) {
    const tr = buildRow(opts);
    tbody.appendChild(tr);
    updateStats();
    return tr;
  }

  function clearAll() {
    tbody.innerHTML = '';
    updateStats();
  }

  function updateStats() {
    const rows = Array.from(tbody.querySelectorAll('tr'));
    let unassigned = 0;
    rows.forEach((tr) => {
      const cell = tr.querySelector('td[data-test-id="ticket-table-cells-assignee"]');
      if (!cell) return;
      const t = (cell.textContent || '').trim();
      if (t === '' || t === '-' || t === '—' || /^(unassigned|-)$/i.test(t)) unassigned++;
    });
    statTotal.textContent = String(rows.length);
    statUnassigned.textContent = String(unassigned);
    statAssigned.textContent = String(rows.length - unassigned);
    emptyState.style.display = rows.length === 0 ? 'block' : 'none';
  }

  // Detect whether the extension is active by watching for the attributes
  // it applies to rows (data-timer-text, data-warning, data-overdue).
  let extensionActive = false;
  function markExtensionActive() {
    if (extensionActive) return;
    extensionActive = true;
    extDot.classList.remove('dot-unknown', 'dot-inactive');
    extDot.classList.add('dot-active');
    extText.textContent = 'Extension: active';
  }

  function watchExtensionActivity() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (
          m.type === 'attributes' &&
          (m.attributeName === 'data-timer-text' ||
            m.attributeName === 'data-warning' ||
            m.attributeName === 'data-overdue')
        ) {
          markExtensionActive();
          return;
        }
      }
    });
    observer.observe(tbody, {
      attributes: true,
      attributeFilter: ['data-timer-text', 'data-warning', 'data-overdue'],
      subtree: true,
    });
  }

  // After 5s without seeing extension activity, hint to the user.
  setTimeout(() => {
    if (!extensionActive) {
      extDot.classList.remove('dot-unknown');
      extDot.classList.add('dot-inactive');
      extText.textContent =
        'Extension: not detected — load the unpacked dist/ and reload this page';
    }
  }, 5000);

  // Wire up control buttons
  document.querySelectorAll('button[data-action]').forEach((btn) => {
    const action = btn.getAttribute('data-action');
    btn.addEventListener('click', () => {
      switch (action) {
        case 'add-new':
          spawn({ status: 'new', assigned: false });
          break;
        case 'add-open-unassigned':
          spawn({ status: 'open', assigned: false });
          break;
        case 'add-open-assigned':
          spawn({ status: 'open', assigned: true });
          break;
        case 'add-five':
          for (let i = 0; i < 5; i++) {
            spawn({
              status: Math.random() > 0.5 ? 'new' : 'open',
              assigned: false,
            });
          }
          break;
        case 'clear-all':
          clearAll();
          break;
      }
    });
  });

  watchExtensionActivity();
  updateStats();
})();
