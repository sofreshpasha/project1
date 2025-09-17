// providers/fragment-login-once.js
import path from 'path';
import { chromium } from 'playwright';

const BASE = (process.env.FRAGMENT_BASE || 'https://fragment.com').replace(/\/$/, '');
const PROFILE_DIR = process.env.PW_PROFILE_DIR || path.join(process.cwd(), '.pw_profile');

(async () => {
  console.log('➡️ Открываю Chromium c профилем:', PROFILE_DIR);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await ctx.newPage();
  await page.goto(`${BASE}`, { waitUntil: 'domcontentloaded' });
  console.log('👉 Войди в Fragment/Telegram. После успешного входа просто закрой окно Chromium.');
})();
