# Page Element Notifier — Daemon

A headless Node.js daemon that monitors CSS-selected HTML elements on any web page and sends a push notification via [Pushover](https://pushover.net) or [Telegram](https://telegram.org) when they appear.

This is the standalone counterpart to the [Page Element Notifier Chrome extension](https://github.com/itarchitectau/webpagenotifier). It requires no browser installation, no UI, and runs anywhere Node.js runs — a server, a Raspberry Pi, or a background process on your desktop.

## Use cases

- Get notified when a sold-out product comes back in stock
- Alert when an error banner or status message appears on a dashboard
- Watch for a specific element on a page you cannot actively monitor

## How it works

1. You set a single **URL** and one or more **rules** in `config.json`. Each rule contains a CSS selector and an optional label.
2. The daemon launches a headless Chromium browser and navigates to the URL on a configurable interval.
3. On each cycle the page is loaded **once**, then every enabled rule's selector is evaluated against it in sequence.
4. If a match is found, a notification is sent via the configured channel (Pushover or Telegram).
5. Notifications are rate-limited by a configurable **cooldown interval** (default 1 hour). If the element is still present after the cooldown expires, a new notification is sent automatically.
6. Optionally configure **Quiet Hours** to suppress all notifications during a set time window (e.g. overnight).
7. Optionally set a **User Agent** string so the page sees a different browser identity.
8. `config.json` is re-read on every check cycle — credential, cooldown, and quiet-hours changes take effect without restarting the daemon.

## Project structure

```
test-notifier-daemon/
├── index.js              # Daemon: browser management, monitoring loop, notifications
├── login.js              # Interactive login helper for authenticated pages
├── package.json          # Dependencies (playwright only)
└── config.example.json   # Template — copy to config.json and fill in your values
```

## Prerequisites

- **Node.js 18 or later** (native `fetch` is required)
- A notification account for your chosen channel:
  - **Pushover** — [pushover.net](https://pushover.net) (free 30-day trial, then a one-time purchase per platform)
  - **Telegram** — free; requires a Telegram account

## Setup

### Step 1 — Install dependencies

```bash
npm install
npx playwright install chromium
```

### Step 2 — Set up your notification channel

Choose one channel and gather its credentials before running the daemon.

#### Option A — Pushover

1. Register at [pushover.net](https://pushover.net) and log in.
2. Install the Pushover app on your phone or desktop to receive notifications.
3. Copy your **User Key** from the top of the Pushover dashboard.
4. Go to [pushover.net/apps/build](https://pushover.net/apps/build) and create a new application (any name, e.g. "Page Notifier").
5. Copy the **API Token** shown on the application page.

#### Option B — Telegram

1. Open Telegram and message **@BotFather**.
2. Send `/newbot` and follow the prompts. Copy the **Bot Token** provided.
3. Send any message to your new bot.
4. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser (replace `<TOKEN>` with your token).
5. Find `"chat":{"id": 123456}` in the response — that number is your **Chat ID**.

### Step 3 — (Optional) Log in to a protected page

If the monitored URL requires authentication, run `login.js` once before starting the daemon. See the [Authentication](#authentication) section for details.

### Step 4 — Create config.json

```bash
cp config.example.json config.json
```

Edit `config.json` with your URL, credentials, and rules (see [Configuration reference](#configuration-reference) below).

### Step 5 — Run

```bash
npm start
```

The daemon logs each check cycle to stdout with a timestamp:

```
Page Notifier Daemon — https://example.com/dashboard — 2 rule(s)
12:00:04 [Back in stock] No match
12:00:04 [Error banner] No match
12:01:04 [Back in stock] Match — within cooldown, skipping
12:01:04 [Error banner] No match
```

Stop the daemon at any time with `Ctrl+C` — it shuts down cleanly and closes the browser.

## Configuration reference

### Top-level fields

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | string | — | **Required.** The page URL to monitor. |
| `checkIntervalSecs` | number | `60` | How often to reload and check the page (seconds) |
| `storageStatePath` | string | `""` | Path to a saved browser session file for authenticated pages — see [Authentication](#authentication) |
| `notificationChannel` | `"pushover"` \| `"telegram"` | `"pushover"` | Which channel to send notifications through |
| `pushoverUserKey` | string | — | Pushover user key |
| `pushoverAppToken` | string | — | Pushover application token |
| `telegramBotToken` | string | — | Telegram bot token |
| `telegramChatId` | string | — | Telegram chat ID |
| `dedupeIntervalSecs` | number | `3600` | Cooldown between repeat notifications for the same rule (seconds) |
| `quietHoursEnabled` | boolean | `false` | Whether to suppress notifications during the quiet window |
| `quietHoursStart` | `"HH:MM"` | `"22:00"` | Start of the quiet window (local time) |
| `quietHoursEnd` | `"HH:MM"` | `"07:00"` | End of the quiet window (local time) |
| `userAgent` | string | `""` | Custom User-Agent string. Leave empty to use the Chromium default. |
| `rules` | array | `[]` | List of monitoring rules (see below) |

### Rule fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Unique identifier for the rule |
| `selector` | string | Yes | CSS selector to watch for |
| `label` | string | No | Friendly name shown in the notification title |
| `priority` | `0` \| `1` \| `2` | No | Pushover notification priority (see below). Defaults to `0`. |
| `retry` | number | No | Pushover emergency retry interval in seconds (minimum 30). Only used when `priority` is `2`. |
| `expire` | number | No | Pushover emergency expiry in seconds (30–10800). Only used when `priority` is `2`. |
| `enabled` | boolean | No | Set to `false` to skip this rule without deleting it. Defaults to `true`. |

## Authentication

Some pages require a login before the monitored content is accessible. The daemon handles this with a two-step pattern: you log in once interactively, the session is saved to a local file, and the daemon loads that session on every subsequent check.

### How it works

1. `login.js` launches a **visible** Chromium browser and navigates to the URL you specify.
2. You complete the login process in the browser window — including any MFA, SSO, or CAPTCHA steps.
3. Once you press Enter in the terminal, the script captures the full browser state (cookies, localStorage, sessionStorage) and saves it to a JSON file.
4. The daemon loads that file when creating the browser context, so every page request carries the correct session tokens automatically.
5. If the daemon detects that the page redirected to a login URL (different origin or a path containing `/login`, `/signin`, `/auth`, `/sso`, or `/saml`), it logs a warning and sends a session expiry notification.

No credentials are stored in `config.json`. The session file is excluded from version control via `.gitignore`.

### Running login.js

```bash
node login.js --url <page-url> --out <session-file>
```

**Example:**

```bash
node login.js --url https://app.example.com/dashboard --out auth/example.json
```

1. A browser window opens at the URL.
2. Log in normally (fill in credentials, complete MFA, etc.).
3. Once the dashboard is visible and you are fully authenticated, return to the terminal and press Enter.
4. The session is saved and the browser closes.

The script prints the `storageStatePath` value to set in `config.json`:

```
Session saved to /path/to/auth/example.json
Add the following to your rule in config.json:

  "storageStatePath": "auth/example.json"
```

### Configuring authentication

Set `storageStatePath` at the top level of `config.json`:

```json
{
  "url": "https://app.example.com/dashboard",
  "storageStatePath": "auth/example.json",
  ...
}
```

### Session expiry

Sessions expire — corporate SSO and OAuth tokens typically last hours to days. When the daemon detects a login redirect it logs and sends a notification:

```
12:34:56 [https://app.example.com/dashboard] Session expired — redirected to https://login.example.com/...
12:34:56 [https://app.example.com/dashboard] Re-authenticate: node login.js --url https://app.example.com/dashboard --out auth/example.json
```

Re-run the printed command, press Enter once logged in, and the daemon will pick up the refreshed session on the next check cycle — no restart needed.

### Security notes

- Session files contain authentication tokens. Keep them out of version control — `.gitignore` already excludes the `auth/` folder.
- Do not share session files. Each machine should run `login.js` independently.

## Notification channels

Only one channel is active at a time, set by `notificationChannel` in `config.json`.

| Channel | Cost | Delivery |
|---|---|---|
| Pushover | One-time purchase per platform | Push notification via Pushover app |
| Telegram | Free | Message from your bot in Telegram |

## Notification priority

Priority applies to Pushover only. When Telegram is the active channel, the `priority` field is stored in the rule but has no effect on delivery.

| Priority | Pushover value | Behaviour |
|---|---|---|
| Normal | `0` | Standard sound and alert (default) |
| High | `1` | Bypasses the recipient's quiet hours in Pushover |
| Emergency | `2` | Repeats at `retry` seconds until acknowledged in the Pushover app |

When `priority` is `2`, both `retry` (minimum 30 s) and `expire` (30–10800 s) should be set on the rule.

## Notification cooldown

The `dedupeIntervalSecs` setting controls how often repeat notifications can fire for the same rule while the matched element remains on the page. The cooldown timer resets when the daemon restarts.

| Value | Behaviour |
|---|---|
| `60` | Re-notifies every minute while the element is present |
| `3600` (default) | Re-notifies at most once per hour |
| `86400` | Re-notifies at most once per day |

## Notification format

Both channels receive the same information:

| Field | Content |
|---|---|
| Title | The rule label, or the CSS selector if no label is set |
| Body | Page title, matched element text (up to 200 characters), and page URL |
| Link | Direct link back to the page |

## Quiet hours

Quiet hours suppress all notifications during a configured daily time window, regardless of which channel or rule would have fired.

| Detail | Notes |
|---|---|
| Scope | Global — applies to all rules and both notification channels |
| Timezone | Uses the local time of the machine running the daemon |
| Spanning midnight | Set end time before start time (e.g. Start `22:00`, End `07:00`) to suppress overnight |
| Same-day window | Set end time after start time (e.g. Start `09:00`, End `17:00`) to suppress during the day |

A notification suppressed by quiet hours does **not** reset the cooldown timer.

## User Agent override

Set `userAgent` in `config.json` to send a custom `User-Agent` header with every page request. This affects both the HTTP request header and `navigator.userAgent` as seen by client-side JavaScript, because Playwright sets the UA at the browser context level.

To disable it, set `userAgent` to an empty string.

**Note:** `userAgent` is applied when the browser context is created at startup. Changing it requires a restart.

## Config hot-reload

Most fields are re-read from `config.json` on every check cycle:

- Credential, cooldown, and quiet-hours changes take effect immediately
- Disabling a rule (`"enabled": false`) takes effect on the next cycle
- Adding new rules requires a restart
- Changing `url`, `storageStatePath`, or `userAgent` requires a restart (they are applied at startup)

## Differences from the Chrome extension

| Feature | Chrome extension | Daemon |
|---|---|---|
| URL to monitor | Any open browser tab | Single global `url` in config |
| DOM watching | `MutationObserver` (real-time) | Periodic page reload |
| Config storage | `chrome.storage.sync` (syncs across devices) | Local `config.json` file |
| Cooldown persistence | Survives browser restart | Resets on daemon restart |
| User Agent | HTTP header + JS override | Browser context (covers both automatically) |
| UI | Popup and options page | Edit `config.json` directly |
| Auto-refresh | Per-tab, configured in popup | Global `checkIntervalSecs` |

## Troubleshooting

| Problem | Solution |
|---|---|
| `Cannot read config.json` | Copy `config.example.json` to `config.json` and fill in your values. |
| `Invalid or missing top-level "url"` | Set a valid URL (e.g. `"https://example.com/dashboard"`) as the top-level `url` field in `config.json`. |
| No notification received | Check that the correct `notificationChannel` is set and its credentials are filled in. Confirm the selector matches by testing it in a browser's DevTools console: `document.querySelector('your-selector')`. |
| Daemon exits immediately | Ensure `url` is set and at least one rule has `"enabled": true`. |
| Notifications stop after first | Check `dedupeIntervalSecs` — the default is 3600 s (1 hour). Lower it for more frequent alerts. |
| Page loads but selector never matches | The page may require user interaction or authentication. Open the URL in a browser and verify the selector is present. |
| Telegram bot not responding | Make sure you have sent at least one message to your bot before calling `getUpdates`. Bots cannot initiate conversations — the chat ID is only available after you message them first. |
| UA change has no effect | `userAgent` is applied at startup. Restart the daemon after changing it. |
| Session expired warning in logs | Re-run the `node login.js` command printed in the log, press Enter once logged in, then the daemon will use the refreshed session on the next cycle. |
| `storageStatePath` not found warning | The session file doesn't exist yet. Run `node login.js --url <url> --out <path>` to create it before starting the daemon. |

## Privacy

All data (credentials, rules) is stored locally in `config.json`. The only external network calls made are to `api.pushover.net` (Pushover channel) or `api.telegram.org` (Telegram channel) when a monitored element is detected. No data is sent to any other third party.
