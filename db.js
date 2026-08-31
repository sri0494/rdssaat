// db.js — PostgreSQL connection (flat structure)
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL not set!');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.connect((err, client, release) => {
  if (err) { console.error('❌ DB connection failed:', err.message); process.exit(1); }
  client.query('SELECT NOW()', (err2, result) => {
    release();
    if (err2) { console.error('❌ DB query failed:', err2.message); return; }
    console.log('✅ PostgreSQL connected:', result.rows[0].now);
  });
});

module.exports = {
  query:   (text, params) => pool.query(text, params),
  getPool: () => pool,
};
