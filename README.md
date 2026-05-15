# Chat Monitor (Zendesk SLA Timer)

A Chrome extension that monitors unassigned chats on the Zendesk agent
interface and alerts agents before SLA thresholds are breached. Tracks
each chat individually with a live countdown overlay, color-coded warning
and overdue states, and configurable audio alerts.

## Features

- **Per-row live countdown** — Each unassigned chat row gets a timer
  badge that ticks down every second, independent of the chat queue
  refresh cycle.
- **Two-stage SLA alerts** — Warning state (yellow background) when a
  chat approaches the breach threshold, overdue state (red background)
  when it crosses it.
- **5 distinct audio alerts** — Beep, chime, alert, bell, and notification
  sounds, each with its own waveform and envelope. Volume is fully
  controllable from the popup.
- **Settings persistence** — Thresholds, sound type, volume, colors, and
  refresh frequency are stored in `chrome.storage.local` and survive
  browser restarts.
- **Browser-open-only runtime timer** — Tracks how long the extension has
  been active, excluding time the browser was fully closed.
- **Dark mode + customizable colors** — Theme toggle, plus user-selectable
  hex colors for warning and overdue row highlights.
- **DOM health check** — Detects when Zendesk's underlying selectors
  change and shows a visible warning banner on the page so silent
  breakage is impossible.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CHROME BROWSER                        │
│                                                              │
│  ┌──────────────────┐         ┌──────────────────────────┐   │
│  │   Popup (React)  │         │ Content Script (IIFE)    │   │
│  │                  │         │                          │   │
│  │ - Settings UI    │         │ - DOM scan (1s)          │   │
│  │ - Live metrics   │         │ - Local timer tick (1s)  │   │
│  │ - Test playback  │         │ - Sound playback         │   │
│  └────────┬─────────┘         │ - Selector health check  │   │
│           │                   └────────┬─────────────────┘   │
│           │  chrome.runtime            │                     │
│           │  .sendMessage              │                     │
│           ▼                            ▼                     │
│  ┌───────────────────────────────────────────────────────┐   │
│  │              Service Worker                            │   │
│  │  - Authoritative state (activeEntries Map)             │   │
│  │  - Threshold evaluation + breach sound triggering      │   │
│  │  - Settings sanitization + persistence                 │   │
│  │  - Browser-open-only runtime accounting                │   │
│  └─────┬─────────────────────────────────────┬───────────┘   │
│        ▼                                     ▼               │
│  ┌──────────────┐                  ┌──────────────────┐      │
│  │ storage.local│                  │ storage.session  │      │
│  │ (settings,   │                  │ (browser-open    │      │
│  │  runtime)    │                  │  sentinel flag)  │      │
│  └──────────────┘                  └──────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### Components

| File | Role |
|------|------|
| `src/background/service-worker.js` | State manager. Owns `activeEntries`, runs `processScan()` against thresholds, persists settings to `chrome.storage.local`, drives the runtime timer via `chrome.alarms`. |
| `src/content/content.js` | Injected into Zendesk filter pages. Scans the DOM every 1s, sends `SCAN_RESULT` to the SW, applies visual indicators, and ticks the on-row countdown locally. Wrapped in an IIFE for scope isolation. |
| `src/content/content.css` | Styling for the timer badge (`::after` pseudo-element), warning row, and overdue row. |
| `src/popup/Popup.tsx` | React 19 popup UI. Settings panel, live metrics, runtime timer, test sound button. Four-state input validation with visual rings. |
| `src/utils/sound.ts` | Shared Web Audio synthesis used by the popup for test playback. The content script inlines an equivalent copy because Chrome content scripts cannot use ES module imports. |
| `src/components/ui/*` | shadcn/ui primitives (Button, Switch, Input, Slider, Select, Label). |
| `public/manifest.json` | Manifest V3 declaration: permissions, host restrictions, content script matches, strict CSP. |

### Message Protocol

| Message | Direction | Payload | Cadence |
|---------|-----------|---------|---------|
| `SCAN_RESULT` | Content → SW | `{candidates[], timestamp}` | Every 1s |
| `UPDATE_ROWS` | SW → Content | `{updates: { [entryId]: {detectedAt, breachThreshold, warningThreshold} \| {cleared: true} }}` | On every SCAN_RESULT |
| `PLAY_SOUND` | SW → Content | `{soundType, volume}` | On breach |
| `STATE_UPDATE` | SW → Popup | `{metrics, runtimeAccumulatedMs, sessionStartedAt}` | On every SCAN_RESULT |
| `REQUEST_CURRENT_STATE` | Popup → SW | — | Popup mount |
| `SETTINGS_CHANGED` | Popup → SW | `{settings: {...}}` | On any setting change |
| `RESET` | Popup → SW | — | User clicks reset |
| `PLAY_SOUND` | Popup → SW | `{soundType, volume}` | (Test button plays locally via `sound.ts` instead) |

### How the On-Row Timer Works

The visual countdown is **decoupled from the chat refresh cycle**.

1. The content script scans the DOM every second and sends a fresh
   `SCAN_RESULT` to the service worker (no diff-gating — the SW needs
   every tick to fire breach sounds during stable queues).
2. The service worker tracks each chat's `detectedAt` timestamp in
   `state.activeEntries` and ships `{detectedAt, breachThreshold,
   warningThreshold}` per entry in `UPDATE_ROWS`.
