# Budget Forecaster

A local-first budgeting app with exact-money PostgreSQL forecasts powered by PGlite in your browser. It includes keyboard editing, CSV/TSV/space-separated SSV import, batch undo, and portable dataset files. No PostgreSQL server, Docker, account, or cloud service is needed.

## Requirements

- Node.js 22.12 or newer and npm. Development was verified with Node.js 26.12.0 and npm 10.9.8.
- A current desktop browser with IndexedDB, Web Workers, and Web Locks. Automated browser tests cover Chromium; other browsers are not verified.
- Internet access for initial dependency installation. The installed, built app uses local runtime assets and does not require Internet access.

## Setup and launch

Run these commands from the repository root:

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4173**. Keep the terminal running while using the app; press Ctrl+C to stop the local server. Port 4173 must be free. Do not open `index.html` directly using `file://`.

After changing application code, run `npm run build` again before `npm start`.

For development with automatic updates, use this instead of `npm start`:

```sh
npm run dev
```

## First use

1. Choose the currency before adding records; a populated dataset cannot change currency.
2. Add an **Actual balance** at or before the forecast start, then add **Cashflows** or use the separate import tool. The import dialog shows the required column layouts and previews validation errors before applying anything.
3. Select a date range in **Forecast**. Timestamps use UTC; amounts have two decimal places. Forecasts require an actual-balance anchor and enforce a 50-year horizon and a 200,000-event expansion guard rather than silently truncating results.
4. Use **Save file** to download a portable whole-dataset backup. **Open file** validates a dataset before asking to replace the current one. Batch imports and file replacement can be undone within the current session.

The optional example data is loaded only when explicitly requested.

## Data and backups

- Autosave is local to the browser profile and origin. Use the same browser profile and the exact launch address above; switching between `localhost` and `127.0.0.1` uses different storage.
- Only one tab can write to a dataset at a time. Close the existing writer tab before opening another.
- Browser storage is not a backup: clearing site data, private browsing, or browser eviction can remove it. Keep regular **Save file** backups somewhere safe. Exported JSON files are not encrypted.
- **Save file** exports the last confirmed dataset, not incomplete or failed edits. Check the displayed storage status. After a storage failure, export the confirmed data and reload before editing again.
- Undo retains up to 50 operations in the current session; it is not persistent history.
- Optional encrypted cloud backup is not implemented.

## Verification

```sh
npm test
npm run format:check
npm run build
```

The build currently reports upstream PGlite `eval` and browser externalization warnings.

For browser tests, install Chromium through the project's pinned Playwright version:

```sh
npx playwright install chromium
npm run test:e2e
```

Playwright manages the downloaded browser in its standard cache. The host must also have Playwright's Chromium system libraries available.

Build first and stop any running development or preview server before the browser test: it starts its own server on port 4173 and creates a separate temporary browser profile and diagnostic artifacts. No pre-existing local evidence or ignored files are required.
