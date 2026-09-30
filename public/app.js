const DEFAULT_CITY = { id: '101010100', name: '北京', adm1: '北京市', adm2: '北京', country: '中国' };
const STORE = 'personal-weather-v1';
const BASE = new URL('.', import.meta.url).pathname;
const $ = id => document.getElementById(id);
const saved = (() => {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
})();
const state = {
  city: validCity(saved.city) ? saved.city : DEFAULT_CITY,
  cities: Array.isArray(saved.cities) ? saved.cities.filter(validCity).slice(0, 8) : [DEFAULT_CITY],
  unit: saved.unit === 'f' ? 'f' : 'c',
  theme: ['auto', 'dark', 'light'].includes(saved.theme) ? saved.theme : 'auto',
  weather: null,
};
if (!state.cities.some(c => c.id === state.city.id)) state.cities.unshift(state.city);
let weatherController;
let searchController;
let searchTimer;
let toastTimer;
let lastFocus;

function validCity(city) { return city && /^\d{6,15}$/.test(String(city.id)) && typeof city.name === 'string'; }
function persist() {
  try { localStorage.setItem(STORE, JSON.stringify({ city: state.city, cities: state.cities, unit: state.unit, theme: state.theme })); } catch {}
}
function temp(celsius) {
  const number = Number(celsius);
  if (!Number.isFinite(number)) return '--';
  return String(Math.round(state.unit === 'f' ? number * 9 / 5 + 32 : number));
}
function dateLabel(iso, index) {
  if (index === 0) return '今天';
  if (index === 1) return '明天';
  if (!iso) return '--';
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso.slice(5, 10) : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}
function icon(code, text = '') {
  const n = Number(code);
  if (/雷/.test(text) || n >= 302 && n <= 304) return '⛈️';
  if (/雨/.test(text) || n >= 300 && n < 400) return '🌧️';
  if (/雪/.test(text) || n >= 400 && n < 500) return '❄️';
  if (/雾|霾|沙|尘/.test(text) || n >= 500 && n < 600) return '🌫️';
  if (n === 100) return '☀️';
  if (n === 150) return '🌙';
  if (n === 101 || n === 102 || n === 103 || n === 151 || n === 152 || n === 153) return '⛅';
  if (n === 104 || n === 154) return '☁️';
  return '🌤️';
}
function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
function applyTheme() {
  const light = state.theme === 'light' || state.theme === 'auto' && matchMedia('(prefers-color-scheme: light)').matches;
  document.body.classList.toggle('theme-light', light);
  document.querySelectorAll('[data-theme]').forEach(b => b.classList.toggle('selected', b.dataset.theme === state.theme));
  document.querySelectorAll('[data-unit]').forEach(b => b.classList.toggle('selected', b.dataset.unit === state.unit));
}
function renderCities() {
  $('city-name').textContent = state.city.name;
  const rail = $('saved-cities');
  rail.replaceChildren();
  for (const city of state.cities) {
    const button = node('button', `city-pill${city.id === state.city.id ? ' active' : ''}`, city.name);
    button.type = 'button';
    button.addEventListener('click', () => selectCity(city));
    rail.append(button);
  }
  const add = node('button', 'city-pill add', '+');
  add.type = 'button'; add.setAttribute('aria-label', '添加城市');
  add.addEventListener('click', openSearch);
  rail.append(add);
}
async function getJson(url, signal) {
  const response = await fetch(url, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
async function selectCity(city) {
  if (!validCity(city)) return;
  state.city = city;
  state.cities = [city, ...state.cities.filter(item => item.id !== city.id)].slice(0, 8);
  persist(); renderCities(); closeSheet('search');
  await loadWeather();
}
async function loadWeather() {
  weatherController?.abort();
  weatherController = new AbortController();
  const selected = state.city.id;
  $('updated-at').textContent = '正在更新…';
  try {
    const data = await getJson(`${BASE}api/weather?location=${encodeURIComponent(selected)}`, weatherController.signal);
    if (selected !== state.city.id) return;
    state.weather = data;
    renderWeather();
  } catch (error) {
    if (error.name === 'AbortError') return;
    $('updated-at').textContent = '更新失败';
    $('briefing-text').textContent = '天气暂时无法更新。请检查网络，稍后重新选择城市重试。';
    toast(error.message || '天气暂时不可用');
  }
}
function updateSky(now) {
  document.body.classList.remove('sky-rain', 'sky-cloud', 'sky-night');
  const code = Number(now?.icon);
  if (code >= 300 && code < 500) document.body.classList.add('sky-rain');
  else if (code >= 150 && code < 300) document.body.classList.add('sky-night');
  else if (code > 100 || /云|阴|雾/.test(now?.text || '')) document.body.classList.add('sky-cloud');
}
function renderWeather() {
  const w = state.weather;
  if (!w) return;
  const now = w.now || {};
  const today = w.daily[0] || {};
  const nearest = w.hourly[0] || {};
  updateSky(now);
  $('hero-icon').textContent = icon(now.icon || today.iconDay, now.text || today.textDay);
  $('current-temp').textContent = temp(now.temp ?? today.tempMax);
  $('hero-unit').textContent = '°';
  $('weather-summary').textContent = now.text || today.textDay || '天气待更新';
  $('feels-like').textContent = now.feelsLike ? `体感 ${temp(now.feelsLike)}° · ${now.windDir || ''} ${now.windScale || ''}级` : '查看下方的逐日预报';
  $('temp-range').textContent = `最高 ${temp(today.tempMax)}° · 最低 ${temp(today.tempMin)}°`;
  $('hero-rain').textContent = `降水概率 ${nearest.pop || 0}%`;
  const update = w.updatedAt?.slice(11, 16) || '--:--';
  $('updated-at').textContent = `${update} 更新${w.stale ? ' · 部分缓存' : ''}`;
  $('footer-updated').textContent = `${update} 更新`;
  const nowDate = new Date();
  $('day-label').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(nowDate);
  $('local-time').textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(nowDate);
  renderHourly(w.hourly);
  renderDaily(w.daily);
  renderHighlights(w);
  renderLife(w.indices);
  renderWarnings(w.warnings);
  renderBriefing(w);
}
function renderHourly(hours) {
  const box = $('hourly-list'); box.replaceChildren();
  if (!hours.length) return box.append(node('p', 'empty-note', '逐小时预报暂时不可用'));
  for (const [i, hour] of hours.entries()) {
    const item = node('div', 'hour-item');
    item.append(node('span', 'hour-time', i === 0 ? '接下来' : hour.fxTime?.slice(11, 16) || '--:--'));
    item.append(node('span', 'hour-icon', icon(hour.icon, hour.text)));
    item.append(node('span', 'hour-temp', `${temp(hour.temp)}°`));
    item.append(node('span', 'hour-pop', Number(hour.pop) > 0 ? `${hour.pop}%` : ''));
    box.append(item);
  }
}
function renderDaily(days) {
  const box = $('daily-list'); box.replaceChildren();
  if (!days.length) return box.append(node('p', 'empty-note', '七天预报暂时不可用'));
  const lows = days.map(d => Number(d.tempMin)).filter(Number.isFinite);
  const highs = days.map(d => Number(d.tempMax)).filter(Number.isFinite);
  const min = Math.min(...lows), max = Math.max(...highs), range = Math.max(max - min, 1);
  for (const [i, day] of days.entries()) {
    const row = node('div', 'day-row');
    row.append(node('span', 'day-name', dateLabel(day.fxDate, i)));
    row.append(node('span', 'day-icon', icon(day.iconDay, day.textDay)));
    row.append(node('span', 'day-condition', day.textDay || ''));
    const temps = node('span', 'day-temps');
    temps.append(node('span', 'day-low', `${temp(day.tempMin)}°`));
    const bar = node('span', 'temp-bar'); const fill = node('span');
    fill.style.width = `${Math.max(18, (Number(day.tempMax) - Number(day.tempMin)) / range * 100)}%`;
    bar.append(fill); temps.append(bar);
    temps.append(node('span', '', `${temp(day.tempMax)}°`));
    row.append(temps); box.append(row);
  }
}
function renderHighlights(w) {
  const aqi = w.air?.aqi == null ? NaN : Number(w.air.aqi);
  $('aqi-value').textContent = Number.isFinite(aqi) ? String(aqi) : '--';
  $('aqi-note').textContent = w.air?.category ? `${w.air.category} · ${w.air.primary && w.air.primary !== 'NA' ? `首要污染物 ${w.air.primary}` : '空气状况较好'}` : '空气数据暂不可用';
  $('aqi-fill').style.left = `${Number.isFinite(aqi) ? Math.min(94, Math.max(0, aqi / 300 * 100)) : 0}%`;
  $('feels-value').textContent = `${temp(w.now?.feelsLike)}°`;
  $('feels-note').textContent = w.now?.feelsLike ? `比实际气温${Number(w.now.feelsLike) >= Number(w.now.temp) ? '高' : '低'} ${Math.abs(Number(temp(w.now.feelsLike)) - Number(temp(w.now.temp)))}°` : '体感数据暂不可用';
  $('humidity-value').textContent = w.now?.humidity ? `${w.now.humidity}%` : '--%';
  $('humidity-note').textContent = w.now?.humidity == null ? '湿度数据暂不可用' : Number(w.now.humidity) > 70 ? '空气比较潮湿' : Number(w.now.humidity) < 35 ? '空气比较干燥' : '湿度较为舒适';
  $('sunrise-value').textContent = w.daily[0]?.sunrise || '--:--';
  $('sunset-value').textContent = w.daily[0]?.sunset || '--:--';
}
function renderLife(indices) {
  const wanted = [{ type: '3', emoji: '🧥', label: '穿衣' }, { type: '1', emoji: '🏃', label: '运动' }, { type: '2', emoji: '🧳', label: '旅行' }, { type: '5', emoji: '☀️', label: '紫外线' }];
  const box = $('life-list'); box.replaceChildren();
  for (const item of wanted) {
    const index = indices.find(x => x.type === item.type);
    if (!index) continue;
    const row = node('div', 'life-item');
    row.append(node('span', 'life-emoji', item.emoji));
    const copy = node('div', 'life-copy');
    copy.append(node('span', 'life-category', item.label));
    copy.append(node('strong', '', ` · ${index.category || index.name || '建议'}`));
    copy.append(node('p', '', index.text || '请关注当天的天气变化。'));
    row.append(copy); box.append(row);
  }
  if (!box.childElementCount) box.append(node('p', 'empty-note', '生活建议暂时不可用'));
}
function renderWarnings(warnings) {
  const panel = $('warning-panel'), box = $('warning-list'); box.replaceChildren();
  panel.hidden = !warnings.length;
  for (const warning of warnings) {
    const item = node('div', 'warning-item');
    item.append(node('strong', '', warning.title || warning.typeName || '天气预警'));
    item.append(node('p', '', warning.text || '请留意最新天气信息。'));
    box.append(item);
  }
}
function renderBriefing(w) {
  const today = w.daily[0] || {}, now = w.now || {};
  const highPop = Math.max(0, ...w.hourly.slice(0, 8).map(h => Number(h.pop) || 0));
  const warning = w.warnings[0];
  let message;
  if (warning) message = `${warning.typeName || '天气'}预警生效，请查看下方预警详情并留意出行安全。`;
  else if (highPop >= 55 || /雨|雪/.test(now.text || '')) message = '今天有明显降水机会，出门记得带伞，留意路面湿滑。';
  else if (Number(w.air?.aqi) > 150) message = '空气质量偏差，外出可适当减少长时间户外活动。';
  else if (Number(today.uvIndex) >= 7) message = '阳光较强，午间外出记得做好防晒和补水。';
  else if (Number(today.tempMax) >= 30) message = '今天偏热，适合把户外活动安排在早晚，记得补水。';
  else if (Number(today.tempMin) <= 10) message = '早晚偏凉，出门多带一件外套会更舒适。';
  else message = `今天${now.text || today.textDay || '天气平稳'}，${temp(today.tempMin)}–${temp(today.tempMax)}°，适合按自己的节奏安排一天。`;
  $('briefing-text').textContent = message;
}
function showSheet(kind) {
  lastFocus = document.activeElement;
  $(kind + '-backdrop').hidden = false;
  $(kind + '-sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  if (kind === 'search') { renderSearchResults(state.cities, true); $('city-search').value = ''; $('city-search').focus(); }
  else $(kind + '-close').focus();
}
function closeSheet(kind) {
  $(kind + '-backdrop').hidden = true;
  $(kind + '-sheet').hidden = true;
  document.body.style.overflow = '';
  lastFocus?.focus?.();
}
function openSearch() { showSheet('search'); }
function renderSearchResults(cities, removable = false) {
  const box = $('search-results'); box.replaceChildren();
  $('search-caption').textContent = removable ? '常用城市' : '搜索结果';
  if (!cities.length) return box.append(node('p', 'empty-note', removable ? '还没有常用城市' : '没有找到城市，试试更完整的名称'));
  for (const city of cities) {
    const row = node('button', 'result-row'); row.type = 'button';
    const place = node('span', 'result-place');
    place.append(node('strong', '', city.name));
    place.append(node('small', '', [city.adm2, city.adm1, city.country].filter((x, i, a) => x && a.indexOf(x) === i && x !== city.name).join(' · ')));
    row.append(node('span', '', '⌖'), place, node('span', 'result-arrow', '→'));
    row.addEventListener('click', () => selectCity(city));
    if (removable && state.cities.length > 1) {
      const remove = node('button', 'result-remove', '移除'); remove.type = 'button';
      remove.setAttribute('aria-label', `移除${city.name}`);
      remove.addEventListener('click', () => {
        state.cities = state.cities.filter(c => c.id !== city.id);
        if (state.city.id === city.id) selectCity(state.cities[0]);
        else { persist(); renderCities(); renderSearchResults(state.cities, true); }
      });
      const wrapper = node('div', 'result-wrapper'); wrapper.style.display = 'flex'; wrapper.style.alignItems = 'center';
      wrapper.append(row, remove); box.append(wrapper);
    } else box.append(row);
  }
}
async function doSearch(query) {
  searchController?.abort(); searchController = new AbortController();
  try {
    const data = await getJson(`${BASE}api/search?q=${encodeURIComponent(query)}`, searchController.signal);
    if ($('city-search').value.trim() === query) renderSearchResults(data.locations);
  } catch (error) {
    if (error.name !== 'AbortError') toast('搜索暂时不可用');
  }
}
function locate() {
  if (!navigator.geolocation) return toast('当前浏览器不支持定位');
  const button = $('locate-button'); button.disabled = true;
  navigator.geolocation.getCurrentPosition(async position => {
    try {
      const { longitude, latitude } = position.coords;
      const data = await getJson(`${BASE}api/reverse?lon=${longitude}&lat=${latitude}`);
      if (!data.locations.length) throw new Error('附近没有匹配的城市');
      await selectCity(data.locations[0]);
      toast(`已定位到 ${data.locations[0].name}`);
    } catch (error) { toast(error.message || '定位城市失败'); }
    finally { button.disabled = false; }
  }, error => {
    button.disabled = false;
    toast(error.code === 1 ? '请允许浏览器使用位置信息' : '定位失败，请搜索城市');
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
}

$('city-button').addEventListener('click', openSearch);
$('settings-button').addEventListener('click', () => showSheet('settings'));
for (const kind of ['search', 'settings']) {
  $(kind + '-close').addEventListener('click', () => closeSheet(kind));
  $(kind + '-backdrop').addEventListener('click', () => closeSheet(kind));
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') for (const kind of ['search', 'settings']) if (!$(kind + '-sheet').hidden) closeSheet(kind);
});
$('city-search').addEventListener('input', event => {
  clearTimeout(searchTimer);
  const query = event.target.value.trim();
  if (!query) { searchController?.abort(); renderSearchResults(state.cities, true); return; }
  searchTimer = setTimeout(() => doSearch(query), 280);
});
$('locate-button').addEventListener('click', locate);
document.querySelectorAll('[data-unit]').forEach(button => button.addEventListener('click', () => {
  state.unit = button.dataset.unit; persist(); applyTheme(); renderWeather();
}));
document.querySelectorAll('[data-theme]').forEach(button => button.addEventListener('click', () => {
  state.theme = button.dataset.theme; persist(); applyTheme();
}));
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.theme === 'auto') applyTheme(); });
applyTheme(); renderCities(); loadWeather();
if ('serviceWorker' in navigator) navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).catch(() => {});
