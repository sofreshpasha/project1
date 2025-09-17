// app.js
// StarsFabrica — Telegram bot + Express + SBP + Autodelivery via Fragment
// (c) 2025

import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import Database from 'better-sqlite3';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

// === Fragment provider (Playwright) ===
import { deliverViaFragment } from './providers/fragment.js';

// === Paths / init ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const RUB_PER_STAR = Number(process.env.RUB_PER_STAR || 1.8);
const AUTODELIVER = String(process.env.AUTODELIVER || '1') === '1';

const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/$/, '');
const QRM_BASE = (process.env.QRM_BASE || '').replace(/\/$/, '');
const QRM_TOKEN = process.env.QRM_TOKEN || '';

const WEBHOOK_SECRET_RUB = process.env.WEBHOOK_SECRET_RUB || '';
const WEBHOOK_SECRET_CRYPTO = process.env.WEBHOOK_SECRET_CRYPTO || '';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}
if (!PUBLIC_BASE) {
  console.error('PUBLIC_BASE is required (external https url for webhooks)');
  process.exit(1);
}

// === DB ===
const dbDir = path.join(__dirname, 'db');
const dbPath = path.join(dbDir, 'starfall.sqlite');
await (async () => {
  await import('node:fs/promises')
    .then(fs => fs.mkdir(dbDir, { recursive: true }))
    .catch(() => {});
})();
const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  username TEXT,
  gift_to TEXT,
  stars INTEGER NOT NULL,
  amount_rub REAL NOT NULL,
  payment_provider TEXT,
  payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',  -- new|pending|paid|delivering|delivered|failed|cancelled
  tx_id TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
`);

const insOrder = db.prepare(`
  INSERT INTO orders (id, user_id, username, gift_to, stars, amount_rub, payment_provider, payment_id, status, created_at, updated_at)
  VALUES (@id, @user_id, @username, @gift_to, @stars, @amount_rub, @payment_provider, @payment_id, @status, @created_at, @updated_at)
`);

const updStatus = db.prepare(`
  UPDATE orders SET status=@status, updated_at=@updated_at WHERE id=@id
`);
const setPaid = db.prepare(`
  UPDATE orders SET status='paid', tx_id=@tx_id, updated_at=@updated_at WHERE id=@id
`);
const setDelivering = db.prepare(`
  UPDATE orders SET status='delivering', retries=retries+1, updated_at=@updated_at WHERE id=@id
`);
const setDelivered = db.prepare(`
  UPDATE orders SET status='delivered', tx_id=@tx_id, updated_at=@updated_at WHERE id=@id
`);
const setFailed = db.prepare(`
  UPDATE orders SET status='failed', updated_at=@updated_at WHERE id=@id
`);
const findById = db.prepare(`SELECT * FROM orders WHERE id=?`);
const nextPaidForDelivery = db.prepare(`
  SELECT * FROM orders
  WHERE status='paid' OR (status='delivering' AND retries<5)
  ORDER BY updated_at ASC
  LIMIT 1
