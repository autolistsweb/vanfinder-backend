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

// ── AUTOTRADER ──────────────────────────────────────────────
async function autotrader(postcode, maxPrice, minSeats, maxSeats) {
  const pc  = postcode ? postcode.replace(/\s/g,'+') : 'LS1+1AB';
  const url = 'https://www.autotrader.co.uk/car-search?body-type=Minibus' +
              '&maximum-seats='+maxSeats+'&minimum-seats='+minSeats+
              '&postcode='+pc+'&price-to='+maxPrice+'&radius=1500&sort=relevance';
  console.log('[AT]', url);
  try {
    const { data: html } = await axios.get(url, { headers:HDRS, timeout:25000 });

    // Try Next.js JSON first
    const jsonM = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (jsonM) {
      try {
        const nd = JSON.parse(jsonM[1]);
        const ads = nd?.props?.pageProps?.searchResults?.advertSummaries
                 || nd?.props?.pageProps?.initialData?.search?.listings || [];
        if (ads.length) {
          const out = [];
          for (const a of ads) {
            const raw = String(a?.price?.advertisedPrice || a?.pricingInfo?.price || '0');
            const price = parseInt(raw.replace(/[^0-9]/g,'')) || 0;
            if (!price || price > maxPrice) continue;
            const href = a?.href || a?.url || '/car-details/'+(a?.id||'');
            out.push({
              id: 'at_'+(a?.id||out.length), platform:'autotrader',
              title: a?.heading || a?.title || 'Minibus',
              price, year: String(a?.year||''),
              mileage: String(a?.mileage?.mileage||'').replace(/[^0-9,]/g,''),
              location: a?.sellerInfo?.town || '', seats: minSeats,
              url: href.startsWith('http') ? href : 'https://www.autotrader.co.uk'+href,
              imgUrl: a?.imageUrls?.[0] || a?.images?.[0]?.url || '',
              age:'just found', foundAt:Date.now()
            });
          }
          if (out.length) { console.log('[AT] JSON:', out.length); return out; }
        }
      } catch(e) {}
    }

    // Regex extraction fallback
    const ids   = [...new Set([...html.matchAll(/\/car-details\/(\d{15,20})/g)].map(m=>m[1]))];
    const imgs  = [...html.matchAll(/m\.atcdn\.co\.uk\/a\/media\/w\d+\/([a-f0-9]+)\.jpg/g)].map(m=>m[1]);
    const text  = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    const chunks = text.split(/Save\s+advert/i);
    console.log('[AT] IDs:'+ids.length+' imgs:'+imgs.length+' chunks:'+chunks.length);

    const out = [];
    chunks.forEach((chunk, ci) => {
      if (ci === 0 || ci > ids.length) return;
      const id = ids[ci-1];
      const pm = chunk.match(/£(\d{1,2},\d{3})/);
      const price = pm ? parseInt(pm[1].replace(',','')) : 0;
      if (!price || price > maxPrice) return;
      const ym = chunk.match(/\b(200[0-9]|201[0-9]|202[0-5])\b/);
      const mm = chunk.match(/([\d,]+)\s+miles(?!\s*\))/i);
      const lm = chunk.match(/([A-Za-z][A-Za-z\s]+?)\s*\(\d{2,3}\s+miles\)/);
      const loc = lm ? lm[1].replace(/Dealer location|Private seller/gi,'').trim() : '';
      const tm  = chunk.match(/right\d+\/\d+\s*((?:Ford|Mercedes|Volkswagen|Peugeot|Vauxhall|Renault|Iveco|Citroen|Toyota|Fiat)[^£\n]{5,60}?)(?:£|\d\.)/i);
      const hi  = chunk.match(/(?:PSV|D1|class\s*5|section\s*19)[^\n]{0,80}/i);
      const imgHash = imgs[(ci-1)*4] || imgs[ci-1] || '';
      out.push({
        id:'at_'+id, platform:'autotrader',
        title: tm ? tm[1].trim().replace(/\s+/g,' ') : 'Minibus',
        price, year: ym?ym[1]:'', mileage: mm?mm[1]:'',
        location: loc, seats: minSeats,
        url: 'https://www.autotrader.co.uk/car-details/'+id,
        imgUrl: imgHash ? 'https://m.atcdn.co.uk/a/media/w600/'+imgHash+'.jpg' : '',
        highlights: hi ? hi[0].trim() : '',
        age:'just found', foundAt:Date.now()
      });
    });
    console.log('[AT] Regex:', out.length);
    if (out.length) return out;
    return [portal('autotrader','AutoTrader — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,url,minSeats)];
  } catch(e) {
    console.error('[AT]', e.message);
    return [portal('autotrader','AutoTrader — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,url,minSeats)];
  }
}

// ── EBAY ─────────────────────────────────────────────────────
async function ebay(maxPrice, minSeats, keyword) {
  const q   = minSeats+' seat minibus'+(keyword?' '+keyword:'');
  const url = 'https://www.ebay.co.uk/sch/i.html?_nkw='+encodeURIComponent(q)+
              '&_sacat=9858&_udhi='+maxPrice+'&LH_ItemCondition=3000&LH_BIN=1&_sop=10&_ipg=60';
  console.log('[eBay]', url);
  try {
    const { data } = await axios.get(url, { headers:HDRS, timeout:20000 });
    const $ = cheerio.load(data);
    const out = [];
    $('.s-item').each(function() {
      const title = $(this).find('.s-item__title').text().trim();
      if (!title || title.includes('Shop on eBay')) return;
      if (!title.toLowerCase().match(/minibus|mini.?bus|\d+\s*seat/)) return;
      const price = parseFloat($(this).find('.s-item__price').first().text().replace(/[^0-9.]/g,'')) || 0;
      if (!price || price > maxPrice) return;
      const href  = $(this).find('a.s-item__link').attr('href') || '';
      const img   = $(this).find('.s-item__image-img').attr('src') || '';
      const loc   = $(this).find('.s-item__location').text().replace('Located in:','').trim();
      const ym    = title.match(/\b(200[0-9]|201[0-9]|202[0-5])\b/);
      out.push({
        id:'eb_'+(href.match(/itm\/(\d+)/)?.[1]||out.length), platform:'ebay',
        title, price, year:ym?ym[1]:'', mileage:'', location:loc, seats:minSeats,
        url:href.split('?')[0], imgUrl:img.replace(/s-l\d+/,'s-l500'),
        age:'just found', foundAt:Date.now()
      });
    });
    console.log('[eBay]', out.length);
    if (out.length) return out;
    return [portal('ebay','eBay Motors — tap to browse '+minSeats+'-seat minibuses under £'+maxPrice,url,minSeats)];
  } catch(e) {
    console.error('[eBay]', e.message);
    const fb = 'https://www.ebay.co.uk/sch/i.html?_nkw='+encodeURIComponent(minSeats+' seat minibus')+'&_sacat=9858&_udhi='+maxPrice+'&LH_ItemCondition=3000';
    return [portal('ebay','eBay Motors — tap to browse',fb,minSeats)];
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
app.get('/', (req,res) => {
  res.json({ service:'MiniBus Finder API v6', status:'running' });
});

cron.schedule('0 */2 * * *', () => runScan({}).catch(console.error));
setTimeout(() => runScan({}).catch(console.error), 3000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('🚌 MiniBus Finder API v6 port '+PORT));
