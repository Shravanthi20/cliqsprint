// server/delete-test-token.js
require('dotenv').config();
const { connectDB } = require('./db');

async function run() {
  const db = await connectDB();
  const res = await db.collection('tokens').deleteOne({ access_token: 'TEST_TOKEN_DEBUG' });
  console.log('deleted count:', res.deletedCount);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
