// app.js — StarFabrica (ESM)
import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import dayjs from 'dayjs';
import path from 'path';
import { fileURLToPath } from 'url';

/* ── ENV ─────────────────────────────────────────── */
const {
  BOT_TOKEN, ADMIN_CHAT_ID, PORT = 3000,
  WEBHOOK_SECRET_CRYPTO, WEBHOOK_SECRET_RUB,
  CHECKOUT_CRYPTO,
  CHECKOUT_RUB,
  DELIVERY_ETA_MIN = 15,
  // ⬇️ новое для СБП (QRManager)
  QRM_BASE, QRM_TOKEN, PUBLIC_BASE, QRM_WEBHOOK_SECRET
} = process.env;
if (!BOT_TOKEN) { console.error('BOT_TOKEN missing'); process.exit(1); }

/* ── DB ──────────────────────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const db = new Database(path.join(__dirname, 'db', 'starfall.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  username TEXT,
  stars INTEGER NOT NULL,
  price_rub INTEGER,
  price_usdt REAL,
  currency TEXT,
  status TEXT NOT NULL,
  provider_tx TEXT,
  gift_to TEXT,
  admin_msg_id INTEGER,
  sbp_operation_id TEXT,
  sbp_number TEXT,
  sbp_qr_link TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS delivery_queue(
  order_id TEXT PRIMARY KEY,
  try_count INTEGER DEFAULT 0,
  last_error TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS sbp_watch(
  order_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  tries INTEGER DEFAULT 0,
  next_check_at INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sbp_watch_next ON sbp_watch(next_check_at);
`);

try { db.exec(`ALTER TABLE orders ADD COLUMN gift_to TEXT`); } catch {}
try { db.exec(`ALTER TABLE orders ADD COLUMN admin_msg_id INTEGER`); } catch {}
try { db.exec('ALTER TABLE orders ADD COLUMN sbp_operation_id TEXT'); } catch {}
try { db.exec('ALTER TABLE orders ADD COLUMN sbp_number TEXT'); } catch {}
try { db.exec('ALTER TABLE orders ADD COLUMN sbp_qr_link TEXT'); } catch {}

const qIns = db.prepare(`
  INSERT INTO orders(id,user_id,username,stars,price_rub,price_usdt,status,gift_to)
  VALUES (?,?,?,?,?,?,?,?)
`);
const qGet = db.prepare(`SELECT * FROM orders WHERE id=?`);
const qLast = db.prepare(`SELECT id,stars,status,currency,created_at FROM orders ORDER BY created_at DESC LIMIT ?`);
const qPaid = db.prepare(`UPDATE orders SET status='paid', currency=?, provider_tx=? WHERE id=?`);
const qDelivered = db.prepare(`UPDATE orders SET status='delivered' WHERE id=?`);
const qSetAdminId = db.prepare(`UPDATE orders SET admin_msg_id=? WHERE id=?`);
const qSetSbpInfo = db.prepare(`
  UPDATE orders SET sbp_operation_id=?, sbp_number=?, sbp_qr_link=? WHERE id=?
`);

const qEnq = db.prepare(`INSERT OR IGNORE INTO delivery_queue(order_id) VALUES(?)`);
const qPop = db.prepare(`
  SELECT q.order_id, o.user_id, o.username, o.gift_to, o.stars, o.admin_msg_id
  FROM delivery_queue q JOIN orders o ON o.id=q.order_id
  WHERE o.status='paid' ORDER BY q.updated_at ASC LIMIT 1
`);
const qBump = db.prepare(`UPDATE delivery_queue SET try_count=try_count+1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE order_id=?`);
const qTries = db.prepare(`SELECT try_count FROM delivery_queue WHERE order_id=?`);
const qDelQ = db.prepare(`DELETE FROM delivery_queue WHERE order_id=?`);

/* ── UTILS ───────────────────────────────────────── */
const PACKS = [70, 100, 250, 500, 1000, 2500];
const calcPrice = s => ({ rub: Math.round(s * 1.8), usdt: +(s * 0.025).toFixed(2) });
const isSigned = (req, secret) => !!secret && (req.get('X-Sign') || req.get('x-sign')) === secret;
const uname = (u) => u?.username ? `@${u.username}` : `id:${u?.id}`;
const adminMsg = (bot, text, o) => ADMIN_CHAT_ID &&
  bot.telegram.sendMessage(Number(ADMIN_CHAT_ID), text, { parse_mode:'HTML', reply_to_message_id: o?.admin_msg_id }).catch(()=>{});

