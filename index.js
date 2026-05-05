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

async function sendNotification(cfg, rule, pageTitle, matchedText) {
  const title = rule.label || `Element found: ${rule.selector}`;
  const lines = [
    `Page: ${pageTitle || rule.url}`,
    matchedText ? `Text: ${matchedText.slice(0, 200)}` : null,
    `URL: ${rule.url}`,
  ].filter(Boolean);

  if (cfg.notificationChannel === 'telegram') {
    if (!cfg.telegramBotToken || !cfg.telegramChatId) throw new Error('Telegram credentials not configured');
    await sendTelegram({ botToken: cfg.telegramBotToken, chatId: cfg.telegramChatId, title, lines, url: rule.url });
  } else {
    if (!cfg.pushoverUserKey || !cfg.pushoverAppToken) throw new Error('Pushover credentials not configured');
    await sendPushover({ token: cfg.pushoverAppToken, user: cfg.pushoverUserKey, title, lines, url: rule.url, priority: rule.priority, retry: rule.retry, expire: rule.expire });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function monitorRule(browser, rule) {
  const tag = rule.label || rule.selector;
  let cfg = loadConfig();

  // Each rule gets its own browser context so UA, cookies, and sessions are isolated
  let storageState;
  if (rule.storageStatePath) {
    const fullPath = path.resolve(__dirname, rule.storageStatePath);
    if (fs.existsSync(fullPath)) {
      storageState = fullPath;
    } else {
      log(tag, `storageStatePath "${rule.storageStatePath}" not found — run: node login.js --url ${rule.url} --out ${rule.storageStatePath}`);
    }
  }
  const context = await browser.newContext({
    userAgent: cfg.userAgent || undefined,
    ...(storageState && { storageState }),
  });
  const page = await context.newPage();

  log(tag, `Starting — ${rule.url}`);

  let lastSentAt = 0;

  while (true) {
    try {
      // Re-read config each cycle so edits to config.json take effect without restart
      cfg = loadConfig();

      // Stop this loop if the rule was disabled or removed
      const liveRule = (cfg.rules ?? []).find(r => r.id === rule.id);
      if (!liveRule || liveRule.enabled === false) {
        log(tag, 'Rule disabled or removed — stopping');
        break;
      }

      await page.goto(rule.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      if (rule.storageStatePath && looksLikeLoginRedirect(rule.url, page.url())) {
        log(tag, `Session expired — redirected to ${page.url()}`);
        log(tag, `Re-authenticate: node login.js --url ${rule.url} --out ${rule.storageStatePath}`);
      } else {
        const element = await page.$(rule.selector);

        if (element) {
          const cooldownMs = (cfg.dedupeIntervalSecs ?? 3600) * 1000;

          if (Date.now() - lastSentAt < cooldownMs) {
            log(tag, 'Match — within cooldown, skipping');
          } else if (cfg.quietHoursEnabled && isInQuietHours(cfg.quietHoursStart ?? '22:00', cfg.quietHoursEnd ?? '07:00')) {
            log(tag, 'Match — quiet hours active, suppressed');
          } else {
            const matchedText = (await element.textContent().catch(() => '')).trim();
            const pageTitle = await page.title();
            await sendNotification(cfg, rule, pageTitle, matchedText);
            lastSentAt = Date.now();
            log(tag, `Notification sent via ${cfg.notificationChannel}`);
          }
        } else {
          log(tag, 'No match');
        }
      }
    } catch (err) {
      log(tag, `Error: ${err.message}`);
    }

    const cfg2 = loadConfig();
    const intervalSecs = rule.checkIntervalSecs ?? cfg2.defaultCheckIntervalSecs ?? 60;
    await sleep(intervalSecs * 1000);
  }

  await context.close();
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    console.error('Cannot read config.json — copy config.example.json to config.json and fill in your credentials.');
    process.exit(1);
  }

  const enabledRules = (cfg.rules ?? []).filter(r => r.enabled !== false && r.url);
  if (enabledRules.length === 0) {
    console.error('No enabled rules with a "url" field found in config.json.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  console.log(`Page Notifier Daemon — ${enabledRules.length} rule(s) active`);

  const shutdown = async () => {
    console.log('\nShutting down…');
    await browser.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await Promise.all(enabledRules.map(rule => monitorRule(browser, rule)));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
