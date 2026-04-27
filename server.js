/**
 * MiniBus Finder — Backend API v4
 * AutoTrader: text + URL regex extraction (bypasses React rendering issue)
 * eBay: cheerio HTML scraping (server-rendered, very reliable)
 * Bus & Coach Buyer: cheerio HTML scraping (PSV specialist site!)
 * All others: correct direct browse links
 * Keywords: returned in results metadata — client decides how to filter/highlight
 */

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cron    = require('node-cron');
const cors    = require('cors');

const app = express();
app.use(cors({ origin:'*', methods:['GET','POST','OPTIONS'], allowedHeaders:['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

let listingStore = [];
let lastScan     = null;

const DEFAULTS = {
  postcode:  'BB97TZ',
  maxPrice:  5000,
  minSeats:  17,
  maxSeats:  17,
  keyword:   '',
  wholeUK:   false,
  platforms: 'autotrader,gumtree,ebay,buscoach,cazoo,motors,preloved,commercialmotor,facebook,shpock',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Cache-Control': 'no-cache',
};

function directCard(platform, title, url, params) {
  return {
    id: `${platform}_direct_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    platform, title, price: 0,
    year:'', mileage:'', location:'UK-wide',
    seats: params.minSeats || 17,
    url, imgUrl:'', age:'tap to browse',
    foundAt: Date.now(), isDirect: true,
  };
}

function stripHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi,'')
             .replace(/<style[\s\S]*?<\/style>/gi,'')
             .replace(/<[^>]+>/g,' ')
             .replace(/\s+/g,' ').trim();
}

// ══════════════════════════════════════════════════
// AUTOTRADER — text + regex extraction
// Bypasses React rendering: extracts listing IDs from
// raw HTML hrefs, then parses page text for details
// ══════════════════════════════════════════════════
async function scrapeAutoTrader(params) {
  const { postcode, maxPrice, minSeats, maxSeats, wholeUK } = params;
  const pc  = (!postcode || wholeUK) ? 'LS11AB' : postcode.replace(/\s/g,'');
  const url = `https://www.autotrader.co.uk/car-search?body-type=Minibus&maximum-seats=${maxSeats}&minimum-seats=${minSeats}&postcode=${pc}&price-to=${maxPrice}&radius=1500&sort=relevance`;
  console.log('[AutoTrader] Fetching:', url);

  try {
    const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 20000 });

    // ── Step 1: Try Next.js embedded JSON ──────────────
    try {
      const jsonMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (jsonMatch) {
        const nd      = JSON.parse(jsonMatch[1]);
        const adverts =
          nd?.props?.pageProps?.searchResults?.advertSummaries ||
          nd?.props?.pageProps?.initialData?.search?.listings  ||
          nd?.props?.pageProps?.listings || [];

        if (adverts.length) {
          const listings = [];
          adverts.forEach((item, i) => {
            const priceRaw = String(item?.price?.advertisedPrice || item?.pricingInfo?.price || '0');
            const price    = parseInt(priceRaw.replace(/[^0-9]/g,'')) || 0;
            if (!price || price > maxPrice) return;

            const href = item?.href || item?.url || `/car-details/${item?.id || ''}`;
            listings.push({
              id:       `at_${item?.id || i}`,
              platform: 'autotrader',
              title:    item?.heading || item?.title || 'Minibus',
              price,
              year:     String(item?.year || ''),
              mileage:  String(item?.mileage?.mileage || '').replace(/[^0-9,]/g,''),
              location: item?.sellerInfo?.town || item?.location || '',
              seats:    minSeats,
              url:      href.startsWith('http') ? href : `https://www.autotrader.co.uk${href}`,
              imgUrl:   item?.imageUrls?.[0] || item?.images?.[0]?.url || '',
              age:      'just found', foundAt: Date.now(),
            });
          });
          console.log(`[AutoTrader] Next.js JSON: ${listings.length} listings`);
          if (listings.length) return listings;
        }
      }
    } catch(e) { console.log('[AutoTrader] No Next.js JSON:', e.message); }

    // ── Step 2: Extract listing IDs from raw HTML hrefs ──
    const idPattern   = /\/car-details\/(\d{15,20})/g;
    const foundIds    = [];
    const seenIds     = new Set();
    let idMatch;
    while ((idMatch = idPattern.exec(html)) !== null) {
      if (!seenIds.has(idMatch[1])) { seenIds.add(idMatch[1]); foundIds.push(idMatch[1]); }
    }
    console.log(`[AutoTrader] Found ${foundIds.length} unique listing IDs in HTML`);

    // ── Step 3: Parse page text for listing details ──────
    const pageText = stripHtml(html);

    // Split on "Save advert" which appears before each listing card
    const chunks = pageText.split(/Save\s+advert/i);
    const listings = [];

    chunks.forEach((chunk, ci) => {
      if (ci === 0 || ci > foundIds.length) return; // skip header chunk
      const id = foundIds[ci - 1];

      // Extract price (appears twice: in title line and again separately)
      const prices = [...chunk.matchAll(/£([\d,]+)/g)].map(m => parseInt(m[1].replace(/,/g,'')));
      const price = prices.find(p => p > 500 && p <= maxPrice);
      if (!price) return;

      // Extract year like "2013 (13 reg)" or just "2013"
      const yearMatch = chunk.match(/\b(200[0-9]|201[0-9]|202[0-5])\b/);

      // Extract mileage — first occurrence of "X,XXX miles" but not "(X miles)" distances
      const mileMatch = chunk.match(/([\d,]+)\s+miles(?!\s*\))/i);

      // Extract location — city name before "(X miles)" distance pattern
      const locMatch = chunk.match(/([A-Za-z\s]+)\s*\(\d{1,3}\s*miles\)/);
      const location = locMatch ? locMatch[1].trim().replace(/Dealer location|Private seller/gi,'').trim() : '';

      // Extract title — text after image counter pattern like "1/32" up to first comma or price
      const titleMatch = chunk.match(/\d+\/\d+\s*([A-Za-z][^\n£]{5,80?}?)(?:,\s*£|£)/);
      const title = titleMatch ? titleMatch[1].trim() : 'Minibus';

      // Extract description highlights (PSV, Class 5, etc.)
      const description = chunk.substring(0, 500);

      listings.push({
        id:          `at_${id}`,
        platform:    'autotrader',
        title,
        price,
        year:        yearMatch ? yearMatch[1] : '',
        mileage:     mileMatch ? mileMatch[1] : '',
        location,
        description,
        seats:       minSeats,
        url:         `https://www.autotrader.co.uk/car-details/${id}`,
        imgUrl:      '',
        age:         'just found',
        foundAt:     Date.now(),
      });
    });

    console.log(`[AutoTrader] Text parsing: ${listings.length} listings`);
    if (listings.length) return listings;

    // ── Step 4: Last resort — direct link ─────────────────
    return [directCard('autotrader', `AutoTrader — tap to browse ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`, url, params)];

  } catch(e) {
    console.error('[AutoTrader] Error:', e.message);
    return [directCard('autotrader', `AutoTrader — tap to browse ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`, url, params)];
  }
}

// ══════════════════════════════════════════════════
// EBAY — server-rendered, cheerio scraping
// ══════════════════════════════════════════════════
async function scrapeEbay(params) {
  const { maxPrice, minSeats, keyword } = params;
  const q   = `${minSeats} seat minibus${keyword ? ' ' + keyword : ''}`;
  const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=9858&_udhi=${maxPrice}&LH_ItemCondition=3000&LH_BIN=1&_sop=10&_ipg=60`;
  console.log('[eBay] Fetching:', url);
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
    const $        = cheerio.load(data);
    const listings = [];

    $('.s-item').each((i, el) => {
      const $el   = $(el);
      const title = $el.find('.s-item__title').text().trim();
      if (!title || title.includes('Shop on eBay')) return;
      if (!title.toLowerCase().match(/minibus|mini.?bus|\d+\s*seat/)) return;

      const price = parseFloat($el.find('.s-item__price').first().text().replace(/[^0-9.]/g,'')) || 0;
      if (!price || price > maxPrice) return;

      const href    = $el.find('a.s-item__link').attr('href') || '';
      const imgSrc  = $el.find('.s-item__image-img').attr('src') || '';
      const loc     = $el.find('.s-item__location').text().replace('Located in:','').trim();
      const sub     = $el.find('.s-item__subtitle,.SECONDARY_INFO').text();
      const desc    = $el.find('.s-item__detail').text();
      const ym      = (title+sub).match(/\b(200[0-9]|201[0-9]|202[0-5])\b/);
      const mm      = (sub+desc).match(/([\d,]+)\s*miles/i);

      listings.push({
        id:          `eb_${href.match(/itm\/(\d+)/)?.[1] || i}`,
        platform:    'ebay',
        title, price,
        year:        ym ? ym[1] : '',
        mileage:     mm ? mm[1] : '',
        location:    loc, seats: minSeats,
        url:         href.split('?')[0],
        imgUrl:      imgSrc.replace(/s-l\d+/,'s-l500'),
        age:         'just found', foundAt: Date.now(),
      });
    });

    console.log(`[eBay] ${listings.length} real listings`);
    return listings.length ? listings : [directCard('ebay', `eBay Motors — tap to browse ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`, url, params)];
  } catch(e) {
    console.error('[eBay] Error:', e.message);
    return [directCard('ebay', `eBay Motors — tap to browse ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`,
      `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(`${minSeats} seat minibus`)}&_sacat=9858&_udhi=${maxPrice}&LH_ItemCondition=3000`, params)];
  }
}

// ══════════════════════════════════════════════════
// BUS & COACH BUYER — PSV specialist classifieds site
// Listings are specifically PSV/Class 5 vehicles
// ══════════════════════════════════════════════════
async function scrapeBusCoach(params) {
  const { maxPrice, minSeats } = params;
  const url = `https://classifieds.busandcoachbuyer.com/classifieds/minibuses/`;
  console.log('[BusCoach] Fetching:', url);
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
    const $        = cheerio.load(data);
    const listings = [];

    // Try multiple selector patterns for listing cards
    const cardSels = ['.classified-item', '.listing-item', 'article', '.vehicle-card', '.advert'];
    let cards = $();
    for (const sel of cardSels) {
      cards = $(sel);
      if (cards.length > 2) break;
    }

    cards.each((i, el) => {
      const $el   = $(el);
      const text  = $el.text();

      // Extract price
      const pm    = text.match(/£([\d,]+)/);
      const price = pm ? parseInt(pm[1].replace(/,/g,'')) : 0;
      if (price > maxPrice && price > 0) return; // skip over-budget, include £0 (POA)

      // Get link
      const href  = $el.find('a').first().attr('href') || '';
      if (!href || href === '#') return;

      // Extract title
      const title = $el.find('h2, h3, h4, .title, strong').first().text().trim()
                 || text.match(/(\d{4}[^£\n]{10,80})/)?.[1]?.trim()
                 || 'Minibus';

      if (title.length < 5) return;

      // Extract year and mileage from text
      const ym  = text.match(/\b(200[0-9]|201[0-9]|202[0-5])\b/);
      const mm  = text.match(/([\d,]+)\s*(?:kms?|miles)/i);
      const loc = $el.find('.location, .address, [class*="location"]').text().trim()
               || text.match(/(?:Location|Based in)[:\s]+([A-Za-z\s,]+)/i)?.[1]?.trim() || '';

      const imgSrc = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
      const fullUrl = href.startsWith('http') ? href : `https://classifieds.busandcoachbuyer.com${href}`;

      listings.push({
        id:          `bc_${href.replace(/[^a-z0-9]/gi,'_').slice(-20)}`,
        platform:    'buscoach',
        title,
        price,
        year:        ym ? ym[1] : '',
        mileage:     mm ? mm[1] : '',
        location:    loc,
        seats:       minSeats,
        url:         fullUrl,
        imgUrl:      imgSrc,
        description: 'PSV Specialist — All listings are minibus/coach vehicles',
        age:         'just found',
        foundAt:     Date.now(),
        isPSVSite:   true, // flag all listings from this specialist site
      });
    });

    // Also try text-based approach as fallback
    if (listings.length < 2) {
      const pageText = stripHtml(data);
      const idRe = /classifieds\/busandcoachbuyer\.com\/classified\/([a-z0-9-]+)\//g;
      const hrefRe = /href="(\/classified\/[^"]+)"/g;
      const hrefs  = [...new Set([...data.matchAll(hrefRe)].map(m => m[1]).filter(h => h.includes('/classified/')))];

      hrefs.slice(0, 20).forEach((href, i) => {
        const fullUrl = `https://classifieds.busandcoachbuyer.com${href}`;
        const pm    = pageText.match(/£([\d,]+)/g);
        listings.push({
          id:       `bc_${i}_${Date.now()}`, platform: 'buscoach',
          title:    'Minibus — PSV Specialist Listing',
          price:    0, year:'', mileage:'', location:'UK',
          seats:    minSeats, url: fullUrl, imgUrl:'',
          description: 'PSV Specialist — All listings are minibus/coach vehicles',
          age: 'tap to view', foundAt: Date.now(), isPSVSite: true,
        });
      });
    }

    console.log(`[BusCoach] ${listings.length} listings`);
    if (listings.length) return listings.slice(0, 20); // cap at 20

    return [directCard('buscoach', `Bus & Coach Buyer — PSV specialist — tap to browse minibuses`, url, params)];
  } catch(e) {
    console.error('[BusCoach] Error:', e.message);
    return [directCard('buscoach', `Bus & Coach Buyer — PSV specialist — tap to browse minibuses`,
      `https://classifieds.busandcoachbuyer.com/classifieds/minibuses/`, params)];
  }
}

