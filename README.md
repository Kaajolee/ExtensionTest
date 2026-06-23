# Chat Monitor (Zendesk SLA Timer)

A Chrome extension that monitors unassigned chats on the Zendesk agent
interface and alerts agents before SLA thresholds are breached. Tracks
each chat individually with a live countdown overlay, color-coded warning
and overdue states, configurable audio alerts, an at-a-glance status light
on the toolbar icon, and automatic queue refreshing.

## Features

- **Per-row live countdown** — Each unassigned chat row gets a timer
  badge that ticks down every second, anchored inside the row, and
  independent of the chat queue refresh cycle.
- **Two-stage SLA alerts** — Warning state (yellow) when a chat
  approaches the breach threshold, overdue state (red) when it crosses
  it. Both the row wash and the badge are driven by user-chosen colors.
- **Toolbar status light** — A colored "bulb" on the extension icon
  badge reflects the live queue state at a glance: green (all clear),
  yellow (at least one chat in the warning zone), red (at least one
  breached), grey (monitoring disabled).
- **5 distinct audio alerts** — Beep, chime, alert, bell, and notification
  sounds, each with its own waveform and envelope. Volume is fully
  controllable from the popup, and the test button plays locally.
- **Automatic queue refresh** — Periodically clicks Zendesk's
  "refresh view" button on a configurable cadence (default 30s) so the
  ticket list stays current without manual refreshing.
- **Flicker-free on refresh** — A `MutationObserver` repaints the row
  badges and coloring the instant the list re-renders (from the cached
  timer metadata), so nothing blinks when the table rebuilds.
- **Cumulative session stats** — The popup's "Breached" and "Warning
  Zone" counters accumulate every chat that has reached each state since
  the last reset. They are mutually exclusive: a chat that warns then
  breaches counts only toward breached.
- **Enable/disable master switch** — Turning monitoring off tears down
  every on-page indicator and halts scanning, ticking, refreshing, and
  alerts. Turning it back on resumes within a second.
- **Customizable colors + dark mode** — Theme toggle, plus user-selectable
  hex colors for the warning and overdue states that genuinely drive the
  injected page styling.
- **Settings persistence** — Thresholds, sound type, volume, colors,
  refresh frequency, and enabled state are stored in
  `chrome.storage.local` and survive browser restarts.
- **Browser-open-only runtime timer** — Tracks how long the extension has
  been active, excluding time the browser was fully closed.
- **Input validation** — Threshold and refresh-frequency fields revert to
  a valid value on blur if you leave them empty, zero, or non-numeric.
- **DOM health check** — Detects when Zendesk's underlying selectors
  change (including the refresh button) and shows a visible warning banner
  on the page so silent breakage is impossible.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          CHROME BROWSER                          │
│                                                                  │
│  ┌──────────────────┐         ┌──────────────────────────────┐   │
│  │   Popup (React)  │         │   Content Script (IIFE)      │   │
│  │                  │         │                              │   │
│  │ - Settings UI    │         │ - DOM scan (1s)              │   │
│  │ - Live metrics   │         │ - Local timer tick (1s)      │   │
│  │ - Test playback  │         │ - Auto-refresh clicker       │   │
│  │ - Enable switch  │         │ - Row re-render observer     │   │
│  └────────┬─────────┘         │ - Sound playback             │   │
│           │                   │ - Color (:root) application  │   │
│           │  chrome.runtime   │ - Selector health check      │   │
│           │  .sendMessage     └────────┬─────────────────────┘   │
│           ▼                            ▼                         │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Service Worker                          │ │
│  │  - Authoritative state (activeEntries Map)                 │ │
│  │  - Threshold evaluation + breach sound triggering          │ │
│  │  - Cumulative + live stat tallies                          │ │
│  │  - Toolbar status-light (action badge) painting            │ │
│  │  - Settings sanitization + persistence                     │ │
│  │  - Browser-open-only runtime accounting                    │ │
│  └─────┬──────────────────────────────────────────┬──────────┘ │
│        ▼                                          ▼             │
│  ┌──────────────┐                       ┌──────────────────┐    │
│  │ storage.local│                       │ storage.session  │    │
│  │ (settings,   │                       │ (browser-open    │    │
│  │  runtime)    │                       │  sentinel flag)  │    │
│  └──────────────┘                       └──────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

