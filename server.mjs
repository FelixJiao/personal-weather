import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3105);
const HOST = process.env.HOST || '127.0.0.1';
const API_HOST = process.env.QW_API_HOST;
const API_KEY = process.env.QW_API_KEY;

if (!API_HOST || !/^[a-z0-9.-]+$/i.test(API_HOST) || !API_KEY) {
  console.error('需要配置 QW_API_HOST 和 QW_API_KEY');
  process.exit(1);
}

const cache = new Map();
const inflight = new Map();
const requestWindows = new Map();
setInterval(() => {
  const cutoff = Date.now();
  for (const [key, window] of requestWindows) if (window.until < cutoff) requestWindows.delete(key);
  for (const [key, item] of cache) if (item.expires + 24 * 60 * 60_000 < cutoff) cache.delete(key);
}, 60_000).unref();
const paths = {
  now: ['/v7/weather/now', 10 * 60_000],
  hourly: ['/v7/weather/24h', 30 * 60_000],
  daily: ['/v7/weather/7d', 60 * 60_000],
  air: ['/v7/air/now', 30 * 60_000],
  warning: ['/v7/warning/now', 10 * 60_000],
  indices: ['/v7/indices/1d', 60 * 60_000],
};

async function qweather(path, query) {
  const url = new URL(`https://${API_HOST}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { 'X-QW-Api-Key': API_KEY, 'Accept-Encoding': 'gzip', 'User-Agent': 'personal-weather/1.0' },
    signal: AbortSignal.timeout(9000),
  });
  let body;
  try { body = await response.json(); } catch { throw new Error(`天气服务返回 HTTP ${response.status}`); }
  if (!response.ok || body.code && body.code !== '200' && body.code !== '204') {
    throw new Error(`天气服务返回 HTTP ${response.status} / ${body.code || '未知错误'}`);
  }
  return body;
}

function cached(key, ttl, load) {
  const old = cache.get(key);
  if (old && old.expires > Date.now()) return Promise.resolve(old.value);
  if (inflight.has(key)) return inflight.get(key);
  const job = load().then(value => {
    cache.set(key, { value, expires: Date.now() + ttl });
    while (cache.size > 1000) cache.delete(cache.keys().next().value);
    return value;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function allowRequest(req, cost) {
  const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  for (const [key, maximum] of [[`ip:${ip}`, 60], ['global', 600]]) {
    const window = requestWindows.get(key);
    if (window && window.until > now && window.used + cost > maximum) return false;
  }
  for (const key of [`ip:${ip}`, 'global']) {
    const window = requestWindows.get(key);
    if (window && window.until > now) window.used += cost;
    else requestWindows.set(key, { used: cost, until: now + 60_000 });
  }
  return true;
}

async function weather(location) {
  const entries = await Promise.all(Object.entries(paths).map(async ([name, [path, ttl]]) => {
    try {
      const query = { location };
      if (name === 'indices') query.type = '0';
      const body = await cached(`${name}:${location}`, ttl, () => qweather(path, query));
      return [name, { ok: true, body }];
    } catch (error) {
      const stale = cache.get(`${name}:${location}`);
      return [name, stale ? { ok: true, body: stale.value, stale: true } : { ok: false, error: error.message }];
    }
  }));
  const result = Object.fromEntries(entries);
  if (!result.now.ok && !result.daily.ok) throw new Error('暂时无法获取该城市的天气，请稍后再试');
  const get = name => result[name].ok ? result[name].body : null;
  return {
    updatedAt: get('now')?.updateTime || get('daily')?.updateTime || new Date().toISOString(),
    stale: entries.some(([, value]) => value.stale),
    available: Object.fromEntries(entries.map(([name, value]) => [name, value.ok])),
    now: get('now')?.now || null,
    hourly: get('hourly')?.hourly || [],
    daily: get('daily')?.daily || [],
    air: get('air')?.now || null,
    warnings: get('warning')?.warning || [],
    indices: get('indices')?.daily || [],
  };
}

const files = new Map([
  ['/', 'index.html'], ['/index.html', 'index.html'], ['/style.css', 'style.css'],
  ['/app.js', 'app.js'], ['/manifest.webmanifest', 'manifest.webmanifest'],
  ['/sw.js', 'sw.js'], ['/icon.svg', 'icon.svg'], ['/apple-touch-icon.png', 'apple-touch-icon.png'],
]);
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  if (req.method !== 'GET') return sendJson(res, 405, { error: '仅支持 GET 请求' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
    if (url.pathname === '/api/weather') {
      const location = url.searchParams.get('location') || '';
      if (!/^\d{6,15}$/.test(location)) return sendJson(res, 400, { error: '无效的城市 ID' });
      if (!allowRequest(req, 6)) return sendJson(res, 429, { error: '查询过于频繁，请稍后再试' });
      return sendJson(res, 200, await weather(location));
    }
    if (url.pathname === '/api/search' || url.pathname === '/api/reverse') {
      if (!allowRequest(req, 1)) return sendJson(res, 429, { error: '查询过于频繁，请稍后再试' });
      let query;
      if (url.pathname === '/api/search') {
        query = (url.searchParams.get('q') || '').trim();
        if (query.length < 1 || query.length > 40) return sendJson(res, 400, { error: '请输入城市名称' });
      } else {
        const lonRaw = url.searchParams.get('lon');
        const latRaw = url.searchParams.get('lat');
        const lon = Number(lonRaw);
        const lat = Number(latRaw);
        if (lonRaw === null || latRaw === null || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
          return sendJson(res, 400, { error: '无效的坐标' });
        }
        query = `${lon.toFixed(4)},${lat.toFixed(4)}`;
      }
      const body = await cached(`city:${query}`, 24 * 60 * 60_000, () => qweather('/geo/v2/city/lookup', { location: query, number: '10' }));
      const locations = (body.location || []).map(({ id, name, adm1, adm2, country, lat, lon }) => ({ id, name, adm1, adm2, country, lat, lon }));
      return sendJson(res, 200, { locations });
    }
    const file = files.get(url.pathname);
    if (!file) return sendJson(res, 404, { error: '页面不存在' });
    const target = resolve(PUBLIC, file);
    const data = await readFile(target);
    const stats = await stat(target);
    res.writeHead(200, {
      'Content-Type': `${mime[extname(file)] || 'application/octet-stream'}${extname(file) === '.png' ? '' : '; charset=utf-8'}`,
      'Content-Length': data.length,
      'Cache-Control': file === 'index.html' || file === 'sw.js' ? 'no-cache' : 'public, max-age=3600',
      'Last-Modified': stats.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch (error) {
    console.error(`${url.pathname}: ${error.message}`);
    sendJson(res, 502, { error: '天气服务暂时不可用，请稍后重试' });
  }
});

server.listen(PORT, HOST, () => console.log(`Weather server listening on ${HOST}:${PORT}`));
