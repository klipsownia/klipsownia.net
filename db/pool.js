require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT) || 3306,
  database:           process.env.DB_NAME,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  waitForConnections: true,
  connectionLimit:    5,
  queueLimit:         0,
  connectTimeout:     10000,
  enableKeepAlive:    true,
  keepAliveInitialDelay: 0,
});

async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ Połączono z MySQL na LH.pl');
    conn.release();
  } catch (err) {
    console.error('❌ Błąd połączenia z MySQL:', err.message);
    process.exit(1);
  }
}

module.exports = { pool, testConnection };
