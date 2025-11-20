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

let mondayAccessToken = ''; // runtime token

/**
 * Build public URL for webhooks on Render
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

/**********************************************
 * Step A — OAuth Start
 **********************************************/
app.get('/monday/oauth', (req, res) => {
  if (!CLIENT_ID) return res.send('MONDAY_CLIENT_ID missing.');
  const redirect = encodeURIComponent(REDIRECT_URL);
  const authUrl = `https://auth.monday.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${redirect}`;
  console.log("Redirecting to:", authUrl);
  res.redirect(authUrl);
});

/**********************************************
 * Step B — OAuth Callback
 **********************************************/
app.get('/monday/oauth/callback', async (req, res) => {
  const code = req.query.code;
  console.log("OAuth callback. Code =", code);

  if (!code) return res.status(400).send("No ?code provided.");

  try {
    const resp = await axios.post('https://auth.monday.com/oauth2/token', {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URL,
      grant_type: 'authorization_code'
    });

    const access = resp.data?.access_token;
    if (!access) {
      console.error("Missing access_token:", resp.data);
      return res.status(500).send("OAuth exchange failed.");
    }

    console.log("OAuth token obtained.");

    mondayAccessToken = access;
    mondayLib.setToken(access);
    process.env.MONDAY_ACCESS_TOKEN = access;

    // Persist token
    try {
      await saveToken(
        'monday',
        access,
        resp.data.refresh_token || null,
        resp.data.expires_in || null
      );
      console.log("Saved monday token to DB.");
    } catch (err2) {
      console.error("DB save failed:", err2.message);
    }

    res.send("OAuth complete. Now run /monday/create-webhook?board=<BOARD_ID>");
  } catch (err) {
    console.error("OAuth error:", err.response?.data || err.message);
    res.status(500).send("OAuth failed.");
  }
});

/**********************************************
 * Step C — Create Monday Webhook
 **********************************************/
app.get('/monday/create-webhook', async (req, res) => {
  const boardIdRaw = req.query.board;
  if (!boardIdRaw) return res.status(400).send("Missing ?board=<BOARD_ID>");

  const boardId = String(boardIdRaw); // monday expects ID! type

  // Ensure token exists (memory → env → DB)
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
      console.error("DB read token failed:", e.message);
    }
  }
  if (!token) return res.status(400).send("No monday token. Run /monday/oauth.");

  const publicUrl = getPublicUrl(req);
  const webhookUrl = `${publicUrl}/webhook/monday`;

  console.log("Creating webhook for board:", boardId, "URL:", webhookUrl);

  const mutation = `
    mutation CreateWebhook($boardId: ID!, $url: String!) {
      create_webhook(board_id: $boardId, url: $url, event: change_column_value) {
        id
      }
    }
  `;

  try {
    const graphqlResp = await axios.post(
      "https://api.monday.com/v2",
      {
        query: mutation,
        variables: { boardId, url: webhookUrl }
      },
      {
        headers: {
          Authorization: token,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("create_webhook response:", JSON.stringify(graphqlResp.data, null, 2));
    return res.json(graphqlResp.data);

  } catch (err) {
    console.error("Webhook creation FAILED:", {
      status: err.response?.status,
      data: err.response?.data,
    });
    return res.status(500).send("Webhook creation failed. See logs.");
  }
});

/**********************************************
 * Monday Webhook Receiver
 * MUST handle "challenge" for webhook creation!
 **********************************************/
app.post('/webhook/monday', (req, res) => {
  console.log("Received Monday webhook:", JSON.stringify(req.body, null, 2));

  // REQUIRED: echo challenge back
  if (req.body && req.body.challenge) {
    return res.json({ challenge: req.body.challenge });
  }

  // Normal event
  res.status(200).send("ok");
});

app.get('/webhook/test', async (req, res) => {
  try {
    await axios.post(process.env.CLIQ_BOT_INCOMING, {
      text: "🚀 Test message from Render backend → Zoho Cliq is working!"
    });
    res.send("Test sent to Cliq!");
  } catch (e) {
    res.send("Failed to send: " + e.message);
  }
});


/**********************************************
 * Cliq Action Endpoint
 **********************************************/
app.post('/cliq/action', (req, res) => {
  console.log("Received Cliq action:", JSON.stringify(req.body, null, 2));
  res.json({ text: "Action received!" });
});

/**********************************************
 * Start Server — load token from DB
 **********************************************/
async function start() {
  try {
    await connectDB();
    console.log("MongoDB connected.");

    // Load saved token
    const saved = await getToken('monday');
    if (saved) {
      console.log("Loaded monday token:", saved.substring(0, 10) + "...");
      mondayAccessToken = saved;
      mondayLib.setToken(saved);
      process.env.MONDAY_ACCESS_TOKEN = saved;
    } else {
      console.log("No saved monday token found.");
    }

    app.listen(PORT, () =>
      console.log(`Server running at http://localhost:${PORT} (PORT=${PORT})`)
    );
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
}

start();
