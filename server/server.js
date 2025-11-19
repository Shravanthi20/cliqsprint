// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mondayLib = require('./lib/monday');
const { connectDB, saveToken, getToken } = require('./db');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.MONDAY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.MONDAY_CLIENT_SECRET || '';
const REDIRECT_URL = process.env.MONDAY_REDIRECT_URL || `http://localhost:${PORT}/monday/oauth/callback`;

// runtime storage (demo only)
let mondayAccessToken = process.env.MONDAY_ACCESS_TOKEN || '';

/**
 * Helper: build public URL for webhook/redirect.
 * If MONDAY_PUBLIC_URL / PUBLIC_URL / NGROK_URL is set in .env it uses that; otherwise builds from request Host.
 */
function getPublicUrl(req) {
  const publicEnv = process.env.MONDAY_PUBLIC_URL || process.env.PUBLIC_URL || process.env.NGROK_URL;
  if (publicEnv && publicEnv.startsWith('http')) return publicEnv.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

app.get('/', (req, res) => {
  res.send('monday-cliq-app backend is running');
});

//
// Step A: Start OAuth flow - redirects user to monday's consent page
//
app.get('/monday/oauth', (req, res) => {
  if (!CLIENT_ID) {
    return res.send('MONDAY_CLIENT_ID is not configured in .env. Add it and restart the server.');
  }
  const redirect = encodeURIComponent(REDIRECT_URL);
  const authUrl = `https://auth.monday.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${redirect}`;
  res.redirect(authUrl);
});

//
// Step B: OAuth callback - exchange code for access token
//
app.get('/monday/oauth/callback', async (req, res) => {
  const code = req.query.code;
  console.log('/monday/oauth/callback called, code=', code);
  if (!code) {
    return res.status(400).send('No code query parameter present.');
  }

  try {
    const resp = await axios.post('https://auth.monday.com/oauth2/token', {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URL,
      grant_type: 'authorization_code'
    });

    if (!resp.data || !resp.data.access_token) {
      console.error('No access_token in response:', resp.data);
      return res.status(500).send('Token exchange did not return access_token. Check server logs.');
    }

    mondayAccessToken = resp.data.access_token;

    // set runtime token in monday lib so future queries use it
    try { mondayLib.setToken(mondayAccessToken); } catch (e) { console.warn('mondayLib.setToken failed:', e.message); }

    // For demo only: store in process.env so same process can use it
    process.env.MONDAY_ACCESS_TOKEN = mondayAccessToken;

    // Persist the token to DB (if configured). Save access_token + refresh + expiry if present.
    try {
      await saveToken('monday', resp.data.access_token, resp.data.refresh_token || null, resp.data.expires_in || null);
      console.log('Saved monday token to DB (if DB configured).');
    } catch (dbErr) {
      console.warn('Failed to save token to DB:', dbErr.message);
    }

    console.log('OAuth success. Access token obtained and set in memory.');
    res.send('OAuth complete. Server has the monday access token. You can now call /monday/create-webhook?board=<BOARD_ID>');
  } catch (err) {
    console.error('Error exchanging OAuth code for token:', err.response?.data || err.message);
    res.status(500).send('OAuth token exchange failed. See server logs.');
  }
});

//
// Step C: Create a board webhook using the OAuth token
// Example: GET /monday/create-webhook?board=123456789
//
app.get('/monday/create-webhook', async (req, res) => {
  const boardId = req.query.board;
  if (!boardId) return res.status(400).send('Missing ?board=<BOARD_ID> query param.');

  // ensure we have a token (check in-memory -> env -> DB)
  let token = mondayAccessToken || process.env.MONDAY_ACCESS_TOKEN;
  if (!token) {
    try {
      token = await getToken('monday');
      if (token) {
        mondayAccessToken = token;
        try { mondayLib.setToken(token); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      console.warn('Could not read token from DB:', e.message);
    }
  }
  if (!token) return res.status(400).send('No monday OAuth token available. Please run /monday/oauth first.');

  // compute public webhook URL (use MONDAY_PUBLIC_URL/NGROK_URL if provided)
  const publicUrl = getPublicUrl(req);
  const webhookUrl = `${publicUrl.replace(/\/$/, '')}/webhook/monday`;

  const mutation = `
    mutation {
      create_webhook (
        board_id: ${boardId},
        url: "${webhookUrl}",
        event: change_column_value
      ) {
        id
      }
    }
  `;

  try {
    const graphqlResp = await axios.post(
      'https://api.monday.com/v2',
      { query: mutation },
      { headers: { Authorization: token, 'Content-Type': 'application/json' } }
    );

    console.log('create_webhook response:', JSON.stringify(graphqlResp.data, null, 2));
    return res.json(graphqlResp.data);
  } catch (err) {
    console.error('Error creating webhook:', err.response?.data || err.message);
    return res.status(500).send('Failed to create webhook. See server logs.');
  }
});

//
// Webhook receiver endpoint (monday will POST here)
//
app.post('/webhook/monday', (req, res) => {
  console.log('Received monday webhook payload:\n', JSON.stringify(req.body, null, 2));
  // quick 200 to monday
  res.status(200).send('ok');
});

//
// Simple Cliq action endpoint (Cliq will POST here on button click)
//
app.post('/cliq/action', (req, res) => {
  console.log('Received Cliq action payload:\n', JSON.stringify(req.body, null, 2));
  // Respond with a simple acknowledgement - Cliq expects JSON
  res.json({ text: 'Action received by backend (logged).' });
});

// start server after attempting DB connect
async function start() {
  try {
    await connectDB(); // will warn if MONGODB_URI not set
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}  (PORT=${PORT})`));
  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
}
start();
