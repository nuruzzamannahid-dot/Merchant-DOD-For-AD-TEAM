const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

// Set these in Render's Environment tab (Settings → Environment).
// Never hardcode them in this file.
const turso = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN
});

// Telegram + notify config — also set as Render env vars, never hardcoded.
// TELEGRAM_BOT_TOKEN  — from @BotFather
// TELEGRAM_CHAT_ID    — your DM chat id with the bot (see README notes)
// NOTIFY_SECRET       — any random string; Apps Script must send it back to us
// ALERT_DAYS          — consecutive zero-order days that counts as "flagged" (default 2)
// INGEST_SECRET       — any random string; the Google Sheet's Apps Script sends
//                        this back to us so /api/ingest can't be written to by anyone else
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;
const ALERT_DAYS = parseInt(process.env.ALERT_DAYS || '2', 10);
const INGEST_SECRET = process.env.INGEST_SECRET;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function ensureSchema() {
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS dashboard_data (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

// The dashboard calls this same-origin endpoint. Data is read from
// Turso, which Apps Script keeps fresh on its own timer — so this
// responds instantly and never waits on Apps Script directly.
app.get('/api/data', async (req, res) => {
  try {
    const result = await turso.execute('SELECT payload, updated_at FROM dashboard_data WHERE id = 1');
    if (!result.rows.length) {
      return res.status(404).json({
        error: 'No data yet — the Apps Script push trigger may not have run.'
      });
    }
    const row = result.rows[0];
    const data = JSON.parse(row.payload);
    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    console.error('Failed to read from Turso:', err);
    res.status(502).json({
      error: 'Failed to fetch data from Turso',
      detail: String(err)
    });
  }
});

// The Google Sheet's Apps Script calls this to push freshly pivoted
// data in. Body shape: { dates: ["2026-08-01", ...], merchants: [
//   { businessId, businessName, assignedKam, orders: [9, 6, 7, ...] }
// ] }. Requires ?secret=INGEST_SECRET (or an x-ingest-secret header).
app.post('/api/ingest', async (req, res) => {
  try {
    const secret = req.query.secret || req.get('x-ingest-secret');
    if (!INGEST_SECRET || secret !== INGEST_SECRET) {
      return res.status(401).json({ error: 'Missing or invalid secret.' });
    }

    const body = req.body || {};
    const dates = body.dates;
    const merchants = body.merchants;

    if (!Array.isArray(dates) || !Array.isArray(merchants)) {
      return res.status(400).json({
        error: 'Payload must be { dates: [...], merchants: [...] }.'
      });
    }
    for (const m of merchants) {
      if (!m || typeof m.businessId === 'undefined' || typeof m.businessName === 'undefined') {
        return res.status(400).json({
          error: 'Every merchant needs businessId and businessName.'
        });
      }
      if (!Array.isArray(m.orders)) {
        return res.status(400).json({ error: `Merchant ${m.businessId} is missing an orders array.` });
      }
      if (typeof m.cod !== 'undefined' && !Array.isArray(m.cod)) {
        return res.status(400).json({ error: `Merchant ${m.businessId}'s cod field must be an array if present.` });
      }
      if (typeof m.revenue !== 'undefined' && !Array.isArray(m.revenue)) {
        return res.status(400).json({ error: `Merchant ${m.businessId}'s revenue field must be an array if present.` });
      }
      if (typeof m.delivered !== 'undefined' && !Array.isArray(m.delivered)) {
        return res.status(400).json({ error: `Merchant ${m.businessId}'s delivered field must be an array if present.` });
      }
      if (typeof m.deliveryCharge !== 'undefined' && !Array.isArray(m.deliveryCharge)) {
        return res.status(400).json({ error: `Merchant ${m.businessId}'s deliveryCharge field must be an array if present.` });
      }
      if (typeof m.prev !== 'undefined' && m.prev !== null && typeof m.prev !== 'object') {
        return res.status(400).json({ error: `Merchant ${m.businessId}'s prev field must be an object or null if present.` });
      }
    }

    const previousMonthLabel = typeof body.previousMonthLabel === 'string' ? body.previousMonthLabel : null;
    const payload = JSON.stringify({ dates, merchants, previousMonthLabel });
    const updatedAt = new Date().toISOString();

    await turso.execute({
      sql: `INSERT INTO dashboard_data (id, payload, updated_at) VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      args: [payload, updatedAt]
    });

    res.json({ ok: true, dates: dates.length, merchants: merchants.length, updatedAt });
  } catch (err) {
    console.error('Ingest failed:', err);
    res.status(500).json({ error: 'Ingest failed', detail: String(err) });
  }
});

/* =========================================================
   Telegram "off 2+ days" reminder
   ========================================================= */

function isFlagged(orders) {
  const list = Array.isArray(orders) ? orders : [];
  if (list.length < ALERT_DAYS) return false;
  const tail = list.slice(list.length - ALERT_DAYS);
  return tail.every(v => (Number(v) || 0) === 0);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function groupByKam(merchants) {
  const groups = {};
  merchants.forEach(m => {
    const kam = m.assignedKam || '(Unassigned)';
    (groups[kam] = groups[kam] || []).push(m);
  });
  return groups;
}

// Builds Telegram-ready message chunks (each under Telegram's 4096-char
// hard limit). Splits between KAM blocks first, and within a block's
// merchant lines too if that single KAM's list is itself too long.
function buildMessages(groups, dateLabel, totalFlagged) {
  const header = totalFlagged
    ? `<b>🔴 ${totalFlagged} merchant${totalFlagged > 1 ? 's' : ''} off orders ${ALERT_DAYS}+ days</b>\n<i>as of ${escapeHtml(dateLabel)}</i>\n`
    : `<b>✅ No merchants flagged</b>\n<i>as of ${escapeHtml(dateLabel)}</i>\nEveryone placed an order within the last ${ALERT_DAYS} days.`;

  if (!totalFlagged) return [header];

  const LIMIT = 3800; // safety margin under Telegram's 4096 hard cap
  const kamNames = Object.keys(groups).sort();
  const messages = [];
  let current = header;

  const flush = () => {
    if (current.trim()) messages.push(current);
    current = '';
  };

  kamNames.forEach(kam => {
    const list = groups[kam].sort((a, b) => a.businessName.localeCompare(b.businessName));
    const title = `<b>${escapeHtml(kam)}</b> (${list.length})`;
    let block = (current ? current + '\n\n' : '') + title;

    list.forEach(m => {
      const line = `\n• ${escapeHtml(m.businessName)} <code>#${escapeHtml(m.businessId)}</code>`;
      if ((block + line).length > LIMIT) {
        // this block alone is too long — flush what we have and
        // continue the same KAM's list under a "(cont.)" header
        messages.push(block);
        block = `<b>${escapeHtml(kam)} (cont.)</b>` + line;
      } else {
        block += line;
      }
    });

    current = block;
  });

  flush();
  return messages;
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram send failed: ${data.description || res.status}`);
  }
  return data;
}

// Call this once per day, right after the Apps Script data dump finishes.
// GET /api/notify?secret=YOUR_NOTIFY_SECRET
// GET /api/notify?secret=YOUR_NOTIFY_SECRET&dry=1   -> preview only, doesn't send
app.get('/api/notify', async (req, res) => {
  try {
    if (!NOTIFY_SECRET || req.query.secret !== NOTIFY_SECRET) {
      return res.status(401).json({ error: 'Missing or invalid secret.' });
    }
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured.' });
    }

    const result = await turso.execute('SELECT payload, updated_at FROM dashboard_data WHERE id = 1');
    if (!result.rows.length) {
      return res.status(404).json({ error: 'No dashboard data yet.' });
    }
    const payload = JSON.parse(result.rows[0].payload);
    const dates = payload.dates || [];
    const merchants = payload.merchants || [];
    const dateLabel = dates.length ? dates[dates.length - 1] : 'unknown date';

    const flagged = merchants.filter(m => isFlagged(m.orders));
    const groups = groupByKam(flagged);
    const messages = buildMessages(groups, dateLabel, flagged.length);

    if (req.query.dry) {
      return res.json({ ok: true, dry: true, flaggedCount: flagged.length, messages });
    }

    for (const msg of messages) {
      await sendTelegramMessage(msg);
    }

    res.json({ ok: true, flaggedCount: flagged.length, messagesSent: messages.length });
  } catch (err) {
    console.error('Notify failed:', err);
    res.status(500).json({ error: 'Notify failed', detail: String(err) });
  }
});

ensureSchema()
  .then(() => {
    console.log('Turso schema ready.');
    app.listen(PORT, () => {
      console.log(`Merchant Pulse server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to set up Turso schema — starting anyway:', err);
    app.listen(PORT, () => {
      console.log(`Merchant Pulse server running on port ${PORT}`);
    });
  });
