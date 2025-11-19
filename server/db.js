// server/db.js
const { MongoClient } = require('mongodb');

let client = null;
let db = null;

/**
 * Connects to MongoDB and initializes indexes.
 * - Uses MONGODB_URI from env.
 * - Optionally uses MONGODB_DBNAME (else DB from URI or "test").
 */
async function connectDB() {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('MONGODB_URI not set — running without DB persistence.');
    return null;
  }

  try {
    // NOTE: do NOT pass legacy options like useNewUrlParser/useUnifiedTopology
    client = new MongoClient(uri);
    await client.connect();

    // allow explicit DB name via env, otherwise use name from URI (or default)
    const dbName = process.env.MONGODB_DBNAME || client.db().databaseName || 'test';
    db = client.db(dbName);

    // Ensure useful indexes: unique on service, optional TTL on expires_at
    await db.collection('tokens').createIndex({ service: 1 }, { unique: true });
    // If you want tokens to auto-expire based on expires_at, uncomment:
    // await db.collection('tokens').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

    console.log('MongoDB connected to DB:', db.databaseName);
    return db;
  } catch (err) {
    console.error('MongoDB connect error:', err);
    try { await client?.close(); } catch (e) { /* ignore */ }
    client = null;
    db = null;
    throw err;
  }
}

function getDB() {
  if (!db) throw new Error('DB not connected. Call connectDB() first.');
  return db;
}

async function saveToken(service, access_token, refresh_token = null, expires_in = null) {
  if (!db) return null;
  const doc = {
    service,
    access_token,
    refresh_token,
    expires_at: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
    updated_at: new Date()
  };
  await db.collection('tokens').updateOne(
    { service },
    { $set: doc },
    { upsert: true }
  );
  return doc;
}

async function getToken(service) {
  if (!db) return null;
  const doc = await db.collection('tokens').findOne({ service });
  return doc?.access_token || null;
}

async function closeDB() {
  if (!client) return;
  try {
    await client.close();
  } finally {
    client = null;
    db = null;
  }
}

module.exports = { connectDB, getDB, saveToken, getToken, closeDB };
