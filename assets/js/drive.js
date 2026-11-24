const OSRM_DRIVING_URL = 'https://router.project-osrm.org/route/v1/driving';
const DRIVE_ESTIMATE_SPEED = (40 * 1000) / 3600;
const DRIVE_ROUTE_NAMES = ['方案一', '方案二', '方案三'];
const DRIVE_ROUTE_LIMIT = 3;
const DRIVE_VARIANT_BENDS = [0, 0.12, -0.12];

function normalizeDriveRoute(raw, index) {
  const coordinates = raw?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

  const points = coordinates.map(([lng, lat]) => ({ lat, lng }));
  const { total } = buildRouteMetrics(points);
  const seconds = Number(raw.duration);

  return {
    id: DRIVE_ROUTE_NAMES[index] ?? `方案${index + 1}`,
    source: 'osrm',
    legs: [{ walking: false, points }],
    points,
    total,
    duration: Number.isFinite(seconds) && seconds > 0 ? seconds : total / DRIVE_ESTIMATE_SPEED,
    estimated: false,
  };
}

function buildDriveEstimate(origin, destination, bend = 0) {
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
  const via = `${origin.lng.toFixed(6)},${origin.lat.toFixed(6)};${destination.lng.toFixed(6)},${destination.lat.toFixed(6)}`;
  const url = `${OSRM_DRIVING_URL}/${via}?overview=full&geometries=geojson&alternatives=true&steps=false`;
  const data = await ZenNet.fetchJson(url, { timeout: 12000, retries: 1 });

  if (data?.code !== 'Ok') throw new Error('drive-http');

  const routes = (data.routes ?? []).map(normalizeDriveRoute).filter(Boolean).slice(0, DRIVE_ROUTE_LIMIT);
  if (!routes.length) throw new Error('drive-empty');

  return nameDriveRoutes([...routes, ...buildDriveEstimates(origin, destination, DRIVE_ROUTE_LIMIT - routes.length)]);
}
