const $ = (selector) => document.querySelector(selector);

const els = {
  map: $('#map'),
  mode: $('#mode-label'),
  dest: $('#dest-label'),
  destNote: $('#dest-note'),
  locate: $('#locate-btn'),
  sheet: $('#sheet'),
  dot: $('#status-dot'),
  statusText: $('#status-text'),
  statusSub: $('#status-sub'),
  retry: $('#retry-btn'),
  manualLink: $('#manual-link'),
  form: $('#origin-form'),
  input: $('#origin-input'),
  error: $('#origin-error'),
  offlineNote: $('#offline-note'),
  banner: $('#alert-banner'),
  bannerTitle: $('#alert-title'),
  bannerSub: $('#alert-sub'),
  routePanel: $('#route-panel'),
  routeTitle: $('#route-title'),
  routeTag: $('#route-tag'),
  routeSummary: $('#route-summary'),
  routeNote: $('#route-note'),
  routeOptions: $('#route-options'),
  routeSafety: $('#route-safety'),
  routeStops: $('#route-stops'),
  routeRemind: $('#route-remind'),
  boardName: $('#board-name'),
  alightName: $('#alight-name'),
  threshold: $('#threshold'),
  testAlert: $('#test-alert'),
  remindStatus: $('#remind-status'),
  gasBtn: $('#gas-btn'),
  gasChip: $('#gas-chip'),
  gasChipName: $('#gas-chip-name'),
  gasPanel: $('#gas-panel'),
  gasClose: $('#gas-close'),
  gasRefresh: $('#gas-refresh'),
  gasStatus: $('#gas-status'),
  gasList: $('#gas-list'),
  gasWaypoint: $('#gas-waypoint'),
  gasWaypointName: $('#gas-waypoint-name'),
  gasClear: $('#gas-clear'),
  weatherPanel: $('#weather-panel'),
  weatherTemp: $('#weather-temp'),
  weatherText: $('#weather-text'),
  weatherRain: $('#weather-rain'),
};

