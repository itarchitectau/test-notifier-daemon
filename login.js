'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function usage() {
  console.error('Usage:   node login.js --url <page-url> --out <session-file>');
  console.error('Example: node login.js --url https://example.com/dashboard --out auth/example.json');
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function main() {
  const url = arg('--url');
  const out = arg('--out');
  if (!url || !out) usage();

  // Load UA from config.json if present
  let userAgent;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    userAgent = cfg.userAgent || undefined;
  } catch {
    // config.json not required for login
  }

  // Ensure the output directory exists
  fs.mkdirSync(path.dirname(path.resolve(__dirname, out)), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ userAgent });
  const page = await context.newPage();

  console.log(`\nOpening ${url} in a browser window.`);
  console.log('Complete the login process (including any MFA steps), then come back here.\n');

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  await waitForEnter('Press Enter once you are fully logged in… ');

  const outPath = path.resolve(__dirname, out);
  await context.storageState({ path: outPath });
  await browser.close();

  console.log(`\nSession saved to ${outPath}`);
  console.log(`Add the following to your rule in config.json:\n`);
  console.log(`  "storageStatePath": "${out}"\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
