# Extension Test

A Chrome extension project built with React and TypeScript.

## Project Structure

- **src/popup/** - Popup UI components
- **src/background/** - Service worker for background operations
- **src/components/** - Reusable React components including a comprehensive UI library
- **public/** - Static assets and manifest configuration
- **src/content/** - Content script for page interaction

## Tech Stack

- React + TypeScript
- Vite (build tool)
- PostCSS for styling
- Chrome Extension APIs

## Setup

1. Install dependencies: `npm install`
2. Build the extension: `npm run build`
3. Load in Chrome: Navigate to `chrome://extensions/` and load the unpacked `dist/` directory

## Key Files

- `package.json` - Project dependencies and scripts
- `vite.config.ts` - Build configuration
- `tsconfig.json` - TypeScript configuration
- `public/manifest.json` - Chrome extension manifest
- `popup.html` - Extension popup HTML

## Development

Use `npm run dev` for development mode with hot reload.