const TRIP_KEY = 'zenmap:trip';
const THRESHOLD_KEY = 'zenmap:threshold';
const GEO_TTL = 7 * 24 * 60 * 60 * 1000;
const ROUTE_TTL = 30 * 60 * 1000;
const FUEL_TTL = 10 * 60 * 1000;
const WEATHER_TTL = 20 * 60 * 1000;
const MODE_LABEL = { transit: '公交地铁', drive: '自驾', walk: '步行' };
const MODE_TITLE = { transit: '公交路线', drive: '驾车路线', walk: '步行路线' };
const PLACE_FALLBACK = {
  北京站: { lat: 39.9051, lng: 116.4228, label: '北京站', city: '北京市' },
  北京西站: { lat: 39.894, lng: 116.3151, label: '北京西站', city: '北京市' },
  北京南站: { lat: 39.8646, lng: 116.3709, label: '北京南站', city: '北京市' },
  虹桥火车站: { lat: 31.196, lng: 121.314, label: '虹桥火车站', city: '上海市' },
  人民广场: { lat: 31.234, lng: 121.471, label: '人民广场', city: '上海市' },
  外滩: { lat: 31.235, lng: 121.488, label: '外滩', city: '上海市' },
  上海南站: { lat: 31.155, lng: 121.426, label: '上海南站', city: '上海市' },
  广州塔: { lat: 23.109, lng: 113.318, label: '广州塔', city: '广州市' },
  深圳湾公园: { lat: 22.524, lng: 113.988, label: '深圳湾公园', city: '深圳市' },
  杭州东站: { lat: 30.294, lng: 120.208, label: '杭州东站', city: '杭州市' },
  西安北站: { lat: 34.381, lng: 108.934, label: '西安北站', city: '西安市' },
  成都东站: { lat: 30.631, lng: 104.139, label: '成都东站', city: '成都市' },
};
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a>';
const SAFETY_DISCLAIMER = '安全评分基于演示数据与启发式估算，仅供参考';
const TILE_SOURCES = [
  { url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png', maxZoom: 19 },
  { url: 'https://a.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', maxZoom: 19 },
];

const trip = readTrip();
const state = {
  origin: null,
  originManual: false,
  originCity: '',
  dest: null,
  destCity: '',
  watchId: null,
  viewMode: 'none',
  lastFix: null,
  route: null,
  routePending: false,
  planToken: 0,
  routeLayers: [],
  routeCandidates: [],
  selectedRouteIndex: 0,
  bannerTimer: 0,
  engine: null,
  fuel: { loading: false, key: '', list: [], selectedId: '', layers: [] },
  weather: { loading: false, key: '' },
};

let map = null;
let originMarker = null;
let destinationMarker = null;
let accuracyCircle = null;
let originIcon = null;
let manualIcon = null;
let destinationIcon = null;
let tileLayer = null;
let tileIndex = 0;
let tileErrors = 0;

function readTrip() {
  try {
    return JSON.parse(sessionStorage.getItem(TRIP_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function readStorage(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    sessionStorage.setItem(key, String(value));
  } catch {}
}

function isTransit() {
  return trip?.mode === 'transit';
}

function isDrive() {
  return trip?.mode === 'drive';
}

function wantsRoute() {
  return isTransit() || isDrive();
}

function ink() {
  return getComputedStyle(document.documentElement).getPropertyValue('--z-ink').trim() || '#0a0a0a';
}

function ghost() {
  return getComputedStyle(document.documentElement).getPropertyValue('--z-ghost').trim() || '#737373';
}

function sheetHeight() {
  return els.sheet ? els.sheet.offsetHeight : 0;
}

function formatMeters(meters) {
  if (!Number.isFinite(meters)) return '—';
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(meters))} m`;
}

function render(kind, payload = {}) {
  const line = kind === 'ok' ? `已定位 ±${payload.accuracy} m` : kind === 'manual' ? `起点：${payload.label}` : STATUS[kind]()[0];
  const sub = kind === 'ok' ? '定位实时更新' : kind === 'manual' ? '手动设置 · 未使用实时定位' : STATUS[kind]()[1];

  els.statusText.textContent = line;
  els.statusSub.textContent = sub;
  els.dot.hidden = kind !== 'locating';
  els.retry.hidden = !['denied', 'timeout', 'unavailable', 'manual'].includes(kind);
  els.retry.textContent = kind === 'manual' ? '改用定位' : '重试定位';

  if (kind === 'manual') hideForm();
  if (FAILURES.includes(kind)) showForm(false);

  els.manualLink.hidden = kind === 'manual' || !els.form.hidden;
}

const STATUS = {
  locating: () => ['正在获取位置…', '首次使用请允许位置权限'],
  denied: () => ['位置权限被拒绝', '允许权限后重试，或手动设置起点'],
  timeout: () => ['定位超时', '到开阔处重试，或手动设置起点'],
  unavailable: () => ['暂时无法获取位置', '检查系统定位开关后重试，或手动设置起点'],
  insecure: () => ['无法使用定位', '需 HTTPS 或 localhost 打开；可手动设置起点'],
  unsupported: () => ['此浏览器不支持定位', '请手动设置起点'],
};

const FAILURES = ['denied', 'timeout', 'unavailable', 'insecure', 'unsupported'];

function showForm(focus) {
  els.form.hidden = false;
  els.error.hidden = true;
  els.manualLink.hidden = true;
  if (focus) els.input.focus({ preventScroll: true });
}

function hideForm() {
  els.form.hidden = true;
  els.input.value = '';
  els.error.hidden = true;
  els.manualLink.hidden = state.originManual;
}

function startWatch() {
  if (!('geolocation' in navigator)) {
    render('unsupported');
    return;
  }
  if (!window.isSecureContext) {
    render('insecure');
    return;
  }

  stopWatch();
  hideForm();
  render('locating');

  try {
    state.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    });
  } catch {
    render('unavailable');
  }
}

function stopWatch() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
}

function onFix(position) {
  if (!els.form.hidden) return;
  const { latitude: lat, longitude: lng, accuracy } = position.coords;
  const fix = { lat, lng, accuracy, timestamp: position.timestamp || Date.now() };
  state.lastFix = fix;
  setOrigin(L.latLng(lat, lng), { manual: false, accuracy });
  render('ok', { accuracy: Math.round(accuracy) });
  considerView();
  if (isTransit()) {
    maybePlanRoute();
    feedReminder(fix);
  }
  if (isDrive()) maybePlanRoute();
  if (trip?.mode === 'walk') loadWeather();
}

function onGeoError(error) {
  stopWatch();
  if (error.code === 1) {
    render('denied');
  } else if (error.code === 3) {
    render('timeout');
  } else {
    render('unavailable');
  }
}

function setOrigin(latlng, { manual, accuracy = 0 }) {
  state.origin = latlng;
  state.originManual = manual;

  if (!originMarker) {
    originMarker = L.marker(latlng, {
      icon: manual ? manualIcon : originIcon,
      keyboard: false,
      zIndexOffset: 400,
    }).addTo(map);
  } else {
    originMarker.setLatLng(latlng);
    originMarker.setIcon(manual ? manualIcon : originIcon);
  }

  if (manual || accuracy <= 0) {
    if (accuracyCircle) {
      accuracyCircle.remove();
      accuracyCircle = null;
    }
    return;
  }

  const color = ink();
  if (!accuracyCircle) {
    accuracyCircle = L.circle(latlng, {
      radius: accuracy,
      color,
      weight: 1,
      opacity: 0.3,
      fillColor: color,
      fillOpacity: 0.05,
      interactive: false,
    }).addTo(map);
  } else {
    accuracyCircle.setLatLng(latlng);
    accuracyCircle.setRadius(accuracy);
  }
}

function considerView() {
  if (state.route || state.viewMode === 'both') return;
  const { origin, dest } = state;

  if (origin && dest) {
    state.viewMode = 'both';
    if (origin.distanceTo(dest) < 30) {
      map.setView(origin, 16);
      return;
    }
    map.fitBounds(L.latLngBounds(origin, dest).pad(0.35), {
      paddingTopLeft: [36, 96],
      paddingBottomRight: [36, sheetHeight() + 24],
      maxZoom: 15,
    });
  } else if (origin) {
    state.viewMode = 'origin';
    map.setView(origin, 15);
  } else if (dest) {
    state.viewMode = 'dest';
    map.setView(dest, 13);
  }
}

async function resolveDestination() {
  els.destNote.hidden = false;
  els.destNote.textContent = '正在定位目的地…';
  try {
    const place = await geocode(trip.destination);
    const latlng = L.latLng(place.lat, place.lng);
    state.dest = latlng;
    state.destCity = place.city || '';
    destinationMarker = L.marker(latlng, { icon: destinationIcon, keyboard: false }).addTo(map);
    els.destNote.hidden = true;
    considerView();
    if (wantsRoute()) maybePlanRoute();
    if (trip?.mode === 'walk') loadWeather();
  } catch {
    els.destNote.hidden = false;
    els.destNote.textContent = '地图上暂未找到该地点';
  }
}

async function geocode(query) {
  const cacheKey = `zenmap:geo:v1:${query.toLowerCase()}`;
  const cached = ZenStore.get(cacheKey, GEO_TTL);
  if (cached) return cached;

  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1`;
    const data = await ZenNet.fetchJson(url, { timeout: 9000, retries: 1 });
    const feature = data?.features?.[0];
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) throw new Error('geocode-empty');

    const [lng, lat] = coordinates;
    const props = feature.properties ?? {};
    const place = { lat, lng, label: props.name || props.street || query, city: props.state || props.city || '' };
    ZenStore.set(cacheKey, place);
    return place;
  } catch (error) {
    const stale = ZenStore.getStale(cacheKey);
    if (stale) return stale;
    const fallback = PLACE_FALLBACK[query.trim().toLowerCase()];
    if (fallback) return fallback;
    throw error;
  }
}

