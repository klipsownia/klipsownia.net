require('dotenv').config();
const cheerio = require('cheerio');
const slugify = require('slugify');
const { execute, getConnection } = require('../db/pool');
const pool = { execute, getConnection };
const logger    = require('../config/logger');

const DELAY_MS    = parseInt(process.env.SCRAPE_DELAY_MS)    || 3000;
const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY) || 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeSlug(text) {
  if (!text) return '';
  return slugify(text.trim(), { lower: true, strict: true });
}

function cleanUrl(href, baseUrl) {
  try {
    if (!href || href === '#' || href.startsWith('javascript')) return null;
    if (href.startsWith('http')) return href;
    return new URL(href, baseUrl).href;
  } catch { return null; }
}

function extractRating(text) {
  if (!text) return null;
  const m = text.match(/[\d.]+/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  if (n > 10) return Math.min(5, +(n / 20).toFixed(2));
  if (n > 5)  return Math.min(5, +(n / 2).toFixed(2));
  return Math.min(5, n);
}

function guessType(card) {
  const text = card.toLowerCase();
  if (text.includes('premium') || text.includes('paid')) return 'premium';
  if (text.includes('free') || text.includes('darmow'))  return 'free';
  return 'freemium';
}

// Natywny fetch (Node 18+) z retry
async function fetchHtml(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt < 3) {
      logger.warn(`  Retry ${attempt}/3 dla ${url}: ${err.message}`);
      await sleep(2000 * attempt);
      return fetchHtml(url, attempt + 1);
    }
    throw err;
  }
}

function parseSites(html, target) {
  const $ = cheerio.load(html);
  const sites = [];
  const baseUrl = (() => { try { return new URL(target.url).origin; } catch { return ''; } })();

  const selName     = target.selector_name     || 'h3, h2, h4, .title, .name, .site-name';
  const selLink     = target.selector_link     || 'a[href]';
  const selDesc     = target.selector_desc     || 'p, .desc, .description, .excerpt';
  const selThumb    = target.selector_thumb    || 'img';
  const selRating   = target.selector_rating   || '.rating, .score, .stars';
  const selCategory = target.selector_category || '.category, .cat, .tag';

  const cardCandidates = [
    '.site-card', '.site-item', '.site', '.card', '.item',
    '.listing-item', '.result', 'article',
    '[class*="site-"]', '[class*="card"]', '[class*="item"]',
    'li.site', 'div.site', '.entry',
  ];

  let cards = $();
  for (const sel of cardCandidates) {
    const found = $(sel);
    if (found.length >= 3) {
      cards = found;
      logger.info(`  Auto-detekcja: "${sel}" → ${found.length} kart`);
      break;
    }
  }

  if (cards.length === 0) {
    logger.warn(`  Brak kart – fallback na linki zewnętrzne`);
    $(selLink).each((_, el) => {
      const href = $(el).attr('href');
      const url  = cleanUrl(href, baseUrl);
      const name = ($(el).text() || $(el).attr('title') || '').trim();
      if (!url || !name || name.length < 3 || name.length > 80) return;
      if (url.startsWith(baseUrl)) return;
      sites.push({ name, url, description: '', thumbnail: null, rating: null, category: '', tags: [], site_type: 'free' });
    });
    return sites;
  }

  cards.each((_, card) => {
    const $c = $(card);
    const cardText = $c.text();
    const name = ($c.find(selName).first().text() || $c.find('a').first().text() || '').trim();
    const rawLink = $c.find(selLink).first().attr('href') || $c.find('a').first().attr('href') || '';
    const url = cleanUrl(rawLink, baseUrl);
    if (!name || name.length < 2 || !url) return;
    const description = ($c.find(selDesc).first().text() || '').trim().slice(0, 500);
    const thumbEl = $c.find(selThumb).first();
    const thumbnail = thumbEl.attr('src') || thumbEl.attr('data-src') || thumbEl.attr('data-lazy') || null;
    const rating = extractRating($c.find(selRating).first().text().trim());
    const category = ($c.find(selCategory).first().text() || '').trim().slice(0, 100);
    const site_type = guessType(cardText);
    const tags = [];
    $c.find('.tag, .label, .badge, [class*="tag"]').each((_, el) => {
      const t = $(el).text().trim().toLowerCase();
      if (t && t.length > 1 && t.length < 30 && !tags.includes(t)) tags.push(t);
    });
    sites.push({ name, url, description, thumbnail, rating, category, tags, site_type });
  });

  logger.info(`  Sparsowano ${sites.length} serwisów`);
  return sites;
}

