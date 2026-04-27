const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cron    = require('node-cron');
const cors    = require('cors');

const app = express();
app.use(cors({ origin:'*', methods:['GET','POST','OPTIONS'], allowedHeaders:['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

let store = [];
let lastScan = null;

const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Upgrade-Insecure-Requests': '1',
};

function age(ts) {
  const d = Date.now() - ts;
  if (d < 3600000) return Math.floor(d/60000) + 'm ago';
  if (d < 86400000) return Math.floor(d/3600000) + 'h ago';
  return Math.floor(d/86400000) + 'd ago';
}

function portal(platform, title, url, seats) {
  return { id: platform+'_'+Date.now(), platform, title, price:0, year:'', mileage:'',
    location:'UK-wide', seats, url, imgUrl:'', age:'tap to browse',
    foundAt:Date.now(), isDirect:true };
}

// ── AUTOTRADER via Jina AI (renders JS pages server-side, free) ──
async function autotrader(postcode, maxPrice, minSeats, maxSeats) {
  const pc  = postcode ? postcode.replace(/\s/g,'+') : 'BB9+7TZ';
  const atUrl = 'https://www.autotrader.co.uk/car-search?body-type=Minibus' +
                '&maximum-seats='+maxSeats+'&minimum-seats='+minSeats+
                '&postcode='+pc+'&price-to='+maxPrice+'&radius=1500&sort=relevance';
  const jinaUrl = 'https://r.jina.ai/' + atUrl;
  console.log('[AT via Jina]', jinaUrl);
  try {
    const { data: text } = await axios.get(jinaUrl, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'text',
        'User-Agent': 'Mozilla/5.0 (compatible; MiniBusFinder/1.0)',
      },
      timeout: 30000,
    });

    console.log('[AT] Jina response length:', text.length);

    // Extract listing IDs (car-details URLs)
    const ids = [...new Set([...text.matchAll(/car-details\/(\d{15,20})/g)].map(m=>m[1]))];
    // Extract image URLs from atcdn CDN
    const imgs = [...text.matchAll(/m\.atcdn\.co\.uk\/a\/media\/[^"'\s]+\/([a-f0-9]+)\.jpg/g)].map(m=>m[1]);
    console.log('[AT] IDs:', ids.length, 'imgs:', imgs.length);

    if (!ids.length) {
      console.log('[AT] No IDs found, returning portal');
      return [portal('autotrader','AutoTrader — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,atUrl,minSeats)];
    }

    // Split text into per-listing chunks
    // Jina returns markdown — listings are separated by horizontal rules or headings
    const chunks = text.split(/(?=\[.*?\]\(.*?car-details)/g);
    const out = [];

    ids.forEach((id, idx) => {
      // Find the chunk containing this listing ID
      const chunk = chunks.find(c => c.includes(id)) || chunks[idx] || '';

      const pm = chunk.match(/£(\d{1,2},\d{3})/);
      const price = pm ? parseInt(pm[1].replace(',','')) : 0;
      if (!price || price > maxPrice) return;

      const ym = chunk.match(/\b(200[0-9]|201[0-9]|202[0-5])\b/);
      const mm = chunk.match(/([\d,]+)\s*miles(?!\s*\))/i);
      const lm = chunk.match(/([A-Za-z][A-Za-z\s]+?)\s*\(\d{2,3}\s*miles\)/);
      const loc = lm ? lm[1].replace(/Dealer|Private|location/gi,'').trim() : '';
      const tm  = chunk.match(/(?:Ford|Mercedes|Volkswagen|Peugeot|Vauxhall|Renault|Iveco|Citroen|Toyota|Fiat)\s+\w+[^£\n]{0,60}/i);
      const hi  = chunk.match(/(?:PSV|D1|class\s*5|Section\s*19)[^\n]{0,80}/i);
      const imgHash = imgs[idx] || imgs[idx*2] || '';

      out.push({
        id:'at_'+id, platform:'autotrader',
        title: tm ? tm[0].trim().replace(/\s+/g,' ').slice(0,80) : 'Minibus',
        price, year: ym?ym[1]:'', mileage: mm?mm[1]:'',
        location: loc, seats: minSeats,
        url: 'https://www.autotrader.co.uk/car-details/'+id,
        imgUrl: imgHash ? 'https://m.atcdn.co.uk/a/media/w600/'+imgHash+'.jpg' : '',
        highlights: hi ? hi[0].trim() : '',
        age:'just found', foundAt:Date.now()
      });
    });

    console.log('[AT] Parsed:', out.length, 'real listings');
    if (out.length) return out;
    return [portal('autotrader','AutoTrader — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,atUrl,minSeats)];
  } catch(e) {
    console.error('[AT]', e.message);
    return [portal('autotrader','AutoTrader — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,atUrl,minSeats)];
  }
}

// ── EBAY via Jina AI ─────────────────────────────────────────
async function ebay(maxPrice, minSeats, keyword) {
  const q      = minSeats+' seat minibus'+(keyword?' '+keyword:'');
  const ebayUrl = 'https://www.ebay.co.uk/sch/i.html?_nkw='+encodeURIComponent(q)+
                  '&_sacat=9858&_udhi='+maxPrice+'&LH_ItemCondition=3000&_ipg=60';
  const jinaUrl = 'https://r.jina.ai/'+ebayUrl;
  console.log('[eBay via Jina]', jinaUrl);
  try {
    const { data: text } = await axios.get(jinaUrl, {
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'User-Agent': 'Mozilla/5.0 (compatible; MiniBusFinder/1.0)' },
      timeout: 30000,
    });
    console.log('[eBay] Jina length:', text.length);

    // Extract eBay item IDs from URLs
    const ids = [...new Set([...text.matchAll(/\/itm\/(\d{12,15})/g)].map(m=>m[1]))];
    const imgs = [...text.matchAll(/i\.ebayimg\.com\/[^"'\s]+\/s-l(\d+)\.jpg/g)];
    console.log('[eBay] IDs:', ids.length);

    if (!ids.length) {
      return [portal('ebay','eBay Motors — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,ebayUrl,minSeats)];
    }

    // Split text into per-listing sections
    const lines = text.split('\n');
    const out = [];
    const seenIds = new Set();

    ids.forEach((id) => {
      if (seenIds.has(id)) return;
      seenIds.add(id);

      // Find lines around this listing ID
      const idx = lines.findIndex(l => l.includes(id));
      if (idx === -1) return;
      const chunk = lines.slice(Math.max(0, idx-5), idx+10).join(' ');

      const pm = chunk.match(/£(\d{1,2},\d{3})/);
      const price = pm ? parseInt(pm[1].replace(',','')) : 0;
      if (!price || price > maxPrice) return;

      const tm = chunk.match(/(?:Ford|Mercedes|Volkswagen|Peugeot|Vauxhall|Renault|Iveco)[^\n£]{5,80}/i);
      const ym = chunk.match(/\b(200[0-9]|201[0-9]|202[0-5])\b/);
      const lm = chunk.match(/(?:Located in:|location:)\s*([A-Za-z][A-Za-z\s,]+?)(?:\||$)/i);

      out.push({
        id:'eb_'+id, platform:'ebay',
        title: tm ? tm[0].trim().replace(/\s+/g,' ').slice(0,80) : q,
        price, year: ym?ym[1]:'', mileage:'',
        location: lm?lm[1].trim():'UK', seats:minSeats,
        url: 'https://www.ebay.co.uk/itm/'+id,
        imgUrl: '',
        age:'just found', foundAt:Date.now()
      });
    });

    console.log('[eBay] Parsed:', out.length);
    if (out.length) return out;
    return [portal('ebay','eBay Motors — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,ebayUrl,minSeats)];
  } catch(e) {
    console.error('[eBay]', e.message);
    return [portal('ebay','eBay Motors — tap to browse',
      'https://www.ebay.co.uk/sch/i.html?_nkw='+encodeURIComponent(minSeats+' seat minibus')+'&_sacat=9858&_udhi='+maxPrice,minSeats)];
  }
}

// ── PORTALS (direct links) ────────────────────────────────────
function gumtree(maxPrice, minSeats, keyword) {
  const q = minSeats+'+seat+minibus'+(keyword?'+'+encodeURIComponent(keyword):'');
  return [portal('gumtree','Gumtree — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,
    'https://www.gumtree.com/cars-vans-motorbikes/uk/'+q+'?max_price='+maxPrice+'&vehicle_type=minibus',minSeats)];
}
function motors(postcode, maxPrice, minSeats, wholeUK) {
  const pc = (wholeUK||!postcode) ? 'LS1+1AB' : postcode.replace(/\s/g,'+');
  return [portal('motors','Motors.co.uk — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,
    'https://www.motors.co.uk/search/car/results/?Bodystyle=Minibus&PriceMax='+maxPrice+'&Postcode='+pc+'&Distance=National',minSeats)];
}
function preloved(maxPrice, minSeats, keyword) {
  const kw = minSeats+'+seat+minibus'+(keyword?'+'+encodeURIComponent(keyword):'');
  return [portal('preloved','Preloved — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,
    'https://www.preloved.co.uk/adverts/list/236/cars?keywords='+kw+'&price_max='+maxPrice+'&distance=national',minSeats)];
}
function facebook(maxPrice, minSeats, keyword) {
  const q = encodeURIComponent(minSeats+' seat minibus'+(keyword?' '+keyword:''));
  return [{...portal('facebook','Facebook Marketplace — tap to browse (personal login required)',
    'https://www.facebook.com/marketplace/search?query='+q+'&maxPrice='+maxPrice,minSeats),
    note:'Must be logged into a personal Facebook account'}];
}
function shpock(maxPrice, minSeats, keyword) {
  const q = encodeURIComponent(minSeats+' seat minibus'+(keyword?' '+keyword:''));
  return [portal('shpock','Shpock — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,
    'https://www.shpock.com/en-gb/search?q='+q+'&categories=vehicles&priceMax='+maxPrice,minSeats)];
}
function buscoach(minSeats) {
  return [portal('buscoach','Bus & Coach Buyer — PSV specialist — tap to browse',
    'https://classifieds.busandcoachbuyer.com/classifieds/minibuses/',minSeats)];
}
function cazoo(maxPrice, minSeats) {
  return [portal('cazoo','Cazoo — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,
    'https://www.cazoo.co.uk/vans/minibus/?price_to='+maxPrice+'&seats_min='+minSeats,minSeats)];
}
function commercialmotor(maxPrice, minSeats) {
  return [portal('commercialmotor','Commercial Motor — tap to browse minibuses under £'+maxPrice,
    'https://www.commercialmotor.com/used-trucks/bt/mpv-minibus?pricemax='+maxPrice,minSeats)];
}

// ── RUN SCAN ─────────────────────────────────────────────────
async function runScan(params) {
  const p = params || {};
  const maxPrice  = parseInt(p.maxPrice)  || 5000;
  const minSeats  = parseInt(p.minSeats)  || 17;
  const maxSeats  = parseInt(p.maxSeats)  || 17;
  const postcode  = (p.postcode||'BB97TZ').replace(/NATIONWIDE/i,'LS11AB').trim();
  const keyword   = (p.keyword||'').trim();
  const wholeUK   = p.wholeUK==='true' || p.wholeUK===true;
  const rawPlats  = p.platforms || 'autotrader,gumtree,ebay,motors,preloved,facebook,shpock';
  const plats     = typeof rawPlats==='string' ? rawPlats.split(',') : rawPlats;

  console.log('\n🔍 platforms:'+plats.join(',')+'  postcode:'+postcode+'  max:£'+maxPrice+' seats:'+minSeats+'-'+maxSeats);

  const jobs = [];
  for (const pl of plats) {
    if (pl==='autotrader')     jobs.push(autotrader(postcode, maxPrice, minSeats, maxSeats));
    else if (pl==='ebay')      jobs.push(ebay(maxPrice, minSeats, keyword));
    else if (pl==='gumtree')   jobs.push(Promise.resolve(gumtree(maxPrice, minSeats, keyword)));
    else if (pl==='motors')    jobs.push(Promise.resolve(motors(postcode, maxPrice, minSeats, wholeUK)));
    else if (pl==='preloved')  jobs.push(Promise.resolve(preloved(maxPrice, minSeats, keyword)));
    else if (pl==='facebook')  jobs.push(Promise.resolve(facebook(maxPrice, minSeats, keyword)));
    else if (pl==='shpock')    jobs.push(Promise.resolve(shpock(maxPrice, minSeats, keyword)));
    else if (pl==='buscoach')  jobs.push(Promise.resolve(buscoach(minSeats)));
    else if (pl==='cazoo')     jobs.push(Promise.resolve(cazoo(maxPrice, minSeats)));
    else if (pl==='commercialmotor') jobs.push(Promise.resolve(commercialmotor(maxPrice, minSeats)));
  }

  const results = await Promise.allSettled(jobs);
  let all = [];
  results.forEach(r => { if (r.status==='fulfilled') all = all.concat(r.value); });
  all = all.map(l => ({ ...l, age: age(l.foundAt) }));
  all.sort((a,b) => {
    if (a.isDirect && !b.isDirect) return 1;
    if (!a.isDirect && b.isDirect) return -1;
    return a.price - b.price;
  });

  store = all;
  lastScan = new Date().toISOString();
  const real = all.filter(l=>!l.isDirect).length;
  console.log('✅ total:'+all.length+' real:'+real+'\n');
  return all;
}

// ── API ───────────────────────────────────────────────────────
app.get('/api/listings', async (req,res) => {
  try {
    const listings = await runScan(req.query);
    res.json({ listings, lastScan, count:listings.length });
  } catch(e) {
    console.error('API error:', e);
    res.status(500).json({ error:e.message, listings:[] });
  }
});
app.get('/api/scan', async (req,res) => {
  try {
    const listings = await runScan(req.query);
    res.json({ listings, lastScan, count:listings.length });
  } catch(e) { res.status(500).json({ error:e.message, listings:[] }); }
});
app.get('/api/status', (req,res) => {
  res.json({ status:'online', lastScan, listingCount:store.length, version:'6.0.0' });
});
app.get('/api/debug', async (req,res) => {
  const site = req.query.site || 'ebay';
  const urls = {
    ebay: 'https://www.ebay.co.uk/sch/i.html?_nkw=17+seat+minibus&_sacat=9858&_udhi=5000&_ipg=10',
    autotrader: 'https://www.autotrader.co.uk/car-search?body-type=Minibus&maximum-seats=17&minimum-seats=17&postcode=BB9+7TZ&price-to=5000&sort=relevance',
  };
  const url = urls[site] || urls.ebay;
  try {
    const { data, status, headers } = await axios.get(url, { headers:HDRS, timeout:20000 });
    res.json({
      httpStatus: status,
      contentLength: data.length,
      containsSItem: data.includes('s-item__title'),
      containsATListing: data.includes('car-details'),
      containsPrice: data.includes('£'),
      blockedOrCaptcha: data.includes('captcha') || data.includes('blocked') || data.includes('robot'),
      sample: data.slice(0, 2000),
    });
  } catch(e) {
    res.json({ error: e.message, httpStatus: e.response?.status, data: e.response?.data?.slice?.(0,500) });
  }
});
app.get('/', (req,res) => {
  res.json({ service:'MiniBus Finder API v6', status:'running' });
});

cron.schedule('0 */2 * * *', () => runScan({}).catch(console.error));
setTimeout(() => runScan({}).catch(console.error), 3000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('🚌 MiniBus Finder API v6 port '+PORT));
