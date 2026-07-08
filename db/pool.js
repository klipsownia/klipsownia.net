require('dotenv').config();
const mysql = require('mysql');

const pool = mysql.createPool({
  host:              process.env.DB_HOST     || 'localhost',
  port:              parseInt(process.env.DB_PORT) || 3306,
  database:          process.env.DB_NAME,
  user:              process.env.DB_USER,
  password:          process.env.DB_PASS,
  connectionLimit:   5,
  connectTimeout:    10000,
  acquireTimeout:    10000,
  charset:           'utf8mb4',
});

// Zamień pool.execute na promise-based
function query(sql, params) {
  return new Promise((resolve, reject) => {
    pool.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve([results]);
    });
  });
}

function getConnection() {
  return new Promise((resolve, reject) => {
    pool.getConnection((err, conn) => {
      if (err) { reject(err); return; }
      // Dodaj execute jako alias query na połączeniu
      conn.execute = (sql, params) =>
        new Promise((res, rej) =>
          conn.query(sql, params, (e, r) => e ? rej(e) : res([r]))
        );
      resolve(conn);
    });
  });
}

async function testConnection() {
  try {
    await query('SELECT 1');
    console.log('✅ Połączono z MySQL na LH.pl');
  } catch (err) {
    console.error('❌ Błąd połączenia z MySQL:', err.message);
    process.exit(1);
  }
}

function end() {
  return new Promise(resolve => pool.end(resolve));
}

module.exports = { pool, query, execute: query, getConnection, testConnection, end };
