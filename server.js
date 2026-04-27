/**
 * MiniBus Finder — Backend v5
 * AutoTrader: confirmed text+regex extraction (images from atcdn.co.uk CDN)
 * eBay: cheerio HTML scraping
 * All others: correct direct browse links
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
let lastScan = null;

const DEFAULTS = {
  postcode:  'BB97TZ',
  maxPrice:  5000,
  minSeats:  17,
  maxSeats:  17,
  keyword:   '',
  wholeUK:   false,
  platforms: 'autotrader,gumtree,ebay,motors,preloved,facebook,shpock',
};

// Full browser-like headers to avoid bot detection
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

function directCard(platform, title, url, params) {
  return {
    id: `${platform}_direct_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
    platform, title, price: 0,
    year:'', mileage:'', location:'UK-wide',
    seats: params.minSeats||17, url, imgUrl:'',
    age:'tap to browse', foundAt: Date.now(), isDirect: true,
  };
}

// ── PARSE AUTOTRADER LISTING TEXT ─────────────────────────────
// Confirmed working against live DOM — these patterns are exact
function parseATText(text) {
  // Price: matches "£4,750" (1-2 digits, comma, exactly 3 digits)
  const pm = text.match(/£(\d{1,2},\d{3})/);
  const price = pm ? parseInt(pm[1].replace(',','')) : 0;

  // Year: 4-digit year followed by reg plate format
  const ym = text.match(/\b(200[0-9]|201[0-9]|202[0-5])\b/);

  // Mileage: digits+comma before "miles" NOT inside brackets (distances)
  const mm = text.match(/([\d,]+)\s+miles(?!\s*\))/i);

  // Location: word(s) before "(XX miles)" distance indicator
  const lm = text.match(/([A-Za-z][A-Za-z\s]+?)\s*\(\d{2,3}\s+miles\)/);
  const location = lm ? lm[1].replace(/Dealer location|Private seller/gi,'').trim() : '';

  // Title: after image counter pattern like "right1/32" up to first digit spec
  const tm = text.match(/right\d+\/\d+\s*((?:Ford|Mercedes|Volkswagen|Peugeot|Vauxhall|Renault|Iveco|Citroen|Toyota|Fiat)[^\d£\n]{5,60}?)(?:\d|\.|£)/i);
  const title = tm ? tm[1].trim().replace(/\s+/g,' ') : 'Minibus';

  // Highlights: PSV, Class 5, D1 etc
  const hi = text.match(/(?:PSV|D1|class\s*5|section\s*19|public service)[^\n]{0,80}/i);
  const highlights = hi ? hi[0].trim() : '';

  return { price, year: ym?.[1]||'', mileage: mm?.[1]||'', location, title, highlights };
}

// ── AUTOTRADER SCRAPER ─────────────────────────────────────────
async function scrapeAutoTrader(params) {
  const { postcode, maxPrice, minSeats, maxSeats, wholeUK } = params;
  const pc  = (!postcode||wholeUK) ? 'LS1+1AB' : postcode.replace(/\s+/g,'+');
  const url = `https://www.autotrader.co.uk/car-search?body-type=Minibus&maximum-seats=${maxSeats}&minimum-seats=${minSeats}&postcode=${pc}&price-to=${maxPrice}&radius=1500&sort=relevance`;
  console.log('[AutoTrader]', url);

  try {
    const { data: html } = await axios.get(url, { headers:HEADERS, timeout:25000 });
    const listings = [];

    // ── Method 1: Next.js embedded JSON ────────────────────────
    try {
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (m) {
        const nd = JSON.parse(m[1]);
        const adverts = nd?.props?.pageProps?.searchResults?.advertSummaries
                     || nd?.props?.pageProps?.initialData?.search?.listings
                     || nd?.props?.pageProps?.listings || [];
        adverts.forEach((a, i) => {
          const rawPrice = String(a?.price?.advertisedPrice||a?.pricingInfo?.price||'0');
          const price = parseInt(rawPrice.replace(/[^0-9]/g,'')) || 0;
          if (!price || price > maxPrice) return;
          const href = a?.href||a?.url||`/car-details/${a?.id||''}`;
          listings.push({
            id:`at_${a?.id||i}`, platform:'autotrader',
            title: a?.heading||a?.title||'Minibus', price,
            year: String(a?.year||''),
            mileage: String(a?.mileage?.mileage||'').replace(/[^0-9,]/g,''),
            location: a?.sellerInfo?.town||a?.location||'',
            seats: minSeats,
            url: href.startsWith('http')?href:`https://www.autotrader.co.uk${href}`,
            imgUrl: a?.imageUrls?.[0]||a?.images?.[0]?.url||'',
            highlights: '', age:'just found', foundAt:Date.now(),
          });
        });
        if (listings.length) { console.log(`[AutoTrader] JSON: ${listings.length}`); return listings; }
      }
    } catch(e) {}

    // ── Method 2: Extract IDs + images + text via regex ─────────
    // Get unique listing IDs preserving order
    const idRe  = /\/car-details\/(\d{15,20})/g;
    const imgRe = /https:\/\/m\.atcdn\.co\.uk\/a\/media\/w\d+\/([a-f0-9]+)\.jpg/g;
    const ids   = [...new Set([...html.matchAll(idRe)].map(m=>m[1]))];
    // Map: listing ID → first image hash
    const idToImg = {};
    // Find img tags with atcdn URLs
    const imgTagRe = /car-details\/(\d{15,20})[^"]*"[\s\S]{0,2000}?atcdn\.co\.uk\/a\/media\/\w+\/([a-f0-9]+)\.jpg/g;
    let imgMatch;
    while ((imgMatch = imgTagRe.exec(html)) !== null) {
      if (!idToImg[imgMatch[1]]) idToImg[imgMatch[1]] = imgMatch[2];
    }
    // Also try sequential matching of atcdn images
    const allImgs = [...html.matchAll(/m\.atcdn\.co\.uk\/a\/media\/w\d+\/([a-f0-9]+)\.jpg/g)].map(m=>m[1]);

    // Strip HTML to get page text
    const pageText = html.replace(/<script[\s\S]*?<\/script>/gi,'')
                         .replace(/<style[\s\S]*?<\/style>/gi,'')
                         .replace(/<[^>]+>/g,' ')
                         .replace(/\s+/g,' ');

    // Split on "Save advert" divider between listings
    const chunks = pageText.split(/Save\s+advert/i);
    console.log(`[AutoTrader] IDs:${ids.length} imgs:${allImgs.length} chunks:${chunks.length}`);

    chunks.forEach((chunk, ci) => {
      if (ci === 0 || ci > ids.length) return;
      const id = ids[ci-1];
      const parsed = parseATText(chunk);
      if (!parsed.price || parsed.price > maxPrice) return;

      // Get image - try matched first, then sequential
      const imgHash = idToImg[id] || allImgs[(ci-1)*4] || '';
      const imgUrl  = imgHash ? `https://m.atcdn.co.uk/a/media/w600/${imgHash}.jpg` : '';

      listings.push({
        id:`at_${id}`, platform:'autotrader',
        title: parsed.title||'Minibus',
        price: parsed.price,
        year: parsed.year,
        mileage: parsed.mileage,
        location: parsed.location,
        highlights: parsed.highlights,
        seats: minSeats,
        url: `https://www.autotrader.co.uk/car-details/${id}`,
        imgUrl,
        age:'just found', foundAt:Date.now(),
      });
    });

    console.log(`[AutoTrader] Text: ${listings.length}`);
    if (listings.length) return listings;

    return [directCard('autotrader',`AutoTrader — tap to browse ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`,url,params)];
  } catch(e) {
    console.error('[AutoTrader]',e.message);
    return [directCard('autotrader',`AutoTrader — tap to browse ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`,url,params)];
  }
}

// ── EBAY SCRAPER ─────────────────────────────────────────────
async function scrapeEbay(params) {
  const { maxPrice, minSeats, keyword } = params;
  const q   = `${minSeats} seat minibus${keyword?' '+keyword:''}`;
  const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=9858&_udhi=${maxPrice}&LH_ItemCondition=3000&LH_BIN=1&_sop=10&_ipg=60`;
  console.log('[eBay]',url);
  try {
    const { data } = await axios.get(url, { headers:HEADERS, timeout:20000 });
    const $ = cheerio.load(data);
    const listings = [];
    $('.s-item').each((i,el) => {
      const $el = $(el);
      const title = $el.find('.s-item__title').text().trim();
      if (!title||title.includes('Shop on eBay')) return;
      if (!title.toLowerCase().match(/minibus|mini.?bus|\d+\s*seat/)) return;
      const price = parseFloat($el.find('.s-item__price').first().text().replace(/[^0-9.]/g,''))||0;
      if (!price||price>maxPrice) return;
      const href   = $el.find('a.s-item__link').attr('href')||'';
      const imgSrc = $el.find('.s-item__image-img').attr('src')||'';
      const loc    = $el.find('.s-item__location').text().replace('Located in:','').trim();
      const ym     = title.match(/\b(200[0-9]|201[0-9]|202[0-5])\b/);
      listings.push({
        id:`eb_${href.match(/itm\/(\d+)/)?.[1]||i}`, platform:'ebay',
        title, price, year:ym?ym[1]:'', mileage:'', location:loc, seats:minSeats,
        url:href.split('?')[0], imgUrl:imgSrc.replace(/s-l\d+/,'s-l500'),
        age:'just found', foundAt:Date.now(),
      });
    });
    console.log(`[eBay] ${listings.length} listings`);
    return listings.length ? listings : [directCard('ebay',`eBay Motors — tap to browse ${minSeats}-seat minibuses under £${maxPrice.toLocaleString()}`,url,params)];
  } catch(e) {
    console.error('[eBay]',e.message);
    return [directCard('ebay',`eBay Motors — tap to browse`,`https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(`${minSeats} seat minibus`)}&_sacat=9858&_udhi=${maxPrice}&LH_ItemCondition=3000`,params)];
  }
}

// ── DIRECT LINK PLATFORMS ─────────────────────────────────────
async function scrapeGumtree(p) {
  const q = `${p.minSeats}+seat+minibus${p.keyword?'+'+encodeURIComponent(p.keyword):''}`;
  return [directCard('gumtree',`Gumtree — tap to browse ${p.minSeats}-seat minibuses under £${p.maxPrice.toLocaleString()}`,
    `https://www.gumtree.com/cars-vans-motorbikes/uk/${q}?max_price=${p.maxPrice}&vehicle_type=minibus`,p)];
}
async function scrapeMotors(p) {
  const pc = (!p.postcode||p.wholeUK)?'LS1+1AB':p.postcode.replace(/\s+/g,'+');
  return [directCard('motors',`Motors.co.uk — tap to browse ${p.minSeats}-seat minibuses under £${p.maxPrice.toLocaleString()}`,
    `https://www.motors.co.uk/search/car/results/?Bodystyle=Minibus&PriceMax=${p.maxPrice}&Postcode=${pc}&Distance=National`,p)];
}
async function scrapePreloved(p) {
  const kw = `${p.minSeats}+seat+minibus${p.keyword?'+'+encodeURIComponent(p.keyword):''}`;
  return [directCard('preloved',`Preloved — tap to browse ${p.minSeats}-seat minibuses under £${p.maxPrice.toLocaleString()}`,
    `https://www.preloved.co.uk/adverts/list/236/cars?keywords=${kw}&price_max=${p.maxPrice}&distance=national`,p)];
}
async function scrapeShpock(p) {
  const q = `${p.minSeats} seat minibus${p.keyword?' '+p.keyword:''}`;
  return [directCard('shpock',`Shpock — tap to browse ${p.minSeats}-seat minibuses under £${p.maxPrice.toLocaleString()}`,
    `https://www.shpock.com/en-gb/search?q=${encodeURIComponent(q)}&categories=vehicles&priceMax=${p.maxPrice}`,p)];
}
async function scrapeFacebook(p) {
  const q = `${p.minSeats} seat minibus${p.keyword?' '+p.keyword:''}`;
  return [{...directCard('facebook',`Facebook Marketplace — tap to browse (personal login required)`,
    `https://www.facebook.com/marketplace/search?query=${encodeURIComponent(q)}&maxPrice=${p.maxPrice}`,p),
    note:'Must be logged into a personal Facebook account'}];
}
async function scrapeBusCoach(p) {
  return [directCard('buscoach','Bus & Coach Buyer — PSV specialist — tap to browse minibuses',
    'https://classifieds.busandcoachbuyer.com/classifieds/minibuses/',p)];
}
async function scrapeCazoo(p) {
  return [directCard('cazoo',`Cazoo — tap to browse ${p.minSeats}-seat minibuses under £${p.maxPrice.toLocaleString()}`,
    `https://www.cazoo.co.uk/vans/minibus/?price_to=${p.maxPrice}&seats_min=${p.minSeats}`,p)];
}
async function scrapeCommercialMotor(p) {
  return [directCard('commercialmotor',`Commercial Motor — tap to browse minibuses under £${p.maxPrice.toLocaleString()}`,
    `https://www.commercialmotor.com/used-trucks/bt/mpv-minibus?pricemax=${p.maxPrice}`,p)];
}

// ── MAIN SCAN ─────────────────────────────────────────────────
async function runScan(params={}) {
  const p = {
    ...DEFAULTS,...params,
    maxPrice: parseInt(params.maxPrice)||DEFAULTS.maxPrice,
    minSeats: parseInt(params.minSeats)||DEFAULTS.minSeats,
    maxSeats: parseInt(params.maxSeats)||DEFAULTS.maxSeats,
    wholeUK:  params.wholeUK==='true'||params.wholeUK===true,
  };
  const platforms = typeof p.platforms==='string' ? p.platforms.split(',') : p.platforms;
  const keyword   = (p.keyword||'').trim();
  console.log(`\n🔍 ${platforms.join(',')} | seats:${p.minSeats}-${p.maxSeats} | £${p.maxPrice} | ${p.postcode} | uk:${p.wholeUK}`);

  const scrapers = {
    autotrader, gumtree:scrapeGumtree, ebay:scrapeEbay,
    buscoach:scrapeBusCoach, cazoo:scrapeCazoo, motors:scrapeMotors,
    preloved:scrapePreloved, commercialmotor:scrapeCommercialMotor,
    shpock:scrapeShpock, facebook:scrapeFacebook,
    autotrader: scrapeAutoTrader,
  };

  const results = await Promise.allSettled(
    platforms.filter(n=>scrapers[n]).map(n=>scrapers[n]({...p,keyword}))
  );
  let all = [];
  results.forEach(r=>{ if(r.status==='fulfilled') all=all.concat(r.value); });
  all = all.map(l=>({...l,age:formatAge(l.foundAt)}));
  all.sort((a,b)=>{ if(a.isDirect&&!b.isDirect)return 1; if(!a.isDirect&&b.isDirect)return -1; return a.price-b.price; });

  listingStore=all; lastScan=new Date().toISOString();
  const real=all.filter(l=>!l.isDirect).length;
  console.log(`✅ ${all.length} total | ${real} real listings\n`);
  return {listings:all};
}

function formatAge(ts) {
  const d=Date.now()-ts;
  if(d<3600000) return `${Math.floor(d/60000)}m ago`;
  if(d<86400000) return `${Math.floor(d/3600000)}h ago`;
  return `${Math.floor(d/86400000)}d ago`;
}

// ── API ──────────────────────────────────────────────────────
app.get('/api/listings', async(req,res)=>{
  try { const r=await runScan(req.query); res.json({listings:r.listings,lastScan,count:r.listings.length}); }
  catch(e){ res.status(500).json({error:e.message,listings:[]}); }
});
app.get('/api/scan', async(req,res)=>{
  try { const r=await runScan(req.query); res.json({listings:r.listings,lastScan,count:r.listings.length}); }
  catch(e){ res.status(500).json({error:e.message,listings:[]}); }
});
app.get('/api/status',(req,res)=>res.json({status:'online',lastScan,listingCount:listingStore.length,version:'5.0.0'}));
app.get('/',(req,res)=>res.json({service:'MiniBus Finder API v5',status:'running'}));

cron.schedule('0 */2 * * *',()=>runScan().catch(console.error));
setTimeout(()=>runScan().catch(console.error),3000);
const PORT=process.env.PORT||8080;
app.listen(PORT,()=>console.log(`🚌 MiniBus Finder API v5 on port ${PORT}`));
