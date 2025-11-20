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

let mondayAccessToken = '';   // always fill this from DB or OAuth

/**
 * Build your public URL; works in Render.
 */
function getPublicUrl(req) {
  const envUrl = process.env.MONDAY_PUBLIC_URL || process.env.PUBLIC_URL || process.env.NGROK_URL;
  if (envUrl && envUrl.startsWith('http')) return envUrl.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

app.get('/', (req, res) => {
  res.send('monday-cliq-app backend is running');
});

/*******************************
 * OAuth Step A - redirect user
 *******************************/
app.get('/monday/oauth', (req, res) => {
  if (!CLIENT_ID) return res.send('MONDAY_CLIENT_ID missing in .env or Render env.');
  const redirect = encodeURIComponent(REDIRECT_URL);
  const authUrl = `https://auth.monday.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${redirect}`;
  console.log("Redirecting to:", authUrl);
  res.redirect(authUrl);
});

/***********************************************
 * OAuth Step B - callback receives ?code=
 ***********************************************/
app.get('/monday/oauth/callback', async (req, res) => {
  const code = req.query.code;
  console.log("OAuth callback called. Code =", code);

  if (!code) return res.status(400).send("No 'code' received.");

  try {
    const resp = await axios.post(
      'https://auth.monday.com/oauth2/token',
      {
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URL,
        grant_type: 'authorization_code'
      }
    );

    const access = resp.data?.access_token;
    if (!access) {
      console.error("Missing access_token:", resp.data);
      return res.status(500).send("Token exchange failed.");
    }

    console.log("OAuth token obtained.");

    mondayAccessToken = access;
    mondayLib.setToken(access);
    process.env.MONDAY_ACCESS_TOKEN = access;

    // Save to DB
    try {
      await saveToken('monday', access, resp.data.refresh_token || null, resp.data.expires_in || null);
      console.log("Saved monday token to DB.");
    } catch (e) {
      console.error("Failed saving token to DB:", e.message);
    }

    res.send("OAuth complete. You can now call /monday/create-webhook?board=<BOARD_ID>");
  } catch (err) {
    console.error("OAuth token exchange error:", err.response?.data || err.message);
    res.status(500).send("OAuth exchange failed.");
  }
});

/***********************************************
 * CREATE WEBHOOK (Step C)
 ***********************************************/
app.get('/monday/create-webhook', async (req, res) => {
  const boardId = parseInt(req.query.board, 10);
  if (!boardId) return res.status(400).send("Missing or invalid board ID.");

  // Ensure token present (memory -> env -> DB)
  let token = mondayAccessToken || process.env.MONDAY_ACCESS_TOKEN;
  if (!token) {
    try {
      token = await getToken('monday');
      if (token) {
        mondayAccessToken = token;
        mondayLib.setToken(token);
        process.env.MONDAY_ACCESS_TOKEN = token;
      }
    } catch (e) {
      console.error("Failed to read token from DB:", e.message);
    }
  }

  if (!token) {
    return res.status(400).send("No monday token available. Run /monday/oauth first.");
  }

  const publicUrl = getPublicUrl(req);
  const webhookUrl = `${publicUrl}/webhook/monday`;

  console.log("Creating webhook for board:", boardId, "URL:", webhookUrl);

  // Safer GraphQL query using variables
  const query = `
    mutation CreateWebhook($boardId: Int!, $url: String!) {
      create_webhook(board_id: $boardId, url: $url, event: change_column_value) {
        id
      }
    }
  `;

  try {
    const resp = await axios.post(
      "https://api.monday.com/v2",
      {
        query,
        variables: {
          boardId,
          url: webhookUrl
        }
      },
      {
        headers: {
          Authorization: token,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("create_webhook response:", JSON.stringify(resp.data, null, 2));
    return res.json(resp.data);
  } catch (err) {
    console.error("Webhook creation FAILED:", {
      status: err.response?.status,
      data: err.response?.data,
    });
    return res.status(500).send("Webhook creation failed. Check Render logs.");
  }
});

/***********************************************
 * Monday webhook receiver
 ***********************************************/
app.post('/webhook/monday', (req, res) => {
  console.log("Received Monday webhook:", JSON.stringify(req.body, null, 2));
  res.status(200).send("ok");
});

/***********************************************
 * Simple Cliq action endpoint
 ***********************************************/
app.post('/cliq/action', (req, res) => {
  console.log("Received Cliq action:", JSON.stringify(req.body, null, 2));
  res.json({ text: "Action received!" });
});

/***********************************************
 * START SERVER (with token loading!)
 ***********************************************/
async function start() {
  try {
    const db = await connectDB();
    console.log("MongoDB connected.");

    // Load token from DB on startup
    const saved = await getToken('monday');
    if (saved) {
      console.log("Loaded saved monday token:", saved.substring(0, 10) + "...");
      mondayAccessToken = saved;
      mondayLib.setToken(saved);
      process.env.MONDAY_ACCESS_TOKEN = saved;
    } else {
      console.log("No saved monday token found at startup.");
    }

    app.listen(PORT, () =>
      console.log(`Server live at http://localhost:${PORT} (PORT=${PORT})`)
    );
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
}

start();
