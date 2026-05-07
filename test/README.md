# Offline Test Harness

A static page that mimics the bits of Zendesk's agent dashboard the
extension cares about: status badges with `data-test-id="status-badge-new"`
or `status-badge-open`, and an assignee cell with
`data-test-id="ticket-table-cells-assignee"`. Everything else is
synthetic.

## What it gives you

- A control panel for spawning rows: `New`, `Open (unassigned)`,
  `Open (assigned)`, plus a five-at-once button and a clear-all button.
- Per-row buttons to assign / unassign / delete on the fly.
- Live counters (total / unassigned / assigned).
- A status pill (top-right) that lights up green once it sees the
  extension applying its `data-timer-text`, `data-warning`, or
  `data-overdue` attributes — i.e. the extension is working.

## Setup (once)

1. Build the extension:
   ```bash
   npm run build
   ```
2. Load the unpacked `dist/` folder in `chrome://extensions/` (or
   `edge://extensions/`) with **Developer mode** on.

## Run the harness

```bash
npm run test:serve
```

Opens a static server on `http://localhost:8080`. Visit that URL.

Different port? Set `PORT=3001 npm run test:serve` — but remember the
extension's `manifest.json` only lists `localhost:8080` and
`127.0.0.1:8080`, so you'd need to add your port and rebuild.

## Verifying the extension works

1. Reload the page after loading the extension. Within ~5 s the status
   pill should switch from grey to green ("Extension: active").
2. Click `+ Add NEW (unassigned)` a few times. Each row should pick up a
   countdown timer (`data-timer-text`) within ~1 s.
3. Click `+ Add OPEN (assigned)`. That row should **not** get a timer —
   it has an assignee, so the extension ignores it.
4. Wait until the timer hits the warning threshold (default 20 s
   remaining) — row turns yellow with a left border.
5. Wait until breach (default 0 s) — row turns red and a beep plays
   (configurable in the extension popup).
6. Click `Assign` on a counting-down row → its timer should disappear
   on the next scan.
7. Click `Unassign` on an assigned row → it starts counting again.
8. Open the popup, change thresholds; rows re-evaluate immediately.

## Watching the message flow

- DevTools console on this page → look for `[Content]` and
  `[Chat Tracker]` logs.
- `chrome://extensions/` → click the **Service worker** link under the
  Chat Monitor entry → look for `[ServiceWorker]` logs.
- Right-click the extension icon → **Inspect popup** → look for
  `[Popup]` logs.

You should see, every time the row set changes:

```
[Content] scanForUnassignedChats core logic called
[ServiceWorker] SCAN_RESULT message received { candidateCount: N }
[ServiceWorker] processScan core logic called …
[Content] UPDATE_ROWS message received { updateCount: N }
```

## Notes on the security hardening

The service worker's `TRUSTED_URL_PATTERN` is intentionally extended on
this branch to permit `http://localhost:8080` and
`http://127.0.0.1:8080`. That allowance is scoped to the
`offline-testing` branch — strip it before any merge that lands in
production.

## Files

- `index.html` — the mock dashboard markup.
- `styles.css` — visual styling (cosmetic only; the extension doesn't
  read this).
- `mock.js` — row builders, assign/unassign/delete handlers, and a
  MutationObserver that flips the status pill when the extension acts.
- `server.js` — zero-dependency static file server on port 8080.
