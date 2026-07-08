require('dotenv').config();
const { runAllTargets } = require('./engine');
const { pool } = require('../db/pool');
const logger = require('../config/logger');
(async () => {
  try {
    await runAllTargets();
    await pool.end();
    process.exit(0);
  } catch (e) {
    logger.error(e.message);
    await pool.end();
    process.exit(1);
  }
})();
