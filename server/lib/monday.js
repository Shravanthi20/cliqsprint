// lib/monday.js
// Node.js 20+ already supports global fetch (no need for node-fetch)
const MONDAY_URL = 'https://api.monday.com/v2';

let oauthToken = process.env.MONDAY_ACCESS_TOKEN || '';

function setToken(token) {
  oauthToken = token;
}

async function runQuery(query, variables = {}) {
  if (!oauthToken) throw new Error('Missing monday OAuth token. Call setToken(token) first.');
  
  const r = await fetch(MONDAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': oauthToken
    },
    body: JSON.stringify({ query, variables })
  });
  
  const j = await r.json();
  if (j.errors) {
    throw new Error('Monday API error: ' + JSON.stringify(j.errors));
  }
  return j;
}

async function fetchItem(itemId) {
  const q = `query ($itemId: [Int]) {
    items (ids: $itemId) {
      id name column_values { id text }
      board { id name }
      url
    }
  }`;
  
  const res = await runQuery(q, { itemId: parseInt(itemId) });
  const item = res.data?.items?.[0] || {};
  const statusCol = item.column_values?.find(c => c.id === 'status') || {};
  
  return {
    id: item.id,
    name: item.name,
    status_text: statusCol.text || 'Unknown',
    url: item.url,
    raw: item
  };
}

async function assignItem(itemId, mondayUserId) {
  throw new Error('assignItem not implemented. Replace with board-specific mutation.');
}

async function createSubtask(parentItemId, title) {
  throw new Error('createSubtask not implemented.');
}

module.exports = { setToken, runQuery, fetchItem, assignItem, createSubtask };
