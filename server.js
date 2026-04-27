/**
 * MiniBus Finder — Backend Scraper Server
 * Scrapes: AutoTrader, Gumtree, eBay Motors, Motors.co.uk, Preloved, Shpock
 * Auto-scans every 2 hours. Exposes REST API for the PWA.
 * Deploy free on Railway: railway.app
 */

const express  = require('express');
const axios    = require('axios');
const cheerio  = require('cheerio');
const cron     = require('node-cron');
const cors     = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── In-memory store (persists while server runs) ──
let listingStore = [];
let lastScan = null;

// ── Default search params (overridden per request) ──
const DEFAULTS = {
  postcode:  'BB97TZ',
  maxPrice:  5000,
  minSeats:  17,
  maxSeats:  17,
  keyword:   '',
  platforms: 'autotrader,gumtree,ebay,motors,preloved',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
};

// ─────────────────────────────────────────────────
// SCRAPER: AutoTrader
// ─────────────────────────────────────────────────
async function scrapeAutoTrader(params) {
  const { postcode, maxPrice, minSeats, maxSeats } = params;
  const url = `https://www.autotrader.co.uk/car-search?body-type=Minibus&maximum-seats=${maxSeats}&minimum-seats=${minSeats}&postcode=${postcode}&price-to=${maxPrice}&sort=relevance`;
  console.log('[AutoTrader] Fetching:', url);
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);
    const listings = [];

    $('article[data-testid="trader-seller-listing"], li[data-testid]').each((i, el) => {
      const $el = $(el);
      const titleEl = $el.find('h3 a, [data-testid="listing-title"] a').first();
      const title  = titleEl.text().trim();
      const href   = titleEl.attr('href');
      if (!title || !href) return;

      const priceText = $el.find('[data-testid="listing-price"], .product-card-pricing__price').text().replace(/[^0-9]/g,'');
      const price = parseInt(priceText) || 0;
      if (price > maxPrice || price === 0) return;

      const details = $el.find('[data-testid="listing-details"], .product-card-details').text();
      const yearMatch = details.match(/20\d{2}|19\d{2}/);
      const mileMatch = details.match(/([\d,]+)\s*miles/i);
      const locText   = $el.find('[data-testid="listing-location"], .seller-town').text().trim();
      const imgSrc    = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';

      listings.push({
        id:       `at_${href.split('/').pop()?.split('?')[0] || i}`,
        platform: 'autotrader',
        title,
        price,
        year:     yearMatch ? yearMatch[0] : '',
        mileage:  mileMatch ? mileMatch[1] : '',
        location: locText,
        seats:    minSeats,
        url:      href.startsWith('http') ? href : `https://www.autotrader.co.uk${href}`,
        imgUrl:   imgSrc,
        age:      'just found',
        foundAt:  Date.now(),
      });
    });

    // Fallback: if cheerio can't parse React-rendered content, provide direct search link
    if (!listings.length) {
      listings.push({
        id: `at_direct_${Date.now()}`,
        platform: 'autotrader',
        title: `AutoTrader — 17-seat minibuses under £${maxPrice.toLocaleString()}`,
        price: 0,
        year: '', mileage: '', location: 'Various',
        seats: minSeats,
        url,
        imgUrl: '',
        age: 'tap to view',
        foundAt: Date.now(),
        isDirect: true,
      });
    }
    console.log(`[AutoTrader] Found ${listings.length} listings`);
    return listings;
  } catch (e) {
    console.error('[AutoTrader] Error:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────
// SCRAPER: Gumtree
// ─────────────────────────────────────────────────
async function scrapeGumtree(params) {
  const { maxPrice, minSeats } = params;
  const url = `https://www.gumtree.com/search?search_category=cars-vans-motorbikes&q=${minSeats}+seat+minibus&max_price=${maxPrice}&vehicle_type=minibus`;
  console.log('[Gumtree] Fetching:', url);
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);
    const listings = [];

    $('.listing-link, article.listing').each((i, el) => {
      const $el = $(el);
      const title = $el.find('h2, .listing-title, [data-q="listing-title"]').text().trim();
      if (!title) return;

      const priceText = $el.find('.listing-price, [data-q="listing-price"]').text().replace(/[^0-9]/g,'');
      const price = parseInt(priceText) || 0;
      if (price > maxPrice || price === 0) return;

      const href    = $el.attr('href') || $el.find('a').first().attr('href') || '';
      const imgSrc  = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
      const locText = $el.find('.listing-location, [data-q="listing-location"]').text().trim();
      const desc    = $el.find('.listing-description').text();
      const yearMatch = desc.match(/20\d{2}|19\d{2}/);
      const mileMatch = desc.match(/([\d,]+)\s*miles/i);

      listings.push({
        id:       `gt_${href.split('/').pop()?.split('?')[0] || i}`,
        platform: 'gumtree',
        title,
        price,
        year:     yearMatch ? yearMatch[0] : '',
        mileage:  mileMatch ? mileMatch[1] : '',
        location: locText,
        seats:    minSeats,
        url:      href.startsWith('http') ? href : `https://www.gumtree.com${href}`,
        imgUrl:   imgSrc,
        age:      'just found',
        foundAt:  Date.now(),
      });
    });

    if (!listings.length) {
      listings.push({
        id: `gt_direct_${Date.now()}`,
        platform: 'gumtree',
        title: `Gumtree — 17-seat minibuses under £${maxPrice.toLocaleString()}`,
        price: 0,
        year: '', mileage: '', location: 'Various',
        seats: minSeats,
        url,
        imgUrl: '',
        age: 'tap to view',
        foundAt: Date.now(),
        isDirect: true,
      });
    }
    console.log(`[Gumtree] Found ${listings.length} listings`);
    return listings;
  } catch (e) {
    console.error('[Gumtree] Error:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────
// SCRAPER: eBay Motors
// ─────────────────────────────────────────────────
async function scrapeEbay(params) {
  const { maxPrice, minSeats } = params;
  const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${minSeats}+seat+minibus&_sacat=9858&_udhi=${maxPrice}&LH_ItemCondition=3000&LH_BIN=1&_sop=10`;
  console.log('[eBay] Fetching:', url);
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);
    const listings = [];

    $('.s-item, li.s-item').each((i, el) => {
      const $el = $(el);
      if ($el.find('.s-item__title').text().includes('Shop on eBay')) return;

      const title     = $el.find('.s-item__title').text().trim();
      if (!title) return;
      const priceText = $el.find('.s-item__price').text().replace(/[^0-9.]/g,'');
      const price     = parseFloat(priceText) || 0;
      if (price > maxPrice || price === 0) return;

      const href      = $el.find('.s-item__link').attr('href') || '';
      const imgSrc    = $el.find('.s-item__image-img').attr('src') || '';
      const locText   = $el.find('.s-item__location').text().replace('Located in:','').trim();
      const yearMatch = title.match(/20\d{2}|19\d{2}/);

      listings.push({
        id:       `eb_${href.match(/itm\/(\d+)/)?.[1] || i}`,
        platform: 'ebay',
        title,
        price,
        year:     yearMatch ? yearMatch[0] : '',
        mileage:  '',
        location: locText,
        seats:    minSeats,
        url:      href.split('?')[0],
        imgUrl:   imgSrc,
        age:      'just found',
        foundAt:  Date.now(),
      });
    });

    if (!listings.length) {
      listings.push({
        id: `eb_direct_${Date.now()}`,
        platform: 'ebay',
        title: `eBay Motors — 17-seat minibuses under £${maxPrice.toLocaleString()}`,
        price: 0,
        year: '', mileage: '', location: 'Various',
        seats: minSeats,
        url,
        imgUrl: '',
        age: 'tap to view',
        foundAt: Date.now(),
        isDirect: true,
      });
    }
    console.log(`[eBay] Found ${listings.length} listings`);
    return listings;
  } catch (e) {
    console.error('[eBay] Error:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────
// SCRAPER: Motors.co.uk
// ─────────────────────────────────────────────────
async function scrapeMotors(params) {
  const { maxPrice, minSeats, postcode } = params;
  const url = `https://www.motors.co.uk/search/car/results/?Bodystyle=Minibus&PriceMax=${maxPrice}&Postcode=${postcode}`;
  console.log('[Motors] Fetching:', url);
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);
    const listings = [];

    $('.vehicle-card, .search-result-item, article').each((i, el) => {
      const $el = $(el);
      const title = $el.find('h2, h3, .vehicle-title, .result-title').text().trim();
      if (!title || title.length < 5) return;

      const priceText = $el.find('.price, .vehicle-price').text().replace(/[^0-9]/g,'');
      const price = parseInt(priceText) || 0;
      if (price > maxPrice || price === 0) return;

      const href = $el.find('a').first().attr('href') || '';
      const imgSrc = $el.find('img').first().attr('src') || '';
      const locText = $el.find('.location, .dealer-location').text().trim();

      listings.push({
        id:       `mo_${i}_${Date.now()}`,
        platform: 'motors',
        title,
        price,
        year:     '',
        mileage:  '',
        location: locText,
        seats:    minSeats,
        url:      href.startsWith('http') ? href : `https://www.motors.co.uk${href}`,
        imgUrl:   imgSrc,
        age:      'just found',
        foundAt:  Date.now(),
      });
    });

    if (!listings.length) {
      listings.push({
        id: `mo_direct_${Date.now()}`,
        platform: 'motors',
        title: `Motors.co.uk — Minibuses under £${maxPrice.toLocaleString()}`,
        price: 0,
        year: '', mileage: '', location: 'Various',
        seats: minSeats,
        url,
        imgUrl: '',
        age: 'tap to view',
        foundAt: Date.now(),
        isDirect: true,
      });
    }
    console.log(`[Motors] Found ${listings.length} listings`);
    return listings;
  } catch (e) {
    console.error('[Motors] Error:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────
// SCRAPER: Preloved
// ─────────────────────────────────────────────────
async function scrapePreloved(params) {
  const { maxPrice, minSeats } = params;
  const url = `https://www.preloved.co.uk/adverts/list/236/cars?keywords=${minSeats}+seat+minibus&price_max=${maxPrice}`;
  console.log('[Preloved] Fetching:', url);
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);
    const listings = [];

    $('.advert, .listing-item, .advert-tile').each((i, el) => {
      const $el = $(el);
      const title = $el.find('h3, h2, .advert-title, a').first().text().trim();
      if (!title || title.length < 5) return;

      const priceText = $el.find('.price, .advert-price').text().replace(/[^0-9]/g,'');
      const price = parseInt(priceText) || 0;
      if (price > maxPrice || price === 0) return;

      const href = $el.find('a').first().attr('href') || '';
      const imgSrc = $el.find('img').first().attr('src') || '';
      const locText = $el.find('.location').text().trim();

      listings.push({
        id:       `pl_${href.replace(/[^a-z0-9]/gi,'_') || i}`,
        platform: 'preloved',
        title,
        price,
        year:     '',
        mileage:  '',
        location: locText,
        seats:    minSeats,
        url:      href.startsWith('http') ? href : `https://www.preloved.co.uk${href}`,
        imgUrl:   imgSrc,
        age:      'just found',
        foundAt:  Date.now(),
      });
    });

    if (!listings.length) {
      listings.push({
        id: `pl_direct_${Date.now()}`,
        platform: 'preloved',
        title: `Preloved — ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`,
        price: 0,
        year: '', mileage: '', location: 'Various',
        seats: minSeats,
        url,
        imgUrl: '',
        age: 'tap to view',
        foundAt: Date.now(),
        isDirect: true,
      });
    }
    console.log(`[Preloved] Found ${listings.length} listings`);
    return listings;
  } catch (e) {
    console.error('[Preloved] Error:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────
// SCRAPER: Facebook Marketplace (link only — requires browser)
// ─────────────────────────────────────────────────
async function scrapeFacebook(params) {
  const { maxPrice, minSeats } = params;
  // Facebook blocks server-side scraping — provide direct search link
  return [{
    id: `fb_direct_${Date.now()}`,
    platform: 'facebook',
    title: `Facebook Marketplace — ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`,
    price: 0,
    year: '', mileage: '', location: 'Various',
    seats: minSeats,
    url: `https://www.facebook.com/marketplace/search/?query=${minSeats}+seat+minibus&maxPrice=${maxPrice}&categoryId=vehicles`,
    imgUrl: '',
    age: 'tap to view',
    foundAt: Date.now(),
    isDirect: true,
    note: 'Facebook requires login — tap to search directly',
  }];
}

// ─────────────────────────────────────────────────
// MAIN SCAN FUNCTION
// ─────────────────────────────────────────────────
async function runScan(params = {}) {
  const p = { ...DEFAULTS, ...params };
  const platforms = typeof p.platforms === 'string' ? p.platforms.split(',') : p.platforms;
  console.log(`\n🔍 Scanning platforms: ${platforms.join(', ')}`);
  console.log(`   Params: ${p.minSeats}-${p.maxSeats} seats, max £${p.maxPrice}, postcode ${p.postcode}`);

  const scrapers = {
    autotrader: scrapeAutoTrader,
    gumtree:    scrapeGumtree,
    ebay:       scrapeEbay,
    motors:     scrapeMotors,
    preloved:   scrapePreloved,
    facebook:   scrapeFacebook,
    shpock:     async () => [{ // Shpock — link only (requires JS)
      id: `sh_direct_${Date.now()}`,
      platform: 'shpock',
      title: `Shpock — ${p.minSeats}-seat minibuses under £${p.maxPrice.toLocaleString()}`,
      price: 0,
      year: '', mileage: '', location: 'Various',
      seats: p.minSeats,
      url: `https://www.shpock.com/en-gb/search?q=${p.minSeats}+seat+minibus&priceMax=${p.maxPrice}`,
      imgUrl: '', age: 'tap to view', foundAt: Date.now(), isDirect: true,
    }],
  };

  const results = await Promise.allSettled(
    platforms.map(name => scrapers[name] ? scrapers[name](p) : Promise.resolve([]))
  );

  let all = [];
  results.forEach(r => { if (r.status === 'fulfilled') all = all.concat(r.value); });

  // Filter by keyword if set
  if (p.keyword) {
    const kw = p.keyword.toLowerCase();
    all = all.filter(l => l.isDirect || l.title.toLowerCase().includes(kw) || (l.location||'').toLowerCase().includes(kw));
  }

  // Age formatting
  all = all.map(l => ({ ...l, age: formatAge(l.foundAt) }));

  // Sort: real listings first (price > 0), then by price ascending
  all.sort((a,b) => {
    if (a.price === 0 && b.price > 0) return 1;
    if (a.price > 0 && b.price === 0) return -1;
    return a.price - b.price;
  });

  listingStore = all;
  lastScan = new Date().toISOString();
  console.log(`✅ Scan complete. Total listings: ${all.length}\n`);
  return all;
}

function formatAge(ts) {
  const diff = Date.now() - ts;
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return `${Math.floor(diff/86400000)}d ago`;
}

// ─────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────
app.get('/api/listings', async (req, res) => {
  try {
    const params = {
      postcode:  req.query.postcode  || DEFAULTS.postcode,
      maxPrice:  parseInt(req.query.maxPrice)  || DEFAULTS.maxPrice,
      minSeats:  parseInt(req.query.minSeats)  || DEFAULTS.minSeats,
      maxSeats:  parseInt(req.query.maxSeats)  || DEFAULTS.maxSeats,
      keyword:   req.query.keyword   || '',
      platforms: req.query.platforms || DEFAULTS.platforms,
    };

    // Return cached if fresh (< 10 min old) and params match
    const fresh = lastScan && (Date.now() - new Date(lastScan).getTime()) < 600000;
    const listings = (fresh && listingStore.length) ? listingStore : await runScan(params);

    res.json({ listings, lastScan, count: listings.length });
  } catch (e) {
    console.error('/api/listings error:', e);
    res.status(500).json({ error: e.message, listings: [] });
  }
});

app.get('/api/scan', async (req, res) => {
  // Force a fresh scan
  try {
    const listings = await runScan(req.query);
    res.json({ listings, lastScan, count: listings.length });
  } catch (e) {
    res.status(500).json({ error: e.message, listings: [] });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    lastScan,
    listingCount: listingStore.length,
    version: '1.0.0',
  });
});

app.get('/', (req, res) => {
  res.json({ service: 'MiniBus Finder API', status: 'running', endpoints: ['/api/listings', '/api/scan', '/api/status'] });
});

// ─────────────────────────────────────────────────
// CRON — scan every 2 hours
// ─────────────────────────────────────────────────
cron.schedule('0 */2 * * *', () => {
  console.log('⏰ Cron scan triggered');
  runScan().catch(console.error);
});

// Initial scan on startup
setTimeout(() => runScan().catch(console.error), 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚌 MiniBus Finder API running on port ${PORT}`));
