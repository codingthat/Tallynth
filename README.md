# Tallynth

Forget "local first".  This is an **offline-only, local-only** personal financial forecasting app with exact-money PostgreSQL forecasts powered by PGlite in your browser.

By opening an `html` file from your file explorer, like it was 1999.

It's 100% free and 100% private.  No cost, signup, remote storage, tracking, or analytics.  This means that saving early and often (and verifying forecast calculations) is your own responsibility; this comes with absolutely no warranty.

## Other features

Keyboard editing, CSV import, and portable dataset files.

## Why this way?

Years back, I had whipped up [some PostgreSQL views and functions](https://gist.github.com/codingthat/7b1e29ddfb878696468eca177dff01b4?permalink_comment_id=2182147#gistcomment-2182147) with the similar goal of knowing how much financial runway I had left.  Since those were the days when it was still reasonably easy to run pgAdminIII, whose classic spreadsheet-like UI [I still miss](https://softwarerecs.stackexchange.com/q/91479/93009), I hadn't seen a need to build my own UI.

The SQL rotted in the intervening years, as you can see at in the gist history.  But even with it revised and working again a couple years ago, it didn't support non-monthly recurrences, which I now needed.  So I rewrote the SQL to be even simpler, yet support a wider variety of PostgreSQL `interval` values.

Thanks to the existence of PGlite, I wanted to see how feasible it was to run this as a self-contained, offline-only, browser-based app.  The tradeoff is steep: It certainly isn't great to have to add 30+ MB just to be able to use PostgreSQL, especially given its impact on the app's initial loading time.  But it does mean that lay folks can run it without installing developer tools, benefit from its security, privacy, and easy data control, and it should work cross-platform.  (Except on mobile: Firefox for Android specifically forbids file:// and content:// URLs outright, and while Chromium browsers allow them, the database fails to load, at least as it currently stands.  Not that I'm keen on using such an app on mobile, anyway.)

Also, this repo contains quite a bit of the commonplace JS approach of sticking to `let` and `const`, using arrow functions for brevity, etc. that I'm not too keen about since reading [You Don't Know JS Yet](https://github.com/getify/You-Dont-Know-JS), and a few instances where I started to change the convention and use `var` (where `let` wasn't strictly needed), so the codebase is not (yet) consistent on these points.

## AI involvement

I tried to one-shot this two years ago (failed horribly) so this started as a more recent attempt out of curiosity.  While much better this time, it did still contain subtle bugs and several technical decisions that weren't aligned with my goals.  Subsequent refactoring steps had similar results, so in the end, I edited down much of this code manually.  There's still some cleanup to do, but it's mostly just CSS.

## Requirements

### For Users

Firefox or Chromium (hopefully any modern browser) and about 35 MB free.

Download the pre-compiled `html` file here and open it from your local machine in any web browser (often this means just double-clicking/launching the downloaded file).

### For Developers

- Node.js.
- Internet access for initial dependency installation. The installed, built app uses local runtime assets and does not require Internet access.

## Development and Build Setup

From the repository root, to run the app (allows development with hotloading):

```sh
npm ci && npm run dev
```

To build a static `html` file:

```sh
npm run build
```

Building reports upstream PGlite `eval` and browser externalization warnings; these are currently expected.

## Data and backups

- Autosave is local to the browser profile and origin. Use the same browser profile and the exact launch address above; switching between `localhost` and `127.0.0.1` uses different storage.
- Only one tab can write to a dataset at a time. Close the existing writer tab before opening another.
- Browser storage is not a backup: clearing site data, private browsing, or browser eviction can remove it. Keep regular **Save file** backups somewhere safe. Exported JSON files are not encrypted.

## Verification

Tests are browser-based, so you'll need Playwright first:

```sh
npx playwright install chromium
```

Then you can test and check formatting with:

```sh
npm t
npm run format:check
```

## Contributing

Thanks, but I'm not ready to accept source code contributions yet.  This is provided as-is in the hopes that it might be useful to someone.