async function reverseCity(latlng) {
  const cacheKey = `zenmap:rev:v1:${latlng.lat.toFixed(3)},${latlng.lng.toFixed(3)}`;
  const cached = ZenStore.get(cacheKey, GEO_TTL);
  if (cached !== null) return cached;

  try {
    const url = `https://photon.komoot.io/reverse?lat=${latlng.lat}&lon=${latlng.lng}`;
    const data = await ZenNet.fetchJson(url, { timeout: 8000, retries: 0 });
    const props = data?.features?.[0]?.properties ?? {};
    const city = props.state || props.city || '';
    ZenStore.set(cacheKey, city);
    return city;
  } catch {
    return ZenStore.getStale(cacheKey) ?? '';
  }
}

function showOriginError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function setBusy(busy) {
  const button = els.form.querySelector('button[type="submit"]');
  button.disabled = busy;
  button.classList.toggle('opacity-40', busy);
}

async function onSubmit(event) {
  event.preventDefault();
  const query = els.input.value.replace(/\s+/g, ' ').trim();
  if (!query) {
    showOriginError('先写一个起点');
    return;
  }

  setBusy(true);
  els.error.hidden = true;

  try {
    const place = await geocode(query);
    stopWatch();
    setOrigin(L.latLng(place.lat, place.lng), { manual: true });
    state.originCity = place.city || '';
    render('manual', { label: place.label });
    state.viewMode = 'none';
    considerView();
    if (wantsRoute()) {
      resetRouteState();
      maybePlanRoute();
    }
    if (trip?.mode === 'walk') loadWeather();
  } catch {
    showOriginError('没找到这个地点，或服务暂不可用');
    els.input.focus({ preventScroll: true });
  } finally {
    setBusy(false);
  }
}

function resetRouteState() {
  state.planToken += 1;
  state.routePending = false;
  state.route = null;
  state.routeCandidates = [];
  state.selectedRouteIndex = 0;
  state.engine?.clear();
  clearRouteLayers();
}

async function planTransitTrip() {
  if (!isTransit() || !state.origin || !state.dest || state.route || state.routePending) return;

  const token = state.planToken;
  state.routePending = true;
  els.routePanel.hidden = false;
  els.routeTag.textContent = '';
  els.routeSummary.textContent = '正在规划路线…';
  els.routeNote.hidden = true;
  els.remindStatus.textContent = '等待定位…';

  let demoReason = '';
  const routeKey = `zenmap:transit:v1:${state.origin.lat.toFixed(4)},${state.origin.lng.toFixed(4)}>${state.dest.lat.toFixed(4)},${state.dest.lng.toFixed(4)}`;
  try {
    const cached = ZenStore.get(routeKey, ROUTE_TTL);
    if (cached) {
      applyRoute(cached, '');
      return;
    }
    const key = (window.ZENMAP_CONFIG?.amapKey || '').trim();
    if (!key) {
      demoReason = 'no-key';
      throw new Error('no-key');
    }
    const city1 = state.originCity || (await reverseCity(state.origin));
    const city2 = state.destCity || (await reverseCity(state.dest));
    if (!city1 || !city2) {
      demoReason = 'no-city';
      throw new Error('no-city');
    }
    const route = await fetchTransitRoute({
      key,
      origin: state.origin,
      destination: state.dest,
      city1,
      city2,
    });
    if (token !== state.planToken) return;
    state.originCity = city1;
    state.destCity = city2;
    ZenStore.set(routeKey, route);
    applyRoute(route, '');
  } catch {
    if (token !== state.planToken) return;
    if (!demoReason) demoReason = 'api';
    const route = buildDemoRoute(state.origin, state.dest);
    applyRoute(route, demoReason);
  } finally {
    if (token === state.planToken) state.routePending = false;
  }
}

