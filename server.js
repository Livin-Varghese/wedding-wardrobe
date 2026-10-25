// The Wedding Wardrobe — web server
// Serves the site from ./public and a weather API at /api/weather.
// No dependencies: needs Node.js 18+ (built-in fetch).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');

// Open-Meteo: the free API is for non-commercial use. For a commercial site,
// buy an API plan and set OPEN_METEO_API_KEY; requests then go to the customer hosts.
const OM_KEY = process.env.OPEN_METEO_API_KEY || '';
const OM = OM_KEY
  ? { geo: 'https://customer-geocoding-api.open-meteo.com', fc: 'https://customer-api.open-meteo.com', ar: 'https://customer-archive-api.open-meteo.com' }
  : { geo: 'https://geocoding-api.open-meteo.com', fc: 'https://api.open-meteo.com', ar: 'https://archive-api.open-meteo.com' };
const withKey = url => (OM_KEY ? url + '&apikey=' + encodeURIComponent(OM_KEY) : url);

// Optional: richer local notes written by Claude.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

const YEARS = 10;          // climate average over this many past years
const WINDOW_DAYS = 3;     // ± days around the wedding date in each year
const FORECAST_DAYS = 15;  // use a live forecast when the date is this close

/* ---------------- small helpers ---------------- */
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = fn().catch(err => { cache.delete(key); throw err; });
  cache.set(key, { value, until: Date.now() + ttlMs });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return value;
}
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'wedding-wardrobe' } });
  if (!res.ok) throw new Error(`Upstream ${res.status} for ${url.split('?')[0]}`);
  return res.json();
}
const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round1 = v => (v == null ? null : Math.round(v * 10) / 10);
const hourOf = t => Number(String(t).slice(11, 13));
const HOURS = { evening: [17, 22], day: [11, 16] };

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

/* ---------------- geocoding ---------------- */
async function geocode(q) {
  const parts = q.split(',').map(s => s.trim()).filter(Boolean);
  const name = parts[0];
  const url = withKey(`${OM.geo}/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`);
  const data = await cached('geo:' + name.toLowerCase(), 7 * 864e5, () => getJSON(url));
  const results = data.results || [];
  if (!results.length) return null;
  const hints = parts.slice(1).map(s => s.toLowerCase());
  const score = r => {
    const hay = [r.country, r.country_code, r.admin1, r.admin2].filter(Boolean).map(s => s.toLowerCase());
    return hints.reduce((n, h) => n + (hay.some(x => x === h || x.includes(h) || h.includes(x)) ? 1 : 0), 0);
  };
  const best = results.slice().sort((a, b) => score(b) - score(a) || (b.population || 0) - (a.population || 0))[0];
  return {
    lat: best.latitude, lon: best.longitude,
    place: [best.name, best.admin1 && best.admin1 !== best.name ? best.admin1 : null, best.country].filter(Boolean).join(', ')
  };
}

/* ---------------- weather ---------------- */
function summarise(daily, hourly, time, dates) {
  const want = new Set(dates);
  const [h0, h1] = HOURS[time];
  const highs = [], lows = [], rainDays = [], sunsets = [];
  daily.time.forEach((d, i) => {
    if (!want.has(d)) return;
    if (daily.temperature_2m_max[i] != null) highs.push(daily.temperature_2m_max[i]);
    if (daily.temperature_2m_min[i] != null) lows.push(daily.temperature_2m_min[i]);
    if (daily.precipitation_sum && daily.precipitation_sum[i] != null) rainDays.push(daily.precipitation_sum[i] >= 1 ? 1 : 0);
    if (daily.sunset && daily.sunset[i]) sunsets.push(daily.sunset[i]);
  });
  const evening = [], hum = [];
  hourly.time.forEach((t, i) => {
    if (!want.has(t.slice(0, 10))) return;
    const h = hourOf(t);
    if (h >= 18 && h <= 21 && hourly.temperature_2m[i] != null) evening.push(hourly.temperature_2m[i]);
    if (h >= h0 && h <= h1 && hourly.relative_humidity_2m[i] != null) hum.push(hourly.relative_humidity_2m[i]);
  });
  return { highs, lows, rainDays, sunsets, evening, hum };
}

