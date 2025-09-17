// providers/fragment_login_once.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// куда логиниться (главная фрагмента/стара)
const BASE = (process.env.FRAGMENT_BASE || 'https://fragment.com').replace(/\/$/, '');
// куда сохранить cookies (можно переопределить FRAGMENT_COOKIES)
const COOKIES_PATH = process.env.FRAGMENT_COOKIES
  || path.join(process.cwd(), 'fragment_cookies.json');

// отдельный профиль, чтобы обойти ограничения macOS на рабочем столе
const USER_DATA_DIR = path.join(process.cwd(), '.pw_profile');

(async () => {
  console.log('> Открываю Chromium…');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox'],
  });

  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  console.log('> Войдите в свой аккаунт Fragment/Telegram. Я подожду…');
  console.log('  После успешного входа нажмите ENTER в терминале.');

  // ждём ENTER в консоли
  await new Promise((resolve) => {
    process.stdin.setRawMode && process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });

  // сохраняем cookies
  const cookies = await context.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log(`> Cookies сохранены: ${COOKIES_PATH}`);

  await context.close();
  process.exit(0);
})().catch((e) => {
  console.error('Login script error:', e);
  process.exit(1);
});