// ══════════════════════════════════════════════════
// GUMTREE — direct link (blocks server scraping)
// ══════════════════════════════════════════════════
async function scrapeGumtree(params) {
  const { maxPrice, minSeats, keyword } = params;
  const q   = keyword ? `${minSeats}+seat+minibus+${encodeURIComponent(keyword)}` : `${minSeats}+seat+minibus`;
  const url = `https://www.gumtree.com/cars-vans-motorbikes/uk/${q}?max_price=${maxPrice}&vehicle_type=minibus`;
  return [directCard('gumtree', `Gumtree — tap to browse ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`, url, params)];
}

// ══════════════════════════════════════════════════
// CAZOO — large dealer aggregator
// ══════════════════════════════════════════════════
async function scrapeCazoo(params) {
  const { maxPrice, minSeats } = params;
  const url = `https://www.cazoo.co.uk/vans/minibus/?price_to=${maxPrice}&seats_min=${minSeats}`;
  return [directCard('cazoo', `Cazoo — tap to browse ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`, url, params)];
}

// ══════════════════════════════════════════════════
// MOTORS.CO.UK
// ══════════════════════════════════════════════════
async function scrapeMotors(params) {
  const { maxPrice, minSeats, postcode, wholeUK } = params;
  const pc  = (!postcode || wholeUK) ? 'LS1+1AB' : postcode.replace(/\s/g,'+');
  const url = `https://www.motors.co.uk/search/car/results/?Bodystyle=Minibus&PriceMax=${maxPrice}&Postcode=${pc}&Distance=National`;
  return [directCard('motors', `Motors.co.uk — tap to browse ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`, url, params)];
}