// убираем «лишние» символы из назначения платежа
const sanitizePurpose = (s) =>
  String(s ?? '')
    .replace(/[^\w\s.,-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);

// единая клавиатура оплаты
const paymentKb = (sbp, id, rub, usdt) => Markup.inlineKeyboard(
  [
    sbp?.qrLink ? [Markup.button.url('🏦 Оплатить СБП', sbp.qrLink)] : [],
    CHECKOUT_RUB ? [Markup.button.url('💳 Оплатить RUB', `${CHECKOUT_RUB}?order=${id}&amount=${rub}`)] : [],
    CHECKOUT_CRYPTO ? [Markup.button.url('🪙 Оплатить криптой', `${CHECKOUT_CRYPTO}?order=${id}&amount=${usdt}`)] : [],
    sbp?.operationId ? [Markup.button.callback('🔄 Проверить оплату СБП', `check_sbp_${id}`)] : [],
    [Markup.button.callback('Назад', 'back_home')]
  ].filter(r => r.length)
);

/* ── QRManager client ───────────────────────────── */
async function qrmRequest(urlPath, { method = 'POST', body } = {}) {
  if (!QRM_BASE || !QRM_TOKEN) throw new Error('QRManager env missing');
  const res = await fetch(`${QRM_BASE.replace(/\/$/, '')}${urlPath}`, {
    method,
    headers: {
      'X-Api-Key': QRM_TOKEN,
      'Accept': 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> '');
    throw new Error(`QRManager ${method} ${urlPath} ${res.status}: ${t}`);
  }
  return res.json();
}

// создать платёж СБП — POST /operations/qr-code/
async function createSbpPayment({ orderId, amountRub, comment }) {
  const payload = {
    sum: Math.round(Number(amountRub)),                     // QRM ждёт рубли (как в твоём cURL)
    qr_size: 400,
    payment_purpose: sanitizePurpose(comment || `Order ${orderId}`),
    notification_url: `${PUBLIC_BASE.replace(/\/$/, '')}/webhook/sbp`
  };
  const data = await qrmRequest('/operations/qr-code/', { body: payload });
  const r = data.results || data;
  return {
    operationId: r.operation_id || r.operationId,
    number:      r.number || null,
    qrLink:      r.qr_link || (r.qr && (r.qr.url || r.qr.link)) || null
  };
}

// статус операции СБП — GET /operations/{id}/qr-status/
async function getSbpStatus(operationId) {
  const data = await qrmRequest(`/operations/${operationId}/qr-status/`, { method: 'GET' });
  const r = data.results || data;
  const code = Number(r.operation_status_code);
  return { status: r.operation_status_msg || String(code), paid: code === 5 };
}

/* ── BOT ─────────────────────────────────────────── */
const bot = new Telegraf(BOT_TOKEN);
globalThis._gift = globalThis._gift || new Map();      // userId -> {stage:'await_user'|'pick_pack', gift_to}
globalThis._flow = globalThis._flow || new Map();      // userId -> {wait:'qty_self'}

const mainMenu = (ctx, t='✨ STARSFABRICA — звёзды по приятным ценам. Себе, друзьям, близким! \nВыбери действие:') =>
  ctx.reply(t, Markup.inlineKeyboard([
    [Markup.button.callback('⭐ Купить себе', 'buy_menu')],
    [Markup.button.callback('🎁 Купить другу', 'gift_start')],
    [Markup.button.url('🛒 Открыть мини-апп', 'https://shop.starsfabrica.store')],
    [Markup.button.url('🆘 Поддержка', 'https://t.me/ttbono')]
  ]));

bot.start(ctx => mainMenu(ctx));

/* меню покупки себе */
bot.action('buy_menu', ctx => {
  const rows = [
    [Markup.button.callback('🔢 Другое количество', 'custom_qty_self')],
    ...PACKS.map(p => [Markup.button.callback(`✨ ${p} звёзд`, `buy_${p}`)]),
    [Markup.button.callback('Назад', 'back_home')]
  ];
  return ctx.editMessageText('⭐ Выбери пакет или нажми «Другое количество»:',
    Markup.inlineKeyboard(rows));
});

bot.action('back_home', async ctx => { try { await ctx.deleteMessage(); } catch {} return mainMenu(ctx,'◀️ Вернулись назад.'); });

/* покупка себе — фикс пакеты */
bot.action(/buy_(\d+)/, async ctx => {
  await ctx.answerCbQuery();
  const stars = +ctx.match[1];
  const { rub, usdt } = calcPrice(stars);
  const id = uuid();

  qIns.run(id, ctx.from.id, ctx.from.username || '', stars, rub, usdt, 'created', null);

  // создаём СБП
  let sbp = {};
  try {
    sbp = await createSbpPayment({ orderId: id, amountRub: rub, comment: `Stars ${stars} id ${id}` });
    qSetSbpInfo.run(sbp.operationId || null, sbp.number || null, sbp.qrLink || null, id);
    if (sbp.operationId) {
      db.prepare('INSERT OR REPLACE INTO sbp_watch(order_id, operation_id, tries, next_check_at) VALUES (?,?,0,?)')
        .run(id, sbp.operationId, Date.now() + 15_000);
    }
  } catch (e) {
    console.error('SBP create error:', e.message);
  }

  await ctx.editMessageText(
`✅ Заказ создан

🧾 Номер: ${id}
⭐ Пакет: ${stars} звёзд
💸 К оплате: ${rub}₽ или ${usdt} USDT`,
    paymentKb(sbp, id, rub, usdt)
  );

  if (ADMIN_CHAT_ID) {
    try {
      const m = await bot.telegram.sendMessage(
        Number(ADMIN_CHAT_ID),
        `🆕 <b>Новый заказ</b>\n🧾 <code>${id}</code>\n⭐ ${stars}\n💸 ${rub}₽ / ${usdt} USDT\n👤 ${uname(ctx.from)}`,
        { parse_mode:'HTML' }
      );
      qSetAdminId.run(m.message_id, id);
    } catch {}
  }
});

/* покупка себе — произвольное количество */
bot.action('custom_qty_self', async ctx => {
  await ctx.answerCbQuery(); _flow.set(ctx.from.id, { wait: 'qty_self' });
  return ctx.reply('Введите количество звёзд числом (от 70 до 1 000 000):',
    Markup.inlineKeyboard([[Markup.button.callback('Назад', 'back_home')]]));
});

/* подарок — поток */
bot.action('gift_start', async ctx => {
  await ctx.answerCbQuery(); _gift.set(ctx.from.id, { stage: 'await_user' });
  return ctx.reply('🎁 Введите @юзернейм друга (или его ID):',
    Markup.inlineKeyboard([[Markup.button.callback('Назад', 'back_home')]]));
});
bot.action('gift_custom_qty', async ctx => {
  await ctx.answerCbQuery(); const st = _gift.get(ctx.from.id);
  if (!st || st.stage!=='pick_pack') return ctx.answerCbQuery('Сначала введите получателя',{show_alert:true});
  return ctx.reply('Введите нужное количество звёзд числом (от 70 до 1 000 000):');
});
bot.action(/gift_(\d+)/, async ctx => {
  await ctx.answerCbQuery(); const st = _gift.get(ctx.from.id);
  if (!st || st.stage!=='pick_pack' || !st.gift_to) return ctx.answerCbQuery('Сначала введите получателя',{show_alert:true});
  await createGiftOrder(ctx, +ctx.match[1], st.gift_to); _gift.delete(ctx.from.id);
});

/* универсальный приём текста: получатель подарка / произвольное число */
bot.on('text', async ctx => {
  const txt = (ctx.message.text || '').trim();

  // подарок: ввод получателя
  const stG = _gift.get(ctx.from.id);
  if (stG?.stage === 'await_user') {
    _gift.set(ctx.from.id, { stage: 'pick_pack', gift_to: txt });
    const rows = [
      [Markup.button.callback('🔢 Другое количество', 'gift_custom_qty')],
      ...PACKS.map(p => [Markup.button.callback(`✨ ${p} звёзд`, `gift_${p}`)]),
      [Markup.button.callback('Назад', 'back_home')]
    ];
    return ctx.reply(`Ок! 🎉 Покупаем звёзды для ${txt}. Выберите пакет или введите своё количество:`,
      Markup.inlineKeyboard(rows));
  }

  // подарок: пользователь ввёл число вместо кнопки
  if (stG?.stage === 'pick_pack' && stG?.gift_to) {
    const stars = parseStars(txt);
    if (stars) { await createGiftOrder(ctx, stars, stG.gift_to); _gift.delete(ctx.from.id); }
    else return ctx.reply('Число вне диапазона. Введите от 70 до 1 000 000.');
    return;
  }

  // покупка себе: произвольное число
  const stF = _flow.get(ctx.from.id);
  if (stF?.wait === 'qty_self') {
    const stars = parseStars(txt); if (!stars) return ctx.reply('Число вне диапазона. Введите от 70 до 1 000 000.');
    const { rub, usdt } = calcPrice(stars); const id = uuid();

    qIns.run(id, ctx.from.id, ctx.from.username || '', stars, rub, usdt, 'created', null);

    // создаём СБП
    let sbp = {};
    try {
      sbp = await createSbpPayment({ orderId: id, amountRub: rub, comment: `Stars ${stars} id ${id}` });
      qSetSbpInfo.run(sbp.operationId || null, sbp.number || null, sbp.qrLink || null, id);
      if (sbp.operationId) {
        db.prepare('INSERT OR REPLACE INTO sbp_watch(order_id, operation_id, tries, next_check_at) VALUES (?,?,0,?)')
          .run(id, sbp.operationId, Date.now() + 15_000);
      }
    } catch (e) {
      console.error('SBP create error:', e.message);
    }

    await ctx.reply(
`✅ Заказ создан

🧾 Номер: ${id}
⭐ Пакет: ${stars} звёзд
💸 К оплате: ${rub}₽ или ${usdt} USDT`,
      paymentKb(sbp, id, rub, usdt)
    );

    // уведомляем админа
    if (ADMIN_CHAT_ID) {
      try {
        const m = await bot.telegram.sendMessage(
          Number(ADMIN_CHAT_ID),
          `🆕 <b>Новый заказ</b>\n🧾 <code>${id}</code>\n⭐ ${stars}\n💸 ${rub}₽ / ${usdt} USDT\n👤 ${uname(ctx.from)}`,
          { parse_mode: 'HTML' }
        );
        qSetAdminId.run(m.message_id, id);
      } catch (e) {
        console.error('admin notify (custom qty):', e?.description || e?.message || e);
      }
    }

    _flow.delete(ctx.from.id);
  }
});

function parseStars(s) {
  const n = parseInt(String(s).replace(/\D/g,''), 10);
  return Number.isFinite(n) && n >= 70 && n <= 1_000_000 ? n : null;
}

async function createGiftOrder(ctx, stars, giftTo) {
  const { rub, usdt } = calcPrice(stars); const id = uuid();
  qIns.run(id, ctx.from.id, ctx.from.username || '', stars, rub, usdt, 'created', giftTo);

  // создаём СБП для подарка тоже
  let sbp = {};
  try {
    sbp = await createSbpPayment({ orderId: id, amountRub: rub, comment: `Gift ${stars} id ${id}` });
    qSetSbpInfo.run(sbp.operationId || null, sbp.number || null, sbp.qrLink || null, id);
    if (sbp.operationId) {
      db.prepare('INSERT OR REPLACE INTO sbp_watch(order_id, operation_id, tries, next_check_at) VALUES (?,?,0,?)')
        .run(id, sbp.operationId, Date.now() + 15_000);
    }
  } catch (e) {
    console.error('SBP create error:', e.message);
  }

  await ctx.reply(
`✅ Заказ создан (🎁 для ${giftTo})

🧾 Номер: ${id}
⭐ Пакет: ${stars} звёзд
💸 К оплате: ${rub}₽ или ${usdt} USDT`,
    paymentKb(sbp, id, rub, usdt)
  );

  if (ADMIN_CHAT_ID) try {
    const m = await bot.telegram.sendMessage(Number(ADMIN_CHAT_ID),
      `🆕 <b>Новый заказ (ПОДАРОК)</b>\n🧾 <code>${id}</code>\n⭐ ${stars}\n💸 ${rub}₽ / ${usdt} USDT\n👤 ${uname(ctx.from)}\n🎁 Получатель: ${giftTo}`, { parse_mode:'HTML' });
    qSetAdminId.run(m.message_id, id);
  } catch {}
}

/* проверка СБП вручную */
bot.action(/check_sbp_(.+)/, async ctx => {
  await ctx.answerCbQuery();
  const orderId = ctx.match[1];
  const o = qGet.get(orderId);
  if (!o) return ctx.reply('⛔ Заказ не найден');
  if (!o.sbp_operation_id) return ctx.reply('Для заказа нет операции СБП');

  try {
    const st = await getSbpStatus(o.sbp_operation_id);
    if (st.paid) {
      await onPaid('RUB', orderId, o.sbp_operation_id);
      return ctx.reply('✅ Оплата по СБП подтверждена. Спасибо!');
    }
    return ctx.reply(`Статус: ${st.status || 'UNKNOWN'}. Если уже оплачивали — повторите проверку позже.`);
  } catch (e) {
    console.error('SBP status error:', e.message);
    return ctx.reply('Не удалось проверить статус. Попробуйте позднее.');
  }
});

/* мини-админ */
bot.command('last', ctx => {
  if (String(ctx.from.id) !== String(ADMIN_CHAT_ID)) return;
  const rows = qLast.all(5);
  if (!rows.length) return ctx.reply('Пока пусто');
  ctx.reply(rows.map(o => `🧾 <code>${o.id}</code>\n⭐ ${o.stars}\n💳 ${o.status}${o.currency?` (${o.currency})`:''}\n🕒 ${dayjs(o.created_at).format('YYYY-MM-DD HH:mm')}`)
    .join('\n\n'), { parse_mode:'HTML' });
});
bot.command('o', ctx => {
  const [, id] = (ctx.message.text||'').split(/\s+/,2);
  if (!id) return ctx.reply('Usage: /o <orderId>');
  const o = qGet.get(id); if (!o) return ctx.reply('⛔ Не найдено');
  ctx.reply([
    `🧾 ID: ${o.id}`,
    `⭐ Звёзд: ${o.stars}`,
    `💳 Статус: ${o.status}${o.currency?` (${o.currency})`:''}`,
    o.provider_tx ? `🧷 Tx: ${o.provider_tx}` : null,
    o.gift_to ? `🎁 Получатель: ${o.gift_to}` : null,
    `🕒 ${dayjs(o.created_at).format('YYYY-MM-DD HH:mm')}`
  ].filter(Boolean).join('\n'));
});

/* ── HTTP ────────────────────────────────────────── */
const app = express(); app.use(express.json());
app.get('/health', (_,res)=>res.json({ok:true,ts:Date.now()}));

app.post('/webhook/crypto', async (req,res)=>{
  if (!isSigned(req, WEBHOOK_SECRET_CRYPTO)) return res.status(401).end('Unauthorized');
  const { orderId, status, txId } = req.body || {};
  if (!orderId) return res.status(400).json({ ok:false, error:'orderId required' });
  if (status === 'paid') await onPaid('USDT', orderId, txId);
  res.json({ok:true});
});

app.post('/webhook/rub', async (req,res)=>{
  if (!isSigned(req, WEBHOOK_SECRET_RUB)) return res.status(401).end('Unauthorized');
  const { orderId, status, txId } = req.body || {};
  if (!orderId) return res.status(400).json({ ok:false, error:'orderId required' });
  if (status === 'paid') await onPaid('RUB', orderId, txId);
  res.json({ok:true});
});

/* вебхук СБП (QRManager) */
app.post('/webhook/sbp', async (req, res) => {
  try {
    const p = req.body || {};
    const operationId = p.id || p.operation_id || p.operationId;
    const number      = p.number || p.sbp_number || null;
    const code        = Number(p.operation_status_code ?? p.code ?? p.status_code);

    if (!operationId) return res.status(400).json({ ok:false, error:'missing operation id' });

    const o = db.prepare(
      'SELECT * FROM orders WHERE sbp_operation_id = ? OR sbp_number = ?'
    ).get(operationId, number);

    if (!o) {
      console.warn('SBP webhook: order not found', { operationId, number, code });
      return res.json({ ok:true, note:'order not found' });
    }

    if (code === 5) { // оплачено
      if (o.status !== 'paid' && o.status !== 'delivered') {
        await onPaid('RUB', o.id, operationId);
      }
      db.prepare('DELETE FROM sbp_watch WHERE order_id = ?').run(o.id);
    } else {
      db.prepare(`
        INSERT OR IGNORE INTO sbp_watch(order_id, operation_id, tries, next_check_at)
        VALUES (?, ?, 0, ?)
      `).run(o.id, operationId, Date.now() + 15000);
    }

    res.json({ ok:true });
  } catch (e) {
    console.error('SBP webhook error:', e?.stack || e?.message || e);
    res.status(500).json({ ok:false });
  }
});

async function onPaid(currency, orderId, txId) {
  qPaid.run(currency, txId||null, orderId);
  const o = qGet.get(orderId); if (!o) return;

  const paidText =
    `✅ <b>Оплата получена</b>\n` +
    `🧾 <code>${o.id}</code>\n` +
    `⭐ ${o.stars}\n` +
    `💱 ${currency} (СБП)\n` +
    `📌 Статус: paid\n` +
    `👤 ${o.username ? '@'+o.username : 'id:'+o.user_id}\n` +
    (o.gift_to ? `🎁 Получатель: ${o.gift_to}\n` : '') +
    `🧷 <code>${txId || '-'}</code>`;

  adminMsg(bot, paidText, o);

  try {
    await bot.telegram.sendMessage(
      o.user_id,
      `✅ Заказ оплачен.\n` +
      (o.gift_to ? `🎁 Подарок будет отправлен: ${o.gift_to}\n` : '') +
      `Доставка ${o.stars} ⭐ занимает ~${DELIVERY_ETA_MIN} мин. Сообщу, когда завершится.`
    );
  } catch {}

  qEnq.run(orderId);
}

/* ── WORKER (mock delivery) ─────────────────────── */
async function deliverStars(job){ await new Promise(r=>setTimeout(r,1500)); return {ok:true}; }
const TICK=5000, MAX_TRIES=8;
setInterval(async ()=>{
  try{
    const j=qPop.get(); if(!j) return;
    const r=await deliverStars(j);
    if(r.ok){
      qDelivered.run(j.order_id); qDelQ.run(j.order_id);
      try{ await bot.telegram.sendMessage(j.user_id, `🎉 Доставлено ${j.stars} ⭐. Спасибо!`);}catch{}
      const o=qGet.get(j.order_id); adminMsg(bot, `✅ <b>Доставка завершена</b>\n🧾 <code>${o.id}</code>\n⭐ ${o.stars}`, o);
    }else{
      qBump.run(r.reason||'unknown', j.order_id);
      const t=qTries.get(j.order_id)?.try_count||0;
      if(t>=MAX_TRIES){ adminMsg(bot, `⛔ Не удалось доставить <code>${j.order_id}</code> (${t} попыток)`, j); qDelQ.run(j.order_id); }
    }
  }catch(e){ console.error('worker:',e.message); }
}, TICK);

//_____WORKER (проверка оплаты авто)
const SBP_TICK = 10_000;
const SBP_MAX_TRIES = 40;

setInterval(async () => {
  try {
    const now = Date.now();
    const rows = db.prepare('SELECT order_id, operation_id, tries FROM sbp_watch WHERE next_check_at <= ? LIMIT 10').all(now);
    for (const r of rows) {
      try {
        const st = await getSbpStatus(r.operation_id);
        if (st.paid) {
          await onPaid('RUB', r.order_id, r.operation_id);
          db.prepare('DELETE FROM sbp_watch WHERE order_id=?').run(r.order_id);
          continue;
        }
        const tries = r.tries + 1;
        const delay = Math.min(60_000, 15_000 * tries); // 15s, 30s, 45s, ... до 60s
        db.prepare('UPDATE sbp_watch SET tries=?, next_check_at=? WHERE order_id=?')
          .run(tries, Date.now() + delay, r.order_id);

        if (tries >= SBP_MAX_TRIES) {
          db.prepare('DELETE FROM sbp_watch WHERE order_id=?').run(r.order_id);
        }
      } catch (e) {
        console.error('sbp watch check error:', e.message);
        db.prepare('UPDATE sbp_watch SET next_check_at=? WHERE order_id=?')
          .run(Date.now() + 30_000, r.order_id);
      }
    }
  } catch (e) {
    console.error('sbp watch loop:', e.message);
  }
}, SBP_TICK);

/* ── START ──────────────────────────────────────── */
const appInstance = app.listen(PORT, ()=>console.log(`HTTP on ${PORT}`));
bot.launch().then(()=>console.log('Bot polling started'));
process.once('SIGINT', ()=>{ bot.stop('SIGINT'); appInstance.close(); });
process.once('SIGTERM', ()=>{ bot.stop('SIGTERM'); appInstance.close(); });