### Components

| File | Role |
|------|------|
| `src/background/service-worker.js` | State manager. Owns `activeEntries`, runs `processScan()` against thresholds, tallies cumulative + live counts, paints the toolbar status light, persists settings, and drives the runtime timer via `chrome.alarms`. |
| `src/content/content.js` | Injected into Zendesk filter pages. Scans the DOM every 1s, sends `SCAN_RESULT`, ticks the on-row countdown locally, clicks the refresh button on a cadence, repaints rows on re-render via a `MutationObserver`, applies color custom properties, and runs the selector health check. Wrapped in an IIFE for scope isolation. |
| `src/content/content.css` | Styling for the timer badge (`::after`), warning row, and overdue row. Colors come from `--ct-warning-color` / `--ct-breach-color` custom properties (with `color-mix()` for the translucent backgrounds). Injected via the manifest's `content_scripts.css`. |
| `src/popup/Popup.tsx` | React 19 popup UI. Settings panel, live metrics, runtime timer, test sound button, enable switch. Input validation with visual rings and revert-on-blur. |
| `src/utils/sound.ts` | Shared Web Audio synthesis used by the popup for test playback. The content script inlines an equivalent copy because Chrome content scripts cannot use ES module imports. |
| `src/components/ui/*` | shadcn/ui primitives (Button, Switch, Input, Slider, Select, Label). |
| `public/manifest.json` | Manifest V3 declaration: permissions, host restrictions, content script matches + CSS, strict CSP. |

### Message Protocol

| Message | Direction | Payload | Cadence |
|---------|-----------|---------|---------|
| `SCAN_RESULT` | Content → SW | `{candidates[], timestamp}` | Every 1s (only while enabled) |
| `UPDATE_ROWS` | SW → Content | `{updates, colors: {warning, breach}, enabled, refreshFrequency}` where each update is `{detectedAt, breachThreshold, warningThreshold}` or `{cleared: true}` | On every SCAN_RESULT |
| `SET_ENABLED` | SW → Content | `{enabled}` | On settings change, and when a scan arrives while disabled |
| `PLAY_SOUND` | SW → Content | `{soundType, volume}` | On breach |
| `STATE_UPDATE` | SW → Popup | `{metrics, runtimeAccumulatedMs?, sessionStartedAt?}` | On every SCAN_RESULT |
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
from 120s to 60s, the next tick shows `15s` remaining.

### Flicker-Free Refresh

When the ticket list re-renders (from the auto-refresh click or any
Zendesk data update), the old `<tr>` elements are destroyed. Because the
per-chat timing already lives in the content script's `timerMeta` map
(keyed by entry ID, not DOM node), only the element references go stale.
A `MutationObserver` on the ticket `<tbody>` watches for `childList`
changes and immediately re-maps the rows and repaints from `timerMeta` —
the callback runs as a microtask *before* the browser paints, so the
badges and coloring never visibly disappear. The 1s scan remains a
backstop, and the observer re-targets itself if the table re-mounts.

### Color Customization

`content.css` references two custom properties, `--ct-warning-color` and
`--ct-breach-color`, and derives the translucent row backgrounds from them
with `color-mix()`. The service worker piggybacks the user's chosen hex
values on every `UPDATE_ROWS`; the content script validates each against
`/^#[0-9a-fA-F]{6}$/` and writes them to `document.documentElement`'s
inline style. So one color picker drives both the row border/badge and the
wash, and the page can never inject arbitrary CSS values.

### Session Stats (Cumulative)