`);

// === Helpers ===
const now = () => dayjs().toISOString();
const calcAmountRub = (stars) => Math.round(stars * RUB_PER_STAR * 100) / 100;

function signOk(req, secret) {
  if (!secret) return false;
  const header = req.get('X-Sign') || '';
  return header === secret; // упрощённо, без HMAC, по твоей текущей логике
}

async function createSbpInvoice(orderId, amountRub) {
  // Создание QR/инвойса в QRManager
  // Используем минимальный универсальный формат: notification_url должен указывать на наш вебхук.
  const url = `${QRM_BASE}/api/invoice/create`;
  const body = {
    amount: amountRub,
    currency: 'RUB',
    order_id: orderId,
    notification_url: `${PUBLIC_BASE}/webhook/sbp`,
    description: `StarsFabrica #${orderId}`
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${QRM_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    throw new Error(`QRManager create failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  // ожидаем { invoice_id, pay_url, qr_base64, ... }
  return {
    invoiceId: data.invoice_id || data.id || orderId,
    payUrl: data.pay_url || data.url || null,
    qrBase64: data.qr_base64 || null
  };
}

// === Telegram Bot ===
const bot = new Telegraf(BOT_TOKEN);

const PACKS = [
  { name: '⭐ 50', stars: 50 },
  { name: '⭐ 100', stars: 100 },
  { name: '⭐ 250', stars: 250 },
  { name: '⭐ 500', stars: 500 },
];

bot.start(async (ctx) => {
  const kb = Markup.keyboard([['Купить себе'], ['Подарить звезды']]).resize();
  await ctx.reply('Привет! Это StarsFabrica. Выбери действие:', kb);
});

bot.hears('Купить себе', async (ctx) => {
  const buttons = PACKS.map(p =>
    [Markup.button.callback(`${p.name} — ${calcAmountRub(p.stars)}₽`, `buy:${p.stars}`)]
  );
  await ctx.reply('Выбери пакет:', Markup.inlineKeyboard(buttons));
});

bot.action(/buy:(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const stars = Number(ctx.match[1]);
    const amount = calcAmountRub(stars);
    const id = uuid();

    // создаём инвойс в QRManager
    const inv = await createSbpInvoice(id, amount);

    // сохраняем заказ
    insOrder.run({
      id,
      user_id: String(ctx.from.id),
      username: ctx.from.username || '',
      gift_to: '',
      stars,
      amount_rub: amount,
      payment_provider: 'sbp',
      payment_id: inv.invoiceId,
      status: 'pending',
      created_at: now(),
      updated_at: now()
    });

    const payText = [
      `Заказ #${id}`,
      `Пакет: ${stars} ⭐`,
      `К оплате: ${amount} ₽`,
      '',
      inv.payUrl ? `Оплатить: ${inv.payUrl}` : 'Сканируйте QR для оплаты.',
      '',
      'После оплаты дождитесь подтверждения.'
    ].join('\n');

    if (inv.qrBase64) {
      const buf = Buffer.from(inv.qrBase64, 'base64');
      await ctx.replyWithPhoto({ source: buf }, { caption: payText });
    } else {
      await ctx.reply(payText);
    }

    if (ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🆕 Новый заказ #${id}\nПользователь: @${ctx.from.username || ctx.from.id}\n${stars}⭐ = ${amount}₽`
      );
    }
  } catch (e) {
    console.error('buy error:', e);
    await ctx.reply('Не удалось создать счёт. Попробуйте позже.');
  }
});

// подарки (упрощённо)
bot.hears('Подарить звезды', async (ctx) => {
  await ctx.reply('Пока в этой версии подарки оформляем вручную — напишите @админу, кого хотите поздравить 😊');
});

// === Web server ===
const app = express();
app.use(express.json({ limit: '1mb' }));

// health
app.get('/health', (_req, res) => res.status(200).send('ok'));

