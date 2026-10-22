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
    // Only the page itself is public; every other path shows the site too.
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