// ══════════════════════════════════════════════════
// COMMERCIAL MOTOR — trade publication classifieds
// ══════════════════════════════════════════════════
async function scrapeCommercialMotor(params) {
  const { maxPrice, minSeats } = params;
  const url = `https://www.commercialmotor.com/used-trucks/bt/mpv-minibus?pricemax=${maxPrice}`;
  return [directCard('commercialmotor', `Commercial Motor — tap to browse minibuses under £${maxPrice.toLocaleString()}`, url, params)];
}

// ══════════════════════════════════════════════════
// PRELOVED
// ══════════════════════════════════════════════════
async function scrapePreloved(params) {
  const { maxPrice, minSeats, keyword } = params;
  const kw  = keyword ? `${minSeats}+seat+minibus+${encodeURIComponent(keyword)}` : `${minSeats}+seat+minibus`;
  const url = `https://www.preloved.co.uk/adverts/list/236/cars?keywords=${kw}&price_max=${maxPrice}&distance=national`;
  return [directCard('preloved', `Preloved — tap to browse ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`, url, params)];
}

// ══════════════════════════════════════════════════
// SHPOCK
// ══════════════════════════════════════════════════
async function scrapeShpock(params) {
  const { maxPrice, minSeats, keyword } = params;
  const q   = keyword ? `${minSeats} seat minibus ${keyword}` : `${minSeats} seat minibus`;
  const url = `https://www.shpock.com/en-gb/search?q=${encodeURIComponent(q)}&categories=vehicles&priceMin=100&priceMax=${maxPrice}`;
  return [directCard('shpock', `Shpock — tap to browse ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`, url, params)];
}

