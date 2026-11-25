const OSRM_DRIVING_URL = 'https://router.project-osrm.org/route/v1/driving';
const OSRM_FOOT_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';
const DRIVE_ESTIMATE_SPEED = (40 * 1000) / 3600;
const WALK_ESTIMATE_SPEED = 1.2;
const DRIVE_ROUTE_NAMES = ['方案一', '方案二', '方案三'];
const DRIVE_ROUTE_LIMIT = 3;
const DRIVE_VARIANT_BENDS = [0, 0.12, -0.12];

function osrmRouteUrl(baseUrl, origin, destination, alternatives) {
  const via = `${origin.lng.toFixed(6)},${origin.lat.toFixed(6)};${destination.lng.toFixed(6)},${destination.lat.toFixed(6)}`;
  return `${baseUrl}/${via}?overview=full&geometries=geojson${alternatives ? '&alternatives=true' : ''}&steps=false`;
}

async function fetchOsrmRoutes(url, { timeout, fallbackSpeed, retries = 1 }) {
  const data = await ZenNet.fetchJson(url, { timeout, retries });

  if (data?.code !== 'Ok') throw new Error('osrm-code');

  const routes = (data.routes ?? []).map((raw) => normalizeOsrmRoute(raw, fallbackSpeed)).filter(Boolean);
  if (!routes.length) throw new Error('osrm-empty');

  return routes;
}

function normalizeOsrmRoute(raw, fallbackSpeed) {
  const coordinates = raw?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

  const points = coordinates.map(([lng, lat]) => ({ lat, lng }));
  const { total } = buildRouteMetrics(points);
  const seconds = Number(raw.duration);

  return {
    id: '',
    source: 'osrm',
    legs: [{ walking: false, points }],
    points,
    total,
    duration: Number.isFinite(seconds) && seconds > 0 ? seconds : total / fallbackSpeed,
    estimated: false,
  };
}

function buildBendPoints(origin, destination, bend) {
  const steps = 32;
  const dLat = destination.lat - origin.lat;
  const dLng = destination.lng - origin.lng;
  const points = [];

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const offset = Math.sin(Math.PI * t) * bend;
    points.push({
      lat: origin.lat + dLat * t - dLng * offset,
      lng: origin.lng + dLng * t + dLat * offset,
    });
  }

  return points;
}

function buildDriveEstimate(origin, destination, bend = 0) {
  const points = buildBendPoints(origin, destination, bend);
  const { total } = buildRouteMetrics(points);
  return {
    id: '',
    source: 'estimate',
    legs: [{ walking: false, points }],
    points,
    total,
    duration: total / DRIVE_ESTIMATE_SPEED,
    estimated: true,
  };
}

function buildDriveEstimates(origin, destination, count) {
  return DRIVE_VARIANT_BENDS.slice(0, count).map((bend, index) => ({
    ...buildDriveEstimate(origin, destination, bend),
    id: DRIVE_ROUTE_NAMES[index] ?? `方案${index + 1}`,
  }));
}

function nameDriveRoutes(routes) {
  return routes.map((route, index) => ({ ...route, id: DRIVE_ROUTE_NAMES[index] ?? `方案${index + 1}` }));
}

async function fetchDriveRoutes({ origin, destination }) {
  const routes = await fetchOsrmRoutes(osrmRouteUrl(OSRM_DRIVING_URL, origin, destination, true), {
    timeout: 12000,
    fallbackSpeed: DRIVE_ESTIMATE_SPEED,
  });
  const picked = routes.slice(0, DRIVE_ROUTE_LIMIT);

  return nameDriveRoutes([...picked, ...buildDriveEstimates(origin, destination, DRIVE_ROUTE_LIMIT - picked.length)]);
}

async function fetchWalkRoute({ origin, destination }) {
  const [route] = await fetchOsrmRoutes(osrmRouteUrl(OSRM_FOOT_URL, origin, destination, false), {
    timeout: 10000,
    fallbackSpeed: WALK_ESTIMATE_SPEED,
  });
  return { ...route, id: '步行路线' };
}

function buildWalkEstimate(origin, destination) {
  const points = buildBendPoints(origin, destination, 0);
  const { total } = buildRouteMetrics(points);

  return {
    id: '步行路线',
    source: 'estimate',
    legs: [{ walking: false, points }],
    points,
    total,
    duration: total / WALK_ESTIMATE_SPEED,
    estimated: true,
  };
}
