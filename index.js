'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';
const TELEGRAM_API_BASE = 'https://api.telegram.org';

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} [${tag}] ${msg}`);
}

function isInQuietHours(start, end) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendPushover({ token, user, title, lines, url, priority, retry, expire }) {
  const res = await fetch(PUSHOVER_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token, user, title,
      message: lines.join('\n'),
      url, url_title: 'Open page',
      priority: priority ?? 0,
      ...(priority === 2 && { retry: retry ?? 60, expire: expire ?? 3600 }),
    }),
  });
  if (!res.ok) throw new Error(`Pushover HTTP ${res.status}: ${await res.text()}`);
}

async function sendTelegram({ botToken, chatId, title, lines, url }) {
  const text = [
    `<b>${escHtml(title)}</b>`,
    ...lines.map(escHtml),
    `<a href="${escHtml(url)}">Open page</a>`,
  ].join('\n');
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${await res.text()}`);
}

async function sendNotification(cfg, rule, url, pageTitle, matchedText) {
  const title = rule.label || `Element found: ${rule.selector}`;
  const lines = [
    `Page: ${pageTitle || url}`,
    matchedText ? `Text: ${matchedText.slice(0, 200)}` : null,
    `URL: ${url}`,
  ].filter(Boolean);

  if (cfg.notificationChannel === 'telegram') {
    if (!cfg.telegramBotToken || !cfg.telegramChatId) throw new Error('Telegram credentials not configured');
    await sendTelegram({ botToken: cfg.telegramBotToken, chatId: cfg.telegramChatId, title, lines, url });
  } else {
    if (!cfg.pushoverUserKey || !cfg.pushoverAppToken) throw new Error('Pushover credentials not configured');
    await sendPushover({ token: cfg.pushoverAppToken, user: cfg.pushoverUserKey, title, lines, url, priority: rule.priority, retry: rule.retry, expire: rule.expire });
  }
}

async function sendSessionExpiredNotification(cfg, url, storageStatePath) {
  const title = 'Session expired';
  const lines = [
    `URL: ${url}`,
    `Run: node login.js --url ${url} --out ${storageStatePath}`,
  ];

  if (cfg.notificationChannel === 'telegram') {
    if (!cfg.telegramBotToken || !cfg.telegramChatId) throw new Error('Telegram credentials not configured');
    await sendTelegram({ botToken: cfg.telegramBotToken, chatId: cfg.telegramChatId, title, lines, url });
  } else {
    if (!cfg.pushoverUserKey || !cfg.pushoverAppToken) throw new Error('Pushover credentials not configured');
    // Priority 1 (High) bypasses Pushover quiet hours — session expiry needs prompt attention
    await sendPushover({ token: cfg.pushoverAppToken, user: cfg.pushoverUserKey, title, lines, url, priority: 1 });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidUrl(url) {
  try {
    return new URL(url).hostname !== '';
  } catch {
    return false;
  }
}

function looksLikeLoginRedirect(expectedUrl, currentUrl) {
  try {
    const expected = new URL(expectedUrl);
    const current = new URL(currentUrl);
    if (current.origin !== expected.origin) return true;
    const p = current.pathname.toLowerCase();
    return ['/login', '/signin', '/sign-in', '/auth', '/sso', '/saml'].some(t => p.includes(t));
  } catch {
    return false;
  }
}

// Single monitoring loop: load the global URL once per cycle, evaluate all rules against it.
async function monitor(page, url) {
  const lastSentAt = new Map();  // ruleId -> timestamp
  let lastSessionExpiredAt = 0;

  while (true) {
    try {
      const cfg = loadConfig();
      const liveRules = (cfg.rules ?? []).filter(r => r.enabled !== false);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      if (cfg.storageStatePath && looksLikeLoginRedirect(url, page.url())) {
        const redirectedTo = page.url();
        log(url, `Session expired — redirected to ${redirectedTo}`);
        log(url, `Re-authenticate: node login.js --url ${url} --out ${cfg.storageStatePath}`);

        const cooldownMs = (cfg.dedupeIntervalSecs ?? 3600) * 1000;
        if (Date.now() - lastSessionExpiredAt >= cooldownMs) {
          try {
            await sendSessionExpiredNotification(cfg, url, cfg.storageStatePath);
            lastSessionExpiredAt = Date.now();
            log(url, `Session expiry notification sent via ${cfg.notificationChannel}`);
          } catch (err) {
            log(url, `Failed to send session expiry notification: ${err.message}`);
          }
        }
      } else {
        const pageTitle = await page.title();
        const cooldownMs = (cfg.dedupeIntervalSecs ?? 3600) * 1000;

        for (const rule of liveRules) {
          const tag = rule.label || rule.selector;
          try {
            const element = await page.$(rule.selector);
            if (element) {
              const ruleLastSent = lastSentAt.get(rule.id) ?? 0;
              if (Date.now() - ruleLastSent < cooldownMs) {
                log(tag, 'Match — within cooldown, skipping');
              } else if (cfg.quietHoursEnabled && isInQuietHours(cfg.quietHoursStart ?? '22:00', cfg.quietHoursEnd ?? '07:00')) {
                log(tag, 'Match — quiet hours active, suppressed');
              } else {
                const matchedText = (await element.textContent().catch(() => '')).trim();
                await sendNotification(cfg, rule, url, pageTitle, matchedText);
                lastSentAt.set(rule.id, Date.now());
                log(tag, `Notification sent via ${cfg.notificationChannel}`);
              }
            } else {
              log(tag, 'No match');
            }
          } catch (err) {
            log(tag, `Error: ${err.message}`);
          }
        }
      }
    } catch (err) {
      log(url, `Error: ${err.message}`);
    }

    const cfg2 = loadConfig();
    const intervalSecs = cfg2.checkIntervalSecs ?? 60;
    await sleep(intervalSecs * 1000);
  }
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    console.error('Cannot read config.json — copy config.example.json to config.json and fill in your credentials.');
    process.exit(1);
  }

  if (!isValidUrl(cfg.url)) {
    console.error(`Invalid or missing top-level "url" in config.json: "${cfg.url ?? ''}"`);
    process.exit(1);
  }

  const enabledRules = (cfg.rules ?? []).filter(r => r.enabled !== false);
  if (enabledRules.length === 0) {
    console.error('No enabled rules found in config.json.');
    process.exit(1);
  }

  let storageState;
  if (cfg.storageStatePath) {
    const fullPath = path.resolve(__dirname, cfg.storageStatePath);
    if (fs.existsSync(fullPath)) {
      storageState = fullPath;
    } else {
      console.warn(`storageStatePath "${cfg.storageStatePath}" not found — run: node login.js --url ${cfg.url} --out ${cfg.storageStatePath}`);
    }
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: cfg.userAgent || undefined,
    ...(storageState && { storageState }),
  });
  const page = await context.newPage();

  console.log(`Page Notifier Daemon — ${cfg.url} — ${enabledRules.length} rule(s)`);

  const shutdown = async () => {
    console.log('\nShutting down…');
    await browser.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await monitor(page, cfg.url);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
