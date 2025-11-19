// server/db.js
const { MongoClient } = require('mongodb');

let client;
let db;

async function connectDB() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('MONGODB_URI not set — running without DB persistence.');
    return null;
  }
  client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  await client.connect();
  // if you want a specific DB name inside the URI, client.db() will pick it up
  db = client.db();
  console.log('MongoDB connected');
  return db;
}

function getDB() {
  if (!db) throw new Error('DB not connected. Call connectDB() first.');
  return db;
}

async function saveToken(service, access_token, refresh_token = null, expires_in = null) {
  if (!db) return null; // no DB configured
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

module.exports = { connectDB, getDB, saveToken, getToken, closeDB: () => client?.close() };