3. The content script stores that metadata in a local `timerMeta` Map
   and runs its own `setInterval(tickTimers, 1000)` that recomputes
   `remaining`, `isWarning`, and `isBreached` directly from
   `Date.now() - detectedAt`.
4. The local tick writes `data-timer-text`, `data-warning`, and
   `data-overdue` attributes; CSS handles the visuals.

**What happens when settings change mid-timer:** `detectedAt` is
preserved. If a chat was detected 45s ago and the breach threshold drops
from 120s to 60s, the next tick shows `15s` remaining. The SW resets
`alerted` flags so sounds can re-trigger under the new thresholds.

### Runtime Timer Accounting

The popup's runtime display tracks only browser-open time, not
wall-clock time:

- **`runtimeAccumulatedMs`** — persisted to `chrome.storage.local`,
  accumulates across browser sessions.
- **`sessionStartedAt`** — in-memory anchor, set whenever the service
  worker starts up.
- **`chrome.storage.session` sentinel flag** — wiped on browser close.
  On SW cold start, if the flag is recent (<5 min) the SW resumes
  counting from it; otherwise it treats the launch as fresh and skips
  the gap.
- A 1-minute `chrome.alarms` heartbeat flushes the in-memory delta to
  disk; `chrome.runtime.onSuspend` does a best-effort final flush.

## Security

- **Strict CSP** — `script-src 'self'; object-src 'self'; base-uri 'self'; frame-ancestors 'none'`
- **Host restriction** — `https://*.zendesk.com/agent/filters/*` only,
  enforced at both manifest and runtime (every message's sender URL is
  re-validated against `TRUSTED_URL_PATTERN`).
- **Input sanitization** — All settings clamped/validated via
  `sanitizeSettings()`. Entry IDs validated against
  `/^[a-zA-Z0-9_\-#.]{1,64}$/`. Hex colors and sound types validated
  against allowlists. Candidate arrays capped at 500 entries.
- **Sender authentication** — `isTrustedSender()` rejects messages from
  foreign extension IDs or non-Zendesk URLs.
- **Scope isolation** — Content script wrapped in `(function(){})()` with
  `'use strict'`. The only `window.*` write is `__chatTrackerRows`
  (internal DOM-reference map).
- **Storage re-validation** — Settings loaded from `chrome.storage.local`
  pass through `sanitizeSettings()` again on read; disk storage is
  treated as untrusted.

## Permissions

| Permission | Why |
|------------|-----|
| `scripting` | Inject content script into Zendesk pages |
| `activeTab` | Query the active tab for sound dispatch |
| `tabs` | Find the active Zendesk tab to broadcast `UPDATE_ROWS` |
| `storage` | Persist settings and runtime accumulator |
| `alarms` | 1-minute heartbeat to flush runtime delta |

Host permissions: `https://*.zendesk.com/agent/filters/*` only.

## Tech Stack

- **React 19** + **TypeScript 5.7** — Popup UI
- **Vite 6** — Build pipeline (3 entry points: popup, service worker,
  content script)
- **Tailwind CSS 4** + **shadcn/ui** — Component styling
- **Radix UI** — Accessible primitives (Switch, Select, Slider, Label)
- **lucide-react** — Icon set
- **Web Audio API** — Sound synthesis (no audio files shipped)
- **Chrome Extension APIs** — Manifest V3 (`chrome.runtime`,
  `chrome.storage`, `chrome.alarms`, `chrome.tabs`)

## Project Structure

```
ExtensionTest/
├── public/
│   ├── manifest.json              # MV3 manifest
│   ├── icon-light-32x32.png
│   ├── icon-dark-32x32.png
│   └── icon.svg
├── src/
│   ├── background/
│   │   └── service-worker.js      # State + threshold engine
│   ├── content/
│   │   ├── content.js             # DOM scanner + local timer tick
│   │   └── content.css            # Row indicator styles
│   ├── popup/
│   │   ├── Popup.tsx              # Settings UI + metrics
│   │   └── main.tsx               # React entry
│   ├── utils/
│   │   └── sound.ts               # Web Audio synthesis (popup)
│   ├── components/ui/             # shadcn/ui primitives
│   ├── lib/utils.ts               # cn() helper
│   └── globals.css                # Tailwind base
├── popup.html                     # Popup root
├── vite.config.ts                 # 3-entry-point build
├── tsconfig.json
├── package.json
├── SLA_Timer_Implementation_Report.html  # Audit implementation report
└── SLA_Timer_Implementation_Report.pdf
```

## Build & Install

```bash
npm install
npm run build
```

This produces the loadable extension in `dist/`:

```
dist/
├── popup.html
├── service-worker.js
├── content.js
└── assets/
    ├── popup.js
    ├── popup.css
    └── content.css
```

To load it in Chrome:

1. Visit `chrome://extensions/`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select the `dist/` directory

## Debugging

The codebase logs aggressively with component-prefixed tags:

- **`[Popup]`** — Right-click the extension icon → **Inspect popup**
- **`[ServiceWorker]`** — `chrome://extensions/` → click the **service worker** link under Chat Monitor
- **`[Content]`** — DevTools console on the Zendesk filter page

Log messages reference only message types and aggregate counts — no
ticket IDs or user data are logged.

## Audit Implementation Report

A full report mapping the original 12-finding security audit to its
implementation in this codebase is included as
`SLA_Timer_Implementation_Report.pdf` (and the source HTML for editing).