// ══════════════════════════════════════════════════
// FACEBOOK MARKETPLACE
// ══════════════════════════════════════════════════
async function scrapeFacebook(params) {
  const { maxPrice, minSeats, keyword } = params;
  const q   = keyword ? `${minSeats} seat minibus ${keyword}` : `${minSeats} seat minibus`;
  const url = `https://www.facebook.com/marketplace/search?query=${encodeURIComponent(q)}&maxPrice=${maxPrice}`;
  return [{
    ...directCard('facebook', `Facebook Marketplace — tap to browse (personal login required)`, url, params),
    note: 'Must be logged into a personal Facebook account (not a business page)',
  }];
}

// ══════════════════════════════════════════════════
// MAIN SCAN
// ══════════════════════════════════════════════════
async function runScan(params = {}) {
  const p = {
    ...DEFAULTS, ...params,
    maxPrice: parseInt(params.maxPrice) || DEFAULTS.maxPrice,
    minSeats: parseInt(params.minSeats) || DEFAULTS.minSeats,
    maxSeats: parseInt(params.maxSeats) || DEFAULTS.maxSeats,
    wholeUK:  params.wholeUK === 'true' || params.wholeUK === true,
  };
  const platforms = typeof p.platforms === 'string' ? p.platforms.split(',') : p.platforms;
  const keyword   = (p.keyword || '').trim();

  console.log(`\n🔍 Scanning: ${platforms.join(', ')}`);
  console.log(`   seats:${p.minSeats}-${p.maxSeats} | max:£${p.maxPrice} | postcode:${p.postcode} | wholeUK:${p.wholeUK} | keyword:"${keyword||'none'}"`);

  const scrapers = {
    autotrader:     scrapeAutoTrader,
    gumtree:        scrapeGumtree,
    ebay:           scrapeEbay,
    buscoach:       scrapeBusCoach,
    cazoo:          scrapeCazoo,
    motors:         scrapeMotors,
    preloved:       scrapePreloved,
    commercialmotor: scrapeCommercialMotor,
    shpock:         scrapeShpock,
    facebook:       scrapeFacebook,
  };

  const results = await Promise.allSettled(
    platforms.filter(n => scrapers[n]).map(n => scrapers[n]({ ...p, keyword }))
  );

  let all = [];
  results.forEach(r => { if (r.status === 'fulfilled') all = all.concat(r.value); });
  all = all.map(l => ({ ...l, age: formatAge(l.foundAt) }));

  // Sort: real listings (price > 0) first by price asc, portals at bottom
  all.sort((a, b) => {
    if (a.isDirect && !b.isDirect) return 1;
    if (!a.isDirect && b.isDirect) return -1;
    return a.price - b.price;
  });

  listingStore = all;
  lastScan     = new Date().toISOString();
  const real   = all.filter(l => !l.isDirect).length;
  const portals = all.filter(l => l.isDirect).length;
  console.log(`✅ ${all.length} total | ${real} real listings | ${portals} browse portals\n`);

  return { listings: all };
}

