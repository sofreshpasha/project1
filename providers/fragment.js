// providers/fragment.js
import path from 'path';
import { chromium } from 'playwright';

const BASE = (process.env.FRAGMENT_BASE || 'https://fragment.com').replace(/\/$/, '');
const PROFILE_DIR = process.env.PW_PROFILE_DIR || path.join(process.cwd(), '.pw_profile');
const HEADLESS = String(process.env.FULFILL_HEADLESS || 'true') !== 'false';

async function ensureProfileLogged(context) {
  const page = await context.newPage();
  await page.goto(`${BASE}/stars`, { waitUntil: 'domcontentloaded' });
  const hasProfile = await page
    .locator('a[href*="/settings"], a[href*="/profile"], [data-test="profile"]')
    .first()
    .isVisible()
    .catch(() => false);
  await page.close();
  if (!hasProfile) throw new Error('Fragment session not authorized');
}

export async function deliverViaFragment({ orderId, stars, recipient }) {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: HEADLESS });
  try {
    await ensureProfileLogged(ctx);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/stars`, { waitUntil: 'domcontentloaded' });

    await page.fill('input[name="recipient"], input[placeholder*="username"], input[placeholder*="@"]', String(recipient));
    await page.fill('input[name="amount"], input[type="number"]', String(stars));
    await page.click('button:has-text("Buy"), button:has-text("Оплатить"), button:has-text("Continue")');
    await page.click('button:has-text("Confirm"), button:has-text("Pay")').catch(() => {});
    await page.waitForSelector('text=Success, text=Оплачено, [data-test="success"]', { timeout: 45_000 });

    const tx = await page.locator('.tx-id, [data-test="tx"], text=TX').first().textContent().catch(() => null);
    return { ok: true, tx: tx?.trim() || null };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    await ctx.close();
  }
}