async function climate(lat, lon, target, time) {
  const today = new Date();
  const latestUsable = addDays(today, -7); // the archive lags by a few days
  const reqs = [];
  for (let k = 1, y = 0; y < YEARS && k < YEARS + 3; k++) {
    const d = new Date(Date.UTC(target.getUTCFullYear() - k, target.getUTCMonth(), target.getUTCDate()));
    const end = addDays(d, WINDOW_DAYS);
    if (end > latestUsable) continue;
    y++;
    const start = addDays(d, -WINDOW_DAYS);
    const dates = [];
    for (let x = start; x <= end; x = addDays(x, 1)) dates.push(iso(x));
    const url = withKey(`${OM.ar}/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${iso(start)}&end_date=${iso(end)}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,sunset&hourly=temperature_2m,relative_humidity_2m&timezone=auto`);
    reqs.push(cached('ar:' + url, 30 * 864e5, () => getJSON(url)).then(j => summarise(j.daily, j.hourly, time, dates)));
  }
  const parts = (await Promise.allSettled(reqs)).filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!parts.length) throw new Error('No climate data returned');
  const all = k => parts.flatMap(p => p[k]);
  const sunsets = parts[0].sunsets; // most recent year
  return {
    source: 'climate', years: parts.length,
    day_high_c: round1(avg(all('highs'))), night_low_c: round1(avg(all('lows'))),
    evening_c: round1(avg(all('evening'))), humidity_pct: Math.round(avg(all('hum')) ?? 0),
    rain_chance_pct: Math.round((avg(all('rainDays')) ?? 0) * 100),
    sunset: sunsets.length ? sunsets[Math.floor(sunsets.length / 2)].slice(11, 16) : ''
  };
}

async function forecast(lat, lon, target, time) {
  const d = iso(target);
  const url = withKey(`${OM.fc}/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${d}&end_date=${d}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunset&hourly=temperature_2m,relative_humidity_2m&timezone=auto`);
  const j = await cached('fc:' + url, 3 * 3600e3, () => getJSON(url));
  const s = summarise(j.daily, j.hourly, time, [d]);
  return {
    source: 'forecast', years: 0,
    day_high_c: round1(s.highs[0]), night_low_c: round1(s.lows[0]),
    evening_c: round1(avg(s.evening)), humidity_pct: Math.round(avg(s.hum) ?? 0),
    rain_chance_pct: Math.round(j.daily.precipitation_probability_max?.[0] ?? 0),
    sunset: s.sunsets[0] ? s.sunsets[0].slice(11, 16) : ''
  };
}

/* ---------------- advice ---------------- */
function classify(w) {
  const high = w.day_high_c ?? 20;
  if (high >= 27 && w.humidity_pct >= 60) return 'hot';
  if (high >= 25) return 'dry';
  if (high >= 13) return 'mild';
  return 'cold';
}
function seasonNote(w, lat, month, cls) {
  if (Math.abs(lat) < 23.5) return w.rain_chance_pct >= 45 ? 'Rainy season' : 'Dry season';
  const north = lat >= 0;
  const s = [[11, 0, 1], [2, 3, 4], [5, 6, 7], [8, 9, 10]].findIndex(g => g.includes(month));
  const names = north ? ['Winter', 'Spring', 'Summer', 'Autumn'] : ['Summer', 'Autumn', 'Winter', 'Spring'];
  return names[s] + (cls === 'hot' ? ', hot and humid' : '');
}
const FABRICS = { hot: ['chiffon', 'linen'], dry: ['organza', 'tropical'], mild: ['tulle', 'tropical'], cold: ['satin', 'velvet'] };
function ruleAdvice(w, cls, time, venue) {
  const tips = {
    hot: ['Choose breathable chiffon, organza or crepe, and skip heavy satin.', 'A linen–wool or tropical wool suit, half-lined, keeps the wearer cooler.', 'Keep the train short or bustled for outdoor photos.'],
    dry: ['Light, structured fabrics like organza and crepe hold their shape in dry heat.', 'A lighter suit colour stays cooler in direct sun.', 'Plan shade for the ceremony and portraits.'],
    mild: ['Almost any fabric works, so choose by look and formality.', 'Bring a light layer, such as a bolero or shawl, for after dark.', 'A waistcoat adds polish without overheating.'],
    cold: ['Satin, mikado and brocade keep you warm and look rich.', 'Long lace sleeves or a wrap for the gown; a three-piece or velvet jacket for the suit.', 'Have warm coats ready for outdoor photos.']
  }[cls].slice();
  const notes = [];
  if (w.sunset) notes.push(time === 'evening'
    ? `Sunset is around ${w.sunset}. Book portraits 30–45 minutes before for golden light.`
    : `Sunset is around ${w.sunset}, so daylight lasts until then for photos.`);
  if (w.rain_chance_pct >= 30) notes.push(`Rain is fairly likely (${w.rain_chance_pct}%). Have a wet-weather plan and clear umbrellas.`);
  else notes.push(`Rain is unlikely (${w.rain_chance_pct}% of days), but a backup plan is still wise.`);
  if (w.humidity_pct >= 70) notes.push('High humidity: use long-wear make-up and setting spray, and allow for frizz.');
  else if (venue !== 'indoor' && cls !== 'cold') notes.push('Outdoors, think about shade, water for guests and insect repellent at dusk.');
  else notes.push('Indoors, check the venue’s air conditioning or heating for the evening.');
  return { outfit_tips: tips, local_notes: notes.slice(0, 3), notes_source: 'rules' };
}
async function claudeAdvice(place, dateStr, time, venue, w, cls) {
  const prompt = `Wedding in ${place} on ${dateStr} (${time}, venue: ${venue}). Typical conditions: day high ${w.day_high_c}°C, evening ${w.evening_c}°C, humidity ${w.humidity_pct}%, rain chance ${w.rain_chance_pct}%, sunset ${w.sunset}.
Reply with only JSON: {"outfit_tips":[3 short tips for the gown and suit],"local_notes":[3 short practical or cultural notes for a wedding in this place at this time of year]}. Each item under 25 words.`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) throw new Error('Claude API ' + res.status);
  const j = await res.json();
  const text = (j.content || []).map(c => c.text || '').join('');
  const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  if (!Array.isArray(parsed.outfit_tips) || !Array.isArray(parsed.local_notes)) throw new Error('Bad shape');
  return { outfit_tips: parsed.outfit_tips.slice(0, 3).map(String), local_notes: parsed.local_notes.slice(0, 3).map(String), notes_source: 'claude' };
}

