const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Your Apps Script Web App URL. Can be overridden via an env var on Render
// (Environment tab) so you never have to touch code if it changes.
const WEB_APP_URL = process.env.WEB_APP_URL ||
  "https://script.google.com/macros/s/AKfycbxoY-Zcp2I3DPP_XbS_tJNOCnbY7p26Rdd3WeLIuV1JFBO0P1fZrv6Q6hxVADmHZ8aX/exec";

app.use(express.static(path.join(__dirname, 'public')));

// The dashboard calls this same-origin endpoint. This server fetches
// the Apps Script URL itself (server-to-server, no CORS restriction)
// and hands the JSON back to the browser.
app.get('/api/data', async (req, res) => {
  try {
    const upstream = await fetch(WEB_APP_URL, { redirect: 'follow' });
    if (!upstream.ok) {
      throw new Error(`Upstream responded with ${upstream.status}`);
    }
    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      // Usually means Apps Script returned a Google sign-in/consent page
      // instead of JSON — the deployment access setting isn't public.
      throw new Error('Upstream did not return JSON (deployment may not be public)');
    }
    const data = await upstream.json();
    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    console.error('Failed to fetch AD TEAM DATA:', err);
    res.status(502).json({
      error: 'Failed to fetch data from Apps Script',
      detail: String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Merchant Pulse server running on port ${PORT}`);
});