let planScheduled = false;
function maybePlanRoute() {
  if (!wantsRoute() || !state.origin || !state.dest || state.route || state.routePending) return;
  if (planScheduled) return;
  planScheduled = true;
  queueMicrotask(() => {
    planScheduled = false;
    if (isTransit()) planTransitTrip();
    else planDriveTrip();
  });
}

function routeCacheKey(prefix) {
  return `zenmap:${prefix}:v1:${state.origin.lat.toFixed(4)},${state.origin.lng.toFixed(4)}>${state.dest.lat.toFixed(4)},${state.dest.lng.toFixed(4)}`;
}

async function planDriveTrip() {
  if (!isDrive() || !state.origin || !state.dest || state.route || state.routePending) return;

  const token = state.planToken;
  state.routePending = true;
  els.routePanel.hidden = false;
  els.routeTag.textContent = '';
  els.routeSummary.textContent = '正在规划路线…';
  els.routeNote.hidden = true;
  els.routeOptions.hidden = true;
  els.routeSafety.hidden = true;

  const routeKey = routeCacheKey('drive');
  try {
    const cached = ZenStore.get(routeKey, ROUTE_TTL);
    if (Array.isArray(cached) && cached.length) {
      await applyDriveRoutes(cached, token);
      return;
    }
    const routes = await fetchDriveRoutes({ origin: state.origin, destination: state.dest });
    if (token !== state.planToken) return;
    ZenStore.set(routeKey, routes);
    await applyDriveRoutes(routes, token);
  } catch {
    if (token !== state.planToken) return;
    await applyDriveRoutes(buildDriveEstimates(state.origin, state.dest, 2), token);
  } finally {
    if (token === state.planToken) state.routePending = false;
  }
}

async function weatherForScoring(place) {
  const cacheKey = `zenmap:weather:v1:${place.lat.toFixed(2)},${place.lng.toFixed(2)}`;
  const cached = ZenStore.get(cacheKey, WEATHER_TTL);
  if (cached) return cached;

  try {
    const weather = await fetchWeather({ lat: place.lat, lng: place.lng });
    ZenStore.set(cacheKey, weather);
    return weather;
  } catch {
    return ZenStore.getStale(cacheKey);
  }
}

function applyRoute(route, demoReason) {
  state.route = route;
  renderRouteInfo(route, demoReason);
  drawRoute(route);
  state.engine?.setRoute(route);
  if (state.lastFix) feedReminder(state.lastFix);
}

function renderRouteInfo(route, demoReason) {
  els.routePanel.hidden = false;
  els.routeTag.textContent = demoReason ? '离线演示' : '高德 · 公交';

  const minutes = Math.max(1, Math.round(route.duration / 60));
  const bits = [`约 ${minutes} 分钟`];
  if (route.walkingDistance > 0) bits.push(`步行 ${formatMeters(route.walkingDistance)}`);
  if (route.cost != null) bits.push(`¥${route.cost}`);
  els.routeSummary.textContent = bits.join(' · ');
  els.boardName.textContent = route.boarding.name || '上车站';
  els.alightName.textContent = route.alighting.name || '下车站';

  els.routeNote.hidden = !demoReason;
  els.routeNote.textContent =
    demoReason === 'no-key'
      ? '未配置高德 Key，当前为离线演示线路；填入 Key 后自动切换真实线路'
      : demoReason === 'no-city'
        ? '无法确定所在城市，当前为离线演示线路'
        : '线路服务暂不可用，当前为离线演示线路';
}