async function weather(q, dateStr, time, venue) {
  const geo = await geocode(q);
  if (!geo) return { status: 404, body: { error: 'not_found', message: 'We couldn’t find that place. Try adding the region or country.' } };
  const [Y, M, D] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(Y, M - 1, D));
  const todayUTC = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const daysAway = Math.round((target - todayUTC) / 864e5);
  let w;
  if (daysAway >= 0 && daysAway <= FORECAST_DAYS) {
    try { w = await forecast(geo.lat, geo.lon, target, time); } catch { w = null; }
  }
  if (!w) w = await climate(geo.lat, geo.lon, target, time);
  if (w.evening_c == null) w.evening_c = w.day_high_c;
  const cls = classify(w);
  let advice = ruleAdvice(w, cls, time, venue);
  if (ANTHROPIC_KEY) {
    try { advice = await cached(`ai:${geo.place}:${dateStr}:${time}:${venue}`, 7 * 864e5, () => claudeAdvice(geo.place, dateStr, time, venue, w, cls)); }
    catch (e) { console.warn('Claude advice failed, using rules:', e.message); }
  }
  const [gown_fabric, suit_fabric] = FABRICS[cls];
  return { status: 200, body: { recognised: true, place: geo.place, lat: geo.lat, lon: geo.lon, ...w, climate: cls,
    season_note: seasonNote(w, geo.lat, M - 1, cls), gown_fabric, suit_fabric, ...advice } };
}


/* ---------------- app assets (installable app) ---------------- */
const MANIFEST = JSON.stringify({
  name: 'The Wedding Wardrobe', short_name: 'Wardrobe', description: 'Design your wedding gown and suit together.',
  start_url: '/#home', scope: '/', display: 'standalone', background_color: '#000000', theme_color: '#000000', orientation: 'portrait',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }]
});
const SW = `const C='ww-v2';
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/manifest.webmanifest','/icon-192.png'])));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(u.pathname==='/'||u.pathname==='/index.html'?'/':e.request,cp));return r;}).catch(()=>caches.match(u.pathname==='/index.html'?'/':e.request).then(m=>m||caches.match('/'))));});`;
const ICON192 = Buffer.from('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', 'base64');
const ICON512 = Buffer.from('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', 'base64');

/* ---------------- http ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };

const hits = new Map(); // tiny per-IP rate limit for the API
function limited(ip) {
  const now = Date.now(), h = hits.get(ip) || [];
  const recent = h.filter(t => now - t < 60e3);
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 20;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname === '/api/weather') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (limited(ip)) return send(res, 429, { error: 'rate_limited', message: 'Too many lookups. Please wait a minute.' });
      const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
      const date = url.searchParams.get('date') || '';
      const time = url.searchParams.get('time') === 'day' ? 'day' : 'evening';
      const venue = ['indoor', 'outdoor', 'mixed'].includes(url.searchParams.get('venue')) ? url.searchParams.get('venue') : 'mixed';
      if (!q) return send(res, 400, { error: 'missing_location', message: 'Enter a location first.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) return send(res, 400, { error: 'bad_date', message: 'Add a valid wedding date.' });
      const r = await cached(`w:${q.toLowerCase()}:${date}:${time}:${venue}`, 6 * 3600e3, () => weather(q, date, time, venue));
      return send(res, r.status, r.body, { 'Cache-Control': 'private, max-age=600', ...SEC });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (url.pathname === '/manifest.webmanifest') return send(res, 200, MANIFEST, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=3600', ...SEC });
    if (url.pathname === '/sw.js') return send(res, 200, SW, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/', ...SEC });
    if (url.pathname === '/icon-192.png') return send(res, 200, ICON192, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800', ...SEC });
    if (url.pathname === '/icon-512.png') return send(res, 200, ICON512, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800', ...SEC });
    // Only the app page is public; every other path shows the app too.
    fs.readFile(INDEX, (e2, buf) => {
      if (e2) return send(res, 500, 'index.html is missing');
      send(res, 200, buf, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC });
    });
  } catch (e) {
    console.error(e);
    send(res, 502, { error: 'upstream', message: 'Weather service is unavailable right now. Please try again shortly.' });
  }
});

if (require.main === module) server.listen(PORT, () => console.log(`The Wedding Wardrobe running on http://localhost:${PORT}`));
module.exports = { server, weather, classify, ruleAdvice };