async function saveSite(conn, site, sourceUrl) {
  const slug = makeSlug(site.name);
  if (!slug) return 'skip';

  let categoryId = null;
  if (site.category) {
    const catSlug = makeSlug(site.category);
    await conn.execute('INSERT INTO categories (name, slug) VALUES (?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [site.category, catSlug]);
    const [rows] = await conn.execute('SELECT id FROM categories WHERE slug=?', [catSlug]);
    categoryId = rows[0]?.id || null;
  }

  const [result] = await conn.execute(`
    INSERT INTO sites (name, slug, description, url, thumbnail, category_id, rating, site_type, source_url, scraped_at)
    VALUES (?,?,?,?,?,?,?,?,?,NOW())
    ON DUPLICATE KEY UPDATE
      name=VALUES(name),
      description=IF(VALUES(description)!='',VALUES(description),description),
      thumbnail=COALESCE(VALUES(thumbnail),thumbnail),
      category_id=COALESCE(VALUES(category_id),category_id),
      rating=COALESCE(VALUES(rating),rating),
      site_type=VALUES(site_type),
      scraped_at=NOW(), updated_at=NOW()
  `, [site.name, slug, site.description||null, site.url, site.thumbnail||null, categoryId, site.rating||null, site.site_type||'free', sourceUrl]);

  const isNew  = result.affectedRows === 1;
  let realId   = result.insertId;

  if (!realId && site.tags?.length) {
    const [r] = await conn.execute('SELECT id FROM sites WHERE url=?', [site.url]);
    realId = r[0]?.id;
  }

  if (realId && site.tags?.length) {
    for (const tagName of site.tags) {
      const tagSlug = makeSlug(tagName);
      if (!tagSlug) continue;
      await conn.execute('INSERT INTO tags (name, slug) VALUES (?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [tagName, tagSlug]);
      const [tagRows] = await conn.execute('SELECT id FROM tags WHERE slug=?', [tagSlug]);
      const tagId = tagRows[0]?.id;
      if (tagId) await conn.execute('INSERT IGNORE INTO site_tags (site_id, tag_id) VALUES (?,?)', [realId, tagId]);
    }
  }

  return isNew ? 'added' : 'updated';
}

async function scrapeTarget(target) {
  const started = Date.now();
  const [logResult] = await pool.execute(
    'INSERT INTO scrape_logs (target_id, target_url, status) VALUES (?,?,?)',
    [target.id, target.url, 'running']
  );
  const logId = logResult.insertId;
  let sitesFound = 0, sitesAdded = 0, sitesUpdated = 0;

  try {
    logger.info(`🕷  Scrapuję: ${target.url}`);
    const html  = await fetchHtml(target.url);
    const sites = parseSites(html, target);
    sitesFound  = sites.length;

    const conn = await pool.getConnection();
    try {
      for (const site of sites) {
        try {
          const action = await saveSite(conn, site, target.url);
          if (action === 'added')   sitesAdded++;
          if (action === 'updated') sitesUpdated++;
        } catch (e) { logger.warn(`  Błąd zapisu "${site.name}": ${e.message}`); }
        await sleep(50);
      }
    } finally { conn.release(); }

    await pool.execute('UPDATE scrape_targets SET last_scraped=NOW(), scrape_count=scrape_count+1 WHERE id=?', [target.id]);
    const ms = Date.now() - started;
    await pool.execute(`UPDATE scrape_logs SET status='success',sites_found=?,sites_added=?,sites_updated=?,duration_ms=?,finished_at=NOW() WHERE id=?`,
      [sitesFound, sitesAdded, sitesUpdated, ms, logId]);
    logger.info(`✅ ${target.name||target.url}: +${sitesAdded} nowych, ~${sitesUpdated} zaktualizowanych`);
  } catch (err) {
    const ms = Date.now() - started;
    await pool.execute(`UPDATE scrape_logs SET status='error',error_msg=?,duration_ms=?,finished_at=NOW() WHERE id=?`, [err.message, ms, logId]);
    logger.error(`❌ ${target.url}: ${err.message}`);
  }
}

async function runAllTargets() {
  logger.info('🚀 Start cyklu scrapowania...');
  const t0 = Date.now();
  const [targets] = await pool.execute('SELECT * FROM scrape_targets WHERE is_active=1 ORDER BY id');
  if (!targets.length) { logger.warn('Brak aktywnych targetów'); return; }
  logger.info(`Targetów: ${targets.length}`);
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(t => scrapeTarget(t)));
    if (i + CONCURRENCY < targets.length) await sleep(DELAY_MS);
  }
  logger.info(`🏁 Gotowe! Czas: ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

module.exports = { runAllTargets, scrapeTarget };