function drawRoute(route) {
  clearRouteLayers();
  const color = ink();

  for (const leg of route.legs) {
    if (leg.points.length < 2) continue;
    const line = L.polyline(
      leg.points.map((point) => [point.lat, point.lng]),
      leg.walking
        ? { color, weight: 2, opacity: 0.35, dashArray: '1 6', lineCap: 'round' }
        : { color, weight: 4, opacity: 0.9, lineCap: 'round' },
    ).addTo(map);
    state.routeLayers.push(line);
  }

  const boardIcon = L.divIcon({
    className: '',
    html: '<span class="zen-stop-board"></span>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
  const alightIcon = L.divIcon({
    className: '',
    html: '<span class="zen-stop-alight"></span>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

  state.routeLayers.push(
    L.marker([route.boarding.lat, route.boarding.lng], { icon: boardIcon, keyboard: false, zIndexOffset: 200 }).addTo(map),
    L.marker([route.alighting.lat, route.alighting.lng], { icon: alightIcon, keyboard: false, zIndexOffset: 200 }).addTo(map),
  );

  const bounds = L.latLngBounds(route.points.map((point) => [point.lat, point.lng]));
  map.fitBounds(bounds.pad(0.12), {
    paddingTopLeft: [36, 96],
    paddingBottomRight: [36, sheetHeight() + 24],
    maxZoom: 16,
  });
  state.viewMode = 'both';
}

async function applyDriveRoutes(routes, token) {
  const weather = await weatherForScoring(state.origin);
  if (token !== state.planToken) return;

  state.routeCandidates = routes.map((route) => ({ ...route, safety: scoreRoute(route.points, { weather }) }));
  state.selectedRouteIndex = 0;
  drawDriveSelection();
}

function driveMinutes(duration) {
  return Math.max(1, Math.round(duration / 60));
}

function driveRoutesEstimated() {
  return state.routeCandidates.every((candidate) => candidate.estimated);
}

function drawDriveSelection() {
  const selected = state.routeCandidates[state.selectedRouteIndex];
  if (!selected) return;

  state.route = selected;
  els.routePanel.hidden = false;
  els.routeTag.textContent = driveRoutesEstimated()
    ? '直线估算'
    : `OSRM · 自驾 · ${state.routeCandidates.length} 条方案`;
  els.routeSummary.textContent = `${formatMeters(selected.total)} · 约 ${driveMinutes(selected.duration)} 分钟`;
  els.routeNote.hidden = false;
  els.routeNote.textContent = selected.estimated
    ? `路径服务暂不可用，当前为直线估算 · ${SAFETY_DISCLAIMER}`
    : SAFETY_DISCLAIMER;

  clearRouteLayers();
  const color = ink();
  const faded = ghost();

  for (const [index, candidate] of state.routeCandidates.entries()) {
    if (index === state.selectedRouteIndex) continue;
    const line = L.polyline(
      candidate.points.map((point) => [point.lat, point.lng]),
      { color: faded, weight: 3, opacity: 0.35, lineCap: 'round' },
    ).addTo(map);
    line.zenFaded = true;
    state.routeLayers.push(line);
  }

  const selectedLine = L.polyline(
    selected.points.map((point) => [point.lat, point.lng]),
    selected.estimated
      ? { color, weight: 4, opacity: 0.9, dashArray: '6 8', lineCap: 'round' }
      : { color, weight: 4, opacity: 0.9, lineCap: 'round' },
  ).addTo(map);
  state.routeLayers.push(selectedLine);

  renderDriveOptions();
  renderDriveSafety(selected);

  const bounds = L.latLngBounds(
    state.routeCandidates.flatMap((candidate) => candidate.points.map((point) => [point.lat, point.lng])),
  );
  map.fitBounds(bounds.pad(0.12), {
    paddingTopLeft: [36, 96],
    paddingBottomRight: [36, sheetHeight() + 24],
    maxZoom: 16,
  });
  state.viewMode = 'both';
}

function renderDriveOptions() {
  els.routeOptions.hidden = false;
  els.routeOptions.textContent = '';

  for (const [index, candidate] of state.routeCandidates.entries()) {
    const grade = scoreGrade(candidate.safety.score);
    const active = index === state.selectedRouteIndex;

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.index = String(index);
    button.setAttribute('aria-pressed', String(active));
    button.className = `zen-option border border-zen-line px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zen-ink${active ? ' zen-option-active' : ''}`;

    const name = document.createElement('span');
    name.className = 'block text-[0.6875rem] tracking-[0.12em]';
    name.textContent = candidate.estimated ? `${candidate.id} · 直线估算` : candidate.id;

    const metric = document.createElement('span');
    metric.className = 'mt-1 block text-sm font-medium tracking-tight';
    metric.textContent = `${formatMeters(candidate.total)} · 约 ${driveMinutes(candidate.duration)} 分钟`;

    const score = document.createElement('span');
    score.className = `zen-grade-${grade.tone} mt-1 block text-[0.6875rem]`;
    score.textContent = `安全 ${candidate.safety.score} · ${grade.label}`;

    button.append(name, metric, score);
    els.routeOptions.append(button);
  }
}

function renderDriveSafety(candidate) {
  els.routeSafety.hidden = false;
  els.routeSafety.textContent = '';

  const grade = scoreGrade(candidate.safety.score);
  const head = document.createElement('p');
  head.className = 'text-xs leading-5 text-zen-ghost';
  head.append(`安全评分 ${candidate.safety.score} · `);

  const label = document.createElement('span');
  label.className = `zen-grade-${grade.tone} font-medium`;
  label.textContent = grade.label;
  head.append(label);
  els.routeSafety.append(head);

  for (const factor of candidate.safety.factors) {
    const row = document.createElement('p');
    row.className = 'text-xs leading-5 text-zen-ghost';
    row.textContent = `· ${factor.label}`;
    if (factor.weight > 0) row.append(` −${factor.weight}`);
    els.routeSafety.append(row);
  }
}

function bindDriveUI() {
  if (!isDrive()) return;
  els.routeOptions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    const index = Number(button.dataset.index);
    if (!state.routeCandidates[index] || index === state.selectedRouteIndex) return;
    state.selectedRouteIndex = index;
    drawDriveSelection();
  });
}

function clearRouteLayers() {
  for (const layer of state.routeLayers) layer.remove();
  state.routeLayers = [];
}

function feedReminder(fix) {
  if (!state.route || !state.engine) return;
  const result = state.engine.evaluate(fix);
  if (!result || result.skipped) return;
  updateRemindStatus(result);
  if (result.alert) fireAlert(result.alert);
}

function updateRemindStatus(result) {
  if (result.offRoute) {
    els.remindStatus.textContent = `偏离路线约 ${formatMeters(result.offset)}`;
    return;
  }
  if (result.alert) return;
  const parts = [];
  if (!result.boarded) parts.push(`距上车站 ${formatMeters(result.boardingRemaining)}`);
  parts.push(`距下车站 ${formatMeters(result.alightingRemaining)}`);
  els.remindStatus.textContent = parts.join(' · ');
}

function showBanner(title, sub) {
  els.bannerTitle.textContent = title;
  els.bannerSub.textContent = sub;
  els.banner.hidden = false;
  window.clearTimeout(state.bannerTimer);
  state.bannerTimer = window.setTimeout(() => {
    els.banner.hidden = true;
  }, 10000);
}

function fireAlert(kind) {
  if (!state.route) return;
  const stop = kind === 'boarding' ? state.route.boarding : state.route.alighting;
  const name = stop.name || (kind === 'boarding' ? '上车站' : '下车站');
  const title = kind === 'boarding' ? '准备上车' : '即将到站';
  const sub = kind === 'boarding' ? `${name} · 请前往上车站` : `${name} · 请准备下车`;

  showBanner(title, sub);
  const canVibrate = !navigator.userActivation || navigator.userActivation.hasBeenActive;
  if ('vibrate' in navigator && canVibrate) {
    try {
      navigator.vibrate([300, 120, 300]);
    } catch {}
  }
  speak(kind === 'boarding' ? `请准备上车，${name}` : `即将到站，${name}，请准备下车`);
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch {}
}

function initialThreshold() {
  const stored = Number(readStorage(THRESHOLD_KEY));
  return [300, 500, 800, 1000].includes(stored) ? stored : 500;
}

function bindTransitUI() {
  const threshold = initialThreshold();
  els.threshold.value = String(threshold);

  els.threshold.addEventListener('change', () => {
    const value = Number(els.threshold.value) || 500;
    state.engine?.setThreshold(value);
    writeStorage(THRESHOLD_KEY, value);
    els.remindStatus.textContent = `提醒阈值 ${formatMeters(value)}`;
  });

  els.testAlert.addEventListener('click', () => {
    if (state.route) {
      fireAlert('alighting');
      return;
    }
    showBanner('提醒测试', '到达站点前会以闪烁文字提醒');
    speak('提醒测试：即将到站，请准备下车');
  });
}

function bearingBetween(from, to) {
  const toRad = Math.PI / 180;
  const dLng = (to.lng - from.lng) * toRad;
  const lat1 = from.lat * toRad;
  const lat2 = to.lat * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) / toRad) + 360) % 360;
}