// --- Webhooks ---
// Универсальный «чекаут РУБ»
app.post('/webhook/rub', async (req, res) => {
  try {
    if (!signOk(req, WEBHOOK_SECRET_RUB)) return res.status(403).send('forbidden');
    const { orderId, status, txId } = req.body || {};
    if (!orderId) return res.status(400).send('no orderId');

    const order = findById.get(orderId);
    if (!order) return res.status(404).send('not found');

    if (status === 'paid' && order.status !== 'paid' && order.status !== 'delivered') {
      setPaid.run({ id: orderId, tx_id: txId || 'paid', updated_at: now() });
      await notifyPaid(orderId);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('webhook/rub error', e);
    res.status(500).json({ ok: false });
  }
});

// Крипто провайдер (если используешь)
app.post('/webhook/crypto', async (req, res) => {
  try {
    if (!signOk(req, WEBHOOK_SECRET_CRYPTO)) return res.status(403).send('forbidden');
    const { orderId, status, txId } = req.body || {};
    if (!orderId) return res.status(400).send('no orderId');

    const order = findById.get(orderId);
    if (!order) return res.status(404).send('not found');

    if (status === 'paid' && order.status !== 'paid' && order.status !== 'delivered') {
      setPaid.run({ id: orderId, tx_id: txId || 'paid', updated_at: now() });
      await notifyPaid(orderId);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('webhook/crypto error', e);
    res.status(500).json({ ok: false });
  }
});

// Webhook от QRManager (СБП)
app.post('/webhook/sbp', async (req, res) => {
  try {
    const { order_id, status, tx_id } = req.body || {};
    if (!order_id) return res.status(400).send('no order_id');

    const order = findById.get(order_id);
    if (!order) return res.status(404).send('not found');

    if (String(status).toLowerCase() === 'paid' && order.status !== 'paid' && order.status !== 'delivered') {
      setPaid.run({ id: order_id, tx_id: tx_id || 'paid', updated_at: now() });
      await notifyPaid(order_id);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('webhook/sbp error', e);
    res.status(500).json({ ok: false });
  }
});

// === Notify helpers ===
async function notifyPaid(orderId) {
  const o = findById.get(orderId);
  if (!o) return;
  const userId = Number(o.user_id);

  // пользователю
  try {
    await bot.telegram.sendMessage(
      userId,
      `✅ Оплата получена.\nЗаказ #${o.id}\n${o.stars}⭐\nЗапускаем доставку…`
    );
  } catch {}

  // админу
  if (ADMIN_CHAT_ID) {
    try {
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `💳 Оплачен заказ #${o.id} (${o.stars}⭐, ${o.amount_rub}₽).`
      );
    } catch {}
  }
}

// === Delivery worker (Fragment) ===
async function processDeliveryOnce() {
  // берём ближайший заказ к доставке
  const order = nextPaidForDelivery.get();
  if (!order) return;

  // если уже доставляется — дадим ещё попытку (<=5)
  try {
    setDelivering.run({ id: order.id, updated_at: now() });

    // получатель: свой username (если не подарок)
    const recipient = (order.gift_to && order.gift_to.trim())
      ? order.gift_to.trim().replace(/^@/, '')
      : (order.username || '').replace(/^@/, '');

    if (!recipient) {
      throw new Error('Пустой получатель: нет username');
    }

    const result = await deliverViaFragment({
  orderId: order.id,
  stars: Number(order.stars),
  recipient
});
    if (!result || !result.ok) {
      const reason = result?.reason || 'Fragment delivery failed';
      throw new Error(reason);
    }

    // успех
    setDelivered.run({ id: order.id, tx_id: result.tx || 'fragment', updated_at: now() });

    // нотификация пользователю
    try {
      await bot.telegram.sendMessage(
        Number(order.user_id),
        `🎉 Доставлено!\nЗаказ #${order.id}\nНачислено: ${order.stars}⭐\nTX: ${result.tx || 'n/a'}`
      );
    } catch {}

    // админу
    if (ADMIN_CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🚀 Доставлено: #${order.id} → @${recipient} (${order.stars}⭐)\nTX: ${result.tx || 'n/a'}`
        );
      } catch {}
    }
  } catch (e) {
    console.error('delivery error:', e?.message || e);

    const current = findById.get(order.id);
    if (!current) return;

    if (current.retries >= 4) {
      // фатал
      setFailed.run({ id: order.id, updated_at: now() });
      try {
        await bot.telegram.sendMessage(
          Number(current.user_id),
          `⚠️ Не удалось доставить заказ #${current.id}. Мы уже разбираемся и вернёмся с решением.`
        );
      } catch {}
      if (ADMIN_CHAT_ID) {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `❌ FAIL доставка #${current.id}: ${e.message}`
        ).catch(()=>{});
      }
    } else {
      // оставляем статус 'delivering' с увеличенным retries — на следующем цикле попробуем снова
      if (ADMIN_CHAT_ID) {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `♻️ Ретрай доставки #${current.id} (${current.retries+1}/5): ${e.message}`
        ).catch(()=>{});
      }
    }
  }
}

// Цикл воркера
if (AUTODELIVER) {
  setInterval(processDeliveryOnce, 7000);
}

// === Start ===
app.listen(PORT, () => {
  console.log(`HTTP on :${PORT}`);
});
bot.launch().then(() => console.log('Bot launched')).catch(console.error);

// корректное завершение
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