The popup's "Breached" and "Warning Zone" numbers are **cumulative since
the last reset**, not a live snapshot. Each chat carries a high-watermark
tier (`0` none → `1` warning → `2` breached) and is counted toward exactly
one total — its highest tier reached. A chat promoted from warning to
breached is moved out of the warning total into the breached total. Only
the Reset button (which also clears `activeEntries`) starts the tally over.

The **live** counts that drive the toolbar status light are tracked
separately (`state.liveBreaches` / `liveWarnings`), recomputed from scratch
each scan so the light always reflects the queue right now.

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
- **Host restriction** — `https://*.zendesk.com/agent/filters/*` (plus
  `http://localhost/agent/filters/*` for the local simulator; see
  [Local testing](#local-testing)), enforced at both manifest and runtime.
  Every message's sender URL is re-validated against `TRUSTED_URL_PATTERN`.
- **Input sanitization** — All settings clamped/validated via
  `sanitizeSettings()`. Entry IDs validated against
  `/^[a-zA-Z0-9_\-#.]{1,64}$/`. Hex colors and sound types validated
  against allowlists. Candidate arrays capped at 500 entries.
- **Sender authentication** — `isTrustedSender()` rejects messages from
  foreign extension IDs or non-trusted URLs.
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
| `tabs` | Find the active Zendesk tab to broadcast `UPDATE_ROWS` / `SET_ENABLED` / `PLAY_SOUND` |
| `storage` | Persist settings and runtime accumulator |
| `alarms` | 1-minute heartbeat to flush runtime delta |

The toolbar status light uses the `chrome.action` badge API, which needs
no extra permission. Host permissions:
`https://*.zendesk.com/agent/filters/*` (and `http://localhost/agent/filters/*`
for local testing).

## Tech Stack

- **React 19** + **TypeScript 5.7** — Popup UI
- **Vite 6** — Build pipeline (3 entry points: popup, service worker,
  content script)
- **Tailwind CSS 4** + **shadcn/ui** — Component styling
- **Radix UI** — Accessible primitives (Switch, Select, Slider, Label)
- **lucide-react** — Icon set
- **Web Audio API** — Sound synthesis (no audio files shipped)
- **Chrome Extension APIs** — Manifest V3 (`chrome.runtime`,
  `chrome.storage`, `chrome.alarms`, `chrome.tabs`, `chrome.action`)

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
│   │   └── service-worker.js      # State + threshold engine + status light
│   ├── content/
│   │   ├── content.js             # DOM scanner, timer tick, auto-refresh, observer
│   │   └── content.css            # Row indicator styles (color custom props)
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

> **After reloading the extension, reload any open Zendesk tab.** Chrome
> does not re-inject content scripts into already-open tabs, so the page
> needs a refresh for the new content script to run.

## Local testing

The manifest also matches `http://localhost/agent/filters/*` so the
extension can be exercised against a local page that mirrors Zendesk's
`data-test-id` selectors (status badges, assignee cell, total counter,
sidebar nav, and the view-refresh button) without touching production
Zendesk. The service worker's `TRUSTED_URL_PATTERN` likewise allows
`http://localhost` (any port) under `/agent/filters/`.

> These localhost entries are for local development only. Remove them from
> `manifest.json` and `TRUSTED_URL_PATTERN` before shipping a production
> build.

## Debugging

The codebase logs aggressively with component-prefixed tags:

- **`[Popup]`** — Right-click the extension icon → **Inspect popup**
- **`[ServiceWorker]`** — `chrome://extensions/` → click the **service worker** link under Chat Monitor
- **`[Content]`** — DevTools console on the Zendesk filter page

Log messages reference only message types and aggregate counts — no
ticket IDs or user data are logged. Sending a message to a tab that has no
content script yet (e.g. a tab not reloaded after an extension restart) is
treated as the expected, benign condition it is and does not log an error.

## Audit Implementation Report

A full report mapping the original 12-finding security audit to its
implementation in this codebase is included as
`SLA_Timer_Implementation_Report.pdf` (and the source HTML for editing).