function angleDelta(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function bindFuel() {
  if (trip?.mode !== 'drive') return;
  els.gasBtn.hidden = false;
  document.documentElement.style.setProperty('--z-bottom-extra', '3.5rem');
  els.gasBtn.addEventListener('click', () => toggleGasPanel());
  els.gasClose.addEventListener('click', () => toggleGasPanel(false));
  els.gasRefresh.addEventListener('click', () => loadFuel(true));
  els.gasClear.addEventListener('click', () => clearGasWaypoint());
  els.gasChip.addEventListener('click', () => toggleGasPanel(true));
}

function toggleGasPanel(open = els.gasPanel.hidden) {
  if (!open) {
    els.gasPanel.hidden = true;
    return;
  }
  els.gasPanel.hidden = false;
  loadFuel();
}

async function loadFuel(force = false) {
  if (trip?.mode !== 'drive' || state.fuel.loading) return;
  const anchor = state.origin || state.dest;
  if (!anchor) {
    els.gasStatus.textContent = '先确定起点再查找加油站';
    return;
  }
  if (state.fuel.key && !force) {
    renderFuelList();
    return;
  }

  state.fuel.loading = true;
  els.gasStatus.textContent = '正在查找附近加油站…';

  const cacheKey = `zenmap:fuel:v1:${anchor.lat.toFixed(3)},${anchor.lng.toFixed(3)}`;
  try {
    const cached = force ? null : ZenStore.get(cacheKey, FUEL_TTL);
    if (cached !== null) {
      state.fuel.key = cacheKey;
      state.fuel.list = cached;
      renderFuelList();
      return;
    }
    try {
      const stations = await fetchFuelStations({ lat: anchor.lat, lng: anchor.lng });
      ZenStore.set(cacheKey, stations);
      state.fuel.key = cacheKey;
      state.fuel.list = stations;
      renderFuelList();
    } catch (error) {
      const stale = ZenStore.getStale(cacheKey);
      if (!Array.isArray(stale) || !stale.length) throw error;
      state.fuel.key = cacheKey;
      state.fuel.list = stale;
      renderFuelList();
      if (els.gasList.children.length) els.gasStatus.textContent += ' · 离线缓存';
    }
  } catch {
    els.gasStatus.textContent = '加油站服务暂不可用，稍后重试';
  } finally {
    state.fuel.loading = false;
  }
}

function rankFuelStations(stations) {
  const anchor = state.origin || state.dest;
  if (!anchor) return [];

  const hasDirection = Boolean(state.dest && distanceBetween(anchor, state.dest) > 80);
  const destBearing = hasDirection ? bearingBetween(anchor, state.dest) : null;

  return stations
    .map((station) => {
      const distance = distanceBetween(anchor, station);
      const ahead = destBearing !== null && angleDelta(bearingBetween(anchor, station), destBearing) <= 75;
      return { ...station, distance, ahead };
    })
    .filter((station) => Number.isFinite(station.distance) && station.distance <= 4000)
    .sort((a, b) => Number(b.ahead) - Number(a.ahead) || a.distance - b.distance);
}

function renderFuelList() {
  const stations = rankFuelStations(state.fuel.list);
  const hasDirection = Boolean(state.origin && state.dest && distanceBetween(state.origin, state.dest) > 80);
  els.gasList.innerHTML = '';

  if (!stations.length) {
    els.gasStatus.textContent = '4 km 内没有找到加油站';
    return;
  }

  const ahead = stations.filter((station) => station.ahead).length;
  els.gasStatus.textContent = hasDirection
    ? `4 km 内 ${stations.length} 个 · 前方 ${ahead} 个`
    : `4 km 内 ${stations.length} 个`;

  for (const station of stations.slice(0, 8)) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = station.id;
    button.className = 'gas-row flex w-full items-center justify-between gap-3 px-1 py-2.5 text-left text-sm tracking-tight';
    if (station.id === state.fuel.selectedId) button.setAttribute('aria-pressed', 'true');

    const name = document.createElement('span');
    name.className = 'min-w-0 truncate';
    name.textContent = station.name;

    const meta = document.createElement('span');
    meta.className = 'gas-meta shrink-0 text-xs text-zen-ghost';
    meta.textContent = `${formatMeters(station.distance)}${station.ahead ? ' · 前方' : ''}`;

    button.append(name, meta);
    button.addEventListener('click', () => selectFuelStation(station));
    item.append(button);
    els.gasList.append(item);
  }
}

