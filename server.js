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
