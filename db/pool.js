const { Pool } = require('pg');

// A DATABASE_URL vem do Render (ou do seu .env local)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

module.exports = pool;