function selectFuelStation(station) {
  const from = state.origin || state.dest;
  if (!from) return;

  state.fuel.selectedId = station.id;
  clearFuelLayers();

  const color = ink();
  const line = L.polyline([[from.lat, from.lng], [station.lat, station.lng]], {
    color,
    weight: 2,
    opacity: 0.55,
    dashArray: '4 6',
    lineCap: 'round',
  }).addTo(map);
  const icon = L.divIcon({
    className: '',
    html: '<span class="zen-marker-gas"></span>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
  const marker = L.marker([station.lat, station.lng], { icon, keyboard: false, zIndexOffset: 250 }).addTo(map);
  state.fuel.layers.push(line, marker);

  els.gasWaypoint.hidden = false;
  els.gasWaypointName.textContent = station.name;
  els.gasChipName.textContent = station.name;
  els.gasChip.hidden = false;
  els.gasBtn.hidden = true;
  els.gasPanel.hidden = true;
  syncGasSelection();

  const bounds = L.latLngBounds([[from.lat, from.lng], [station.lat, station.lng]]);
  map.fitBounds(bounds.pad(0.25), {
    paddingTopLeft: [36, 96],
    paddingBottomRight: [36, sheetHeight() + 24],
    maxZoom: 15,
  });
}

function clearFuelLayers() {
  for (const layer of state.fuel.layers) layer.remove();
  state.fuel.layers = [];
}

function clearGasWaypoint() {
  state.fuel.selectedId = '';
  clearFuelLayers();
  els.gasWaypoint.hidden = true;
  els.gasWaypointName.textContent = '';
  els.gasChip.hidden = true;
  els.gasChipName.textContent = '';
  els.gasBtn.hidden = false;
  syncGasSelection();
}

function syncGasSelection() {
  for (const button of els.gasList.querySelectorAll('.gas-row')) {
    if (button.dataset.id === state.fuel.selectedId) button.setAttribute('aria-pressed', 'true');
    else button.removeAttribute('aria-pressed');
  }
}

async function loadWeather(force = false) {
  if (trip?.mode !== 'walk') return;
  const place = state.origin || state.dest;
  if (!place) return;

  const key = `${place.lat.toFixed(2)},${place.lng.toFixed(2)}`;
  if (!force && (state.weather.key === key || state.weather.loading)) return;

  state.weather.loading = true;
  try {
    const cacheKey = `zenmap:weather:v1:${key}`;
    const cached = force ? null : ZenStore.get(cacheKey, WEATHER_TTL);
    if (cached) {
      state.weather.key = key;
      renderWeather(cached, place === state.dest);
      return;
    }
    try {
      const weather = await fetchWeather(place);
      ZenStore.set(cacheKey, weather);
      state.weather.key = key;
      renderWeather(weather, place === state.dest);
    } catch (error) {
      const stale = ZenStore.getStale(cacheKey);
      if (!stale) throw error;
      state.weather.key = key;
      renderWeather(stale, place === state.dest);
      els.weatherRain.textContent += ' · 离线缓存';
    }
  } catch {
    els.weatherPanel.hidden = false;
    if (!state.weather.key) {
      els.weatherTemp.textContent = '—';
      els.weatherText.textContent = '天气服务暂不可用';
      els.weatherRain.textContent = '';
    }
  } finally {
    state.weather.loading = false;
  }
}

function renderWeather(weather, fromDest) {
  els.weatherPanel.hidden = false;
  els.weatherTemp.textContent = `${weather.temp}°`;
  els.weatherText.textContent = `${weather.text} · 体感 ${weather.feels}°${fromDest ? ' · 目的地' : ''}`;

  if (weather.precipitation > 0.05) {
    els.weatherRain.textContent = '正在下雨，记得带伞';
  } else if (weather.maxProb >= 50) {
    els.weatherRain.textContent = `接下来 3 小时降雨概率 ${weather.maxProb}%，带把伞`;
  } else {
    els.weatherRain.textContent = '接下来 3 小时无降雨';
  }
}

function onLocate() {
  if (state.origin && !state.originManual && state.watchId !== null) {
    map.flyTo(state.origin, Math.max(map.getZoom(), 16), { duration: 0.45 });
    return;
  }
  startWatch();
}

function syncSheetOffset() {
  const update = () => document.documentElement.style.setProperty('--z-sheet', `${sheetHeight()}px`);
  update();
  if ('ResizeObserver' in window) new ResizeObserver(update).observe(els.sheet);
  window.addEventListener('resize', update);
}

function bindTheme() {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const color = ink();
    if (accuracyCircle) accuracyCircle.setStyle({ color, fillColor: color });
    for (const layer of [...state.routeLayers, ...state.fuel.layers]) {
      if (typeof layer.setStyle === 'function') layer.setStyle({ color: layer.zenFaded ? ghost() : color });
    }
  });
}

