# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

`page-notifier-daemon` is a headless Node.js daemon that monitors CSS-selected elements on a web page and sends push notifications (via Pushover or Telegram) when they appear. It uses Playwright for headless Chromium automation. It is the backend counterpart to the Page Element Notifier Chrome extension.

## Running the Daemon

```bash
npm start          # runs: node index.js
node index.js      # equivalent
```

There are no build, lint, or test commands — this is a plain JavaScript project with no TypeScript, no linter, and no test framework.

## Authentication Setup

To capture a logged-in browser session for sites requiring authentication:

```bash
node login.js --url https://example.com --out session.json
```

This opens a visible browser, lets the user log in manually, then saves cookies/storage to `session.json`. Reference the saved file in `config.json` via `storageStatePath`.

## Architecture

### Key Design: Single URL, Multiple Rules

One page load per cycle. All rules evaluate their CSS selectors against the same loaded DOM — there is no per-rule navigation. This is set at startup and cannot change without a restart.

### Main Loop (index.js → `monitor()`)

1. Load `config.json` from disk (hot-reloaded every cycle — most fields apply immediately without restart)
2. Navigate to the configured URL
3. For each enabled rule: evaluate the CSS selector
4. If a match is found, check cooldown (`dedupeIntervalSecs`) and quiet hours
5. Send notification if conditions pass
6. Sleep `checkIntervalSecs` seconds, repeat

**Hot-reload caveats**: `url`, `storageStatePath`, and `userAgent` are set at startup — changes to these require a restart. Adding new rules also requires a restart; toggling `enabled` on existing rules does not.

### Files

| File | Purpose |
|------|---------|
| `index.js` | Main daemon: browser lifecycle, monitoring loop, notifications |
| `login.js` | Interactive helper to capture authenticated browser session |
| `config.example.json` | Template — copy to `config.json` to configure |
| `config.json` | Active config (gitignored) |

### Session Expiry Detection

After each page load, the daemon checks if the final URL differs in origin from the configured URL or contains `/login`, `/signin`, `/auth`, `/sso`, `/saml`. A mismatch triggers a session-expired notification (Pushover priority 1) with a cooldown to avoid repeated alerts.

### Notification Channels

Only one channel is active at a time, selected by `notificationChannel` in config. Pushover uses plain text; Telegram uses HTML. Notification content: rule label, page title, matched element text (truncated to 200 chars), and URL.

### Cooldown Tracking

`lastSentAt` is an in-memory `Map<ruleId, timestamp>`. It resets on daemon restart. A rule will not re-notify until `dedupeIntervalSecs` have elapsed since the last notification.

## Config Reference

Top-level fields:

| Field | Notes |
|---|---|
| `url` | **Required.** Single URL all rules monitor. Restart required to change. |
| `checkIntervalSecs` | How often to reload and check (default 60) |
| `storageStatePath` | Path to session file from `login.js`; restart required to change |
| `notificationChannel` | `"pushover"` or `"telegram"` |
| `pushoverUserKey`, `pushoverAppToken` | Pushover credentials |
| `telegramBotToken`, `telegramChatId` | Telegram credentials |
| `dedupeIntervalSecs` | Cooldown between repeat notifications per rule (default 3600) |
| `quietHoursEnabled` | Suppress notifications during a time window |
| `quietHoursStart` / `quietHoursEnd` | `"HH:MM"` local time; supports midnight-spanning ranges |
| `userAgent` | Custom User-Agent string; restart required to change |
| `rules` | Array of rule objects |

Rule fields:

| Field | Notes |
|---|---|
| `id` | Unique string; used as the cooldown key |
| `selector` | CSS selector to watch for |
| `label` | Friendly name in notifications; defaults to selector |
| `priority` | Pushover priority: 0 (normal), 1 (high), 2 (emergency) |
| `retry` / `expire` | Emergency retry/expiry seconds; only for priority 2 |
| `enabled` | Set `false` to skip without deleting; hot-reloaded |

## Dependencies

- **playwright** `^1.44.0` — headless Chromium; must run `npx playwright install` on first setup
- Node.js 18+ (uses native `fetch`)
