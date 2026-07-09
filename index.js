// index.js – Railway: mini serwer HTTP + cron scheduler
require('dotenv').config();
const { pool, testConnection, execute } = require('./db/pool');
const http     = require('http');
const cron     = require('node-cron');
const { runAllTargets }        = require('./scraper/engine');
const logger                   = require('./config/logger');

const PORT            = process.env.PORT || 3000;
const CRON_SCHEDULE   = process.env.CRON_SCHEDULE   || '0 */6 * * *';
const TRIGGER_SECRET  = process.env.TRIGGER_SECRET  || '';

let isRunning = false;

// ─── Mini HTTP server (Railway wymaga otwartego portu) ──
// Daje też endpoint /health i /trigger
const server = http.createServer(async (req, res) => {
  const url = req.url;

  // Health check – Railway pinguje żeby wiedzieć że żyje
  if (url === '/health' || url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:    'ok',
      service:   'klipsownia-scraper',
      running:   isRunning,
      schedule:  CRON_SCHEDULE,
      time:      new Date().toISOString(),
    }));
    return;
  }

  // Manual trigger – wywołaj scraper z zewnątrz
  // POST /trigger?secret=TWOJ_KLUCZ
  if (url.startsWith('/trigger') && req.method === 'POST') {
    const secret = new URL(url, 'http://localhost').searchParams.get('secret');
    if (TRIGGER_SECRET && secret !== TRIGGER_SECRET) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Nieautoryzowany' }));
      return;
    }
    if (isRunning) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: 'Scraper już działa' }));
      return;
    }
    res.writeHead(202);
    res.end(JSON.stringify({ message: 'Scraper uruchomiony' }));
    // Uruchom asynchronicznie
    isRunning = true;
    runAllTargets()
      .catch(e => logger.error('Trigger error:', e.message))
      .finally(() => { isRunning = false; });
    return;
  }

  // Stats – ostatnie logi scrapowania
  if (url === '/stats') {
    try {
      const [logs] = await execute(`
        SELECT l.*, t.name AS target_name
        FROM scrape_logs l
        LEFT JOIN scrape_targets t ON t.id = l.target_id
        ORDER BY l.started_at DESC LIMIT 20
      `);
      const [counts] = await execute(`
        SELECT
          (SELECT COUNT(*) FROM sites WHERE is_active=1) AS sites,
          (SELECT COUNT(*) FROM scrape_targets WHERE is_active=1) AS targets
      `);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ counts: counts[0], logs }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── Start ─────────────────────────────────────────────
(async () => {
  await testConnection();

  server.listen(PORT, () => {
    logger.info(`🌐 HTTP server: http://localhost:${PORT}`);
    logger.info(`   GET  /health  – status`);
    logger.info(`   GET  /stats   – ostatnie logi`);
    logger.info(`   POST /trigger?secret=XXX – ręczny start`);
  });

  // ─── Cron ────────────────────────────────────────────
  if (!cron.validate(CRON_SCHEDULE)) {
    logger.error(`❌ Nieprawidłowy CRON_SCHEDULE: "${CRON_SCHEDULE}"`);
    process.exit(1);
  }

  logger.info(`⏰ Cron: "${CRON_SCHEDULE}"`);

  cron.schedule(CRON_SCHEDULE, async () => {
    if (isRunning) {
      logger.warn('Cron pominięty – poprzedni cykl nadal działa');
      return;
    }
    logger.info('⏰ Cron wyzwolony');
    isRunning = true;
    try {
      await runAllTargets();
    } catch (e) {
      logger.error('Błąd crona:', e.message);
    } finally {
      isRunning = false;
    }
  });

  // Pierwsze uruchomienie po starcie (opcjonalne)
  const runOnStart = process.env.RUN_ON_START === 'true';
  if (runOnStart) {
    logger.info('🔁 RUN_ON_START – uruchamiam scraper...');
    isRunning = true;
    runAllTargets()
      .catch(e => logger.error(e.message))
      .finally(() => { isRunning = false; });
  }

})();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM – zamykam...');
  await pool.end();
  process.exit(0);
});