function formatAge(ts) {
  const d = Date.now() - ts;
  if (d < 3600000)  return `${Math.floor(d/60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h ago`;
  return `${Math.floor(d/86400000)}d ago`;
}

// ══════════════════════════════════════════════════
// REST API
// ══════════════════════════════════════════════════
app.get('/api/listings', async (req, res) => {
  try {
    const result = await runScan(req.query);
    res.json({ listings: result.listings, lastScan, count: result.listings.length });
  } catch(e) {
    console.error('/api/listings error:', e);
    res.status(500).json({ error: e.message, listings: [] });
  }
});

app.get('/api/scan', async (req, res) => {
  try {
    const result = await runScan(req.query);
    res.json({ listings: result.listings, lastScan, count: result.listings.length });
  } catch(e) { res.status(500).json({ error: e.message, listings: [] }); }
});

app.get('/api/status', (req, res) => {
  res.json({ status:'online', lastScan, listingCount: listingStore.length, version:'4.0.0' });
});

app.get('/', (req, res) => {
  res.json({ service:'MiniBus Finder API v4', status:'running', endpoints:['/api/listings','/api/scan','/api/status'] });
});

cron.schedule('0 */2 * * *', () => runScan().catch(console.error));
setTimeout(() => runScan().catch(console.error), 3000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚌 MiniBus Finder API v4 on port ${PORT}`));