function bindNetwork() {
  const sync = () => {
    els.offlineNote.hidden = navigator.onLine;
  };
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  sync();
}

function bindEvents() {
  els.retry.addEventListener('click', startWatch);
  els.locate.addEventListener('click', onLocate);
  els.manualLink.addEventListener('click', () => showForm(true));
  els.form.addEventListener('submit', onSubmit);
  window.addEventListener('pagehide', stopWatch);
}

function mountTiles() {
  const source = TILE_SOURCES[tileIndex];
  tileErrors = 0;
  tileLayer = L.tileLayer(source.url, { maxZoom: source.maxZoom, attribution: OSM_ATTRIBUTION }).addTo(map);
  tileLayer.on('tileerror', () => {
    tileErrors += 1;
    if (tileErrors < 3 || tileIndex >= TILE_SOURCES.length - 1) return;
    tileIndex += 1;
    map.removeLayer(tileLayer);
    mountTiles();
  });
}

function mountRouteChrome() {
  els.routeTitle.textContent = MODE_TITLE[trip.mode] || '路线';
  els.routeStops.hidden = !isTransit();
  els.routeRemind.hidden = !isTransit();
  els.remindStatus.hidden = !isTransit();
}

function boot() {
  document.title = `${trip.destination} · ZenMap`;
  els.mode.textContent = MODE_LABEL[trip.mode] || '导航';
  els.dest.textContent = trip.destination;

  map = L.map(els.map, {
    center: [34.5, 108.9],
    zoom: 4,
    zoomControl: false,
    zoomSnap: 0.5,
    worldCopyJump: true,
  });

  mountTiles();
  map.attributionControl.setPrefix(false);

  originIcon = L.divIcon({ className: '', html: '<span class="zen-marker-dot"></span>', iconSize: [14, 14], iconAnchor: [7, 7] });
  manualIcon = L.divIcon({ className: '', html: '<span class="zen-marker-manual"></span>', iconSize: [14, 14], iconAnchor: [7, 7] });
  destinationIcon = L.divIcon({ className: '', html: '<span class="zen-marker-dest"></span>', iconSize: [14, 14], iconAnchor: [7, 7] });

  state.engine = createReminderEngine({ threshold: initialThreshold() });

  syncSheetOffset();
  mountRouteChrome();
  bindTheme();
  bindNetwork();
  bindEvents();
  bindTransitUI();
  bindFuel();
  bindDriveUI();

  startWatch();
  resolveDestination();
}

if (trip?.destination) {
  boot();
} else {
  window.location.replace('./index.html');
}