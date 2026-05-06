# Zendesk Chat Monitor

A Chrome/Edge extension that monitors unassigned Zendesk chats, displays a countdown timer on each row, and alerts you visually and audibly when chats exceed configurable warning and breach thresholds.

## Features

- **Real-time chat monitoring** — scans Zendesk chat tables every 1 second for unassigned tickets via DOM observation (no API access required)
- **Visual indicators** — rows show live countdown timers; turn yellow at warning threshold and red at breach
- **Audio alerts** — configurable beep sound plays when a chat breaches threshold
- **Customizable popup UI** — adjust thresholds, sound type, volume, mute, dark mode, and breach/warning colors
- **Persistent settings** — preferences saved across browser sessions via `chrome.storage.local`
- **Lightweight** — built with performance in mind to avoid slowing down Zendesk's already heavy interface

## Architecture

```
Content Script (DOM observer)
  └─ Detect unassigned table rows (1s scan)
     └─ Send chat list to service worker
        └─ Service Worker (state + timers)
           ├─ Track elapsed time per chat
           ├─ Evaluate thresholds
           └─ Broadcast metrics to popup + UI updates to content script
              └─ Popup (display)
```

### Components

- **`src/content/content.js`** — DOM observer; queries Zendesk table rows for unassigned chats and applies timer/warning/overdue attributes
- **`src/content/content.css`** — Styling for row indicators (timer badge, yellow warning, red overdue)
- **`src/background/service-worker.js`** — State management, threshold evaluation, settings persistence, sound coordination
- **`src/popup/Popup.tsx`** — React-based settings UI and live metrics display
- **`public/manifest.json`** — Chrome extension manifest (Manifest V3)

### Message Protocol

```
Content → Service Worker:  SCAN_RESULT (every 1s)
Service Worker → Content:  UPDATE_ROWS (apply DOM attributes), PLAY_SOUND (trigger beep)
Popup → Service Worker:    SETTINGS_CHANGED, RESET, PLAY_SOUND, REQUEST_CURRENT_STATE
Service Worker → Popup:    STATE_UPDATE (metrics)
```

## Tech Stack

- React + TypeScript
- Vite (build tool)
- Tailwind CSS + shadcn/ui components
- Chrome Extension APIs (Manifest V3)
- Web Audio API (for alert sounds)

## Setup

### Install and build

1. Clone the repository:
   ```bash
   git clone https://github.com/Kaajolee/ExtensionTest.git
   cd ExtensionTest
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the extension:
   ```bash
   npm run build
   ```

### Load the extension

1. Open `chrome://extensions/` (or `edge://extensions/` for Edge)
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the generated `dist/` directory
5. The Chat Monitor icon should appear in your browser toolbar

## Usage

1. Open a Zendesk agent dashboard with chat tickets
2. Unassigned rows will automatically receive countdown timers
3. Click the extension icon to access:
   - **Status** — live count of breached and warning chats
   - **Threshold** — configure warning (yellow) and breach (red) times in seconds
   - **Sound** — toggle mute, adjust volume, select sound type, test playback
   - **Customization** — toggle dark mode and customize alert colors

## Development

```bash
npm run build      # Production build to dist/
npm run dev        # Vite dev server (popup only — for UI iteration)
```

After making changes, reload the extension in `chrome://extensions/` to see updates.

### Console Logs

The extension includes detailed console logging for debugging:

- **Popup logs** (`[Popup]` prefix) — view via right-click popup → Inspect
- **Service Worker logs** (`[ServiceWorker]` prefix) — view via `chrome://extensions/` → Service Worker link
- **Content Script logs** (`[Content]` prefix) — view via DevTools console on Zendesk page

## Project Structure

```
ExtensionTest/
├── public/
│   ├── manifest.json           # Extension manifest
│   └── icon-*.png              # Extension icons
├── src/
│   ├── background/
│   │   └── service-worker.js   # State management & message routing
│   ├── content/
│   │   ├── content.js          # DOM observer
│   │   └── content.css         # Row indicator styles
│   ├── popup/
│   │   ├── Popup.tsx           # Settings UI
│   │   └── main.tsx            # React entry point
│   ├── components/
│   │   └── ui/                 # shadcn/ui component library
│   └── globals.css             # Tailwind base styles
├── popup.html                  # Popup HTML entry
├── vite.config.ts              # Build configuration
├── tsconfig.json               # TypeScript config
└── package.json                # Dependencies and scripts
```

## Permissions

The extension requests:
- `scripting`, `activeTab`, `tabs` — for content script injection and tab querying
- `storage` — to persist user settings across sessions
- `alarms` — for periodic state evaluation

Content scripts run on:
- `https://*/hc/agent/*`
- `https://*.zendesk.com/*`

## License

Private project — not currently licensed for public distribution.
