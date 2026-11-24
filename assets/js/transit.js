const AMAP_TRANSIT_URL = 'https://restapi.amap.com/v3/direction/transit/integrated';

function parseAmapPolyline(value) {
  if (typeof value !== 'string' || value === '') return [];
  return value
    .split(';')
    .map((pair) => {
      const [lng, lat] = pair.split(',').map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const point = gcj02ToWgs84(lat, lng);
      return { lat: point.lat, lng: point.lng };
    })
    .filter(Boolean);
}

function parseAmapStop(stop) {
  if (!stop || typeof stop.location !== 'string') return null;
  const [lng, lat] = stop.location.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const point = gcj02ToWgs84(lat, lng);
  return { name: stop.name || '', lat: point.lat, lng: point.lng };
}

function toAmapCoord(point) {
  const gcj = wgs84ToGcj02(point.lat, point.lng);
  return `${gcj.lng.toFixed(6)},${gcj.lat.toFixed(6)}`;
}

async function fetchTransitRoute({ key, origin, destination, city1, city2 }) {
  const url = new URL(AMAP_TRANSIT_URL);
  url.searchParams.set('key', key);
  url.searchParams.set('origin', toAmapCoord(origin));
  url.searchParams.set('destination', toAmapCoord(destination));
  url.searchParams.set('city', city1);
  if (city2 && city2 !== city1) url.searchParams.set('cityd', city2);
  url.searchParams.set('strategy', '0');
  url.searchParams.set('output', 'json');

  const response = await fetch(url, { signal: ZenNet.timeoutSignal(12000) });
  if (!response.ok) throw new Error('transit-http');

  const data = await response.json();
  if (data.status !== '1') throw new Error(`transit-status-${data.info || 'error'}`);

  const transit = data.route?.transits?.[0];
  if (!transit) throw new Error('transit-empty');
  return normalizeTransit(transit);
}

function normalizeTransit(transit) {
  const legs = [];
  let boarding = null;
  let alighting = null;

  for (const segment of transit.segments || []) {
    if (segment.walking?.steps?.length) {
      const points = segment.walking.steps.flatMap((step) => parseAmapPolyline(step.polyline));
      if (points.length > 1) legs.push({ walking: true, points });
    }

    const line = segment.bus?.buslines?.[0];
    if (line) {
      const from = parseAmapStop(line.departure_stop);
      const to = parseAmapStop(line.arrival_stop);
      let points = parseAmapPolyline(line.polyline);
      if (points.length < 2 && from && to) points = [from, to];
      if (points.length > 1) legs.push({ walking: false, points, name: line.name || '' });
      if (!boarding && from) boarding = from;
      if (to) alighting = to;
    }

    const railway = segment.railway;
    if (railway) {
      const from = parseAmapStop(railway.departure_stop);
      const to = parseAmapStop(railway.arrival_stop);
      if (from && to) legs.push({ walking: false, points: [from, to], name: railway.name || railway.trip || '' });
      if (!boarding && from) boarding = from;
      if (to) alighting = to;
    }
  }

  if (!legs.length || !boarding || !alighting) throw new Error('transit-incomplete');

  const points = legs.flatMap((leg) => leg.points);
  const { cum, total } = buildRouteMetrics(points);

  return {
    source: 'amap',
    legs,
    points,
    cum,
    total,
    boarding: { ...boarding, along: alongOfPoint(points, cum, boarding) },
    alighting: { ...alighting, along: alongOfPoint(points, cum, alighting) },
    duration: Number(transit.duration) || 0,
    walkingDistance: Number(transit.walking_distance) || 0,
    cost: transit.cost != null && transit.cost !== '' ? Number(transit.cost) : null,
    demo: false,
  };
}

function buildDemoRoute(origin, destination) {
  const start = { lat: origin.lat, lng: origin.lng };
  const end = { lat: destination.lat, lng: destination.lng };
  const dLat = end.lat - start.lat;
  const dLng = end.lng - start.lng;
  const steps = 24;
  const points = [];

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const bend = Math.sin(Math.PI * t) * 0.06;
    points.push({
      lat: start.lat + dLat * t - dLng * bend,
      lng: start.lng + dLng * t + dLat * bend,
    });
  }

  const { cum, total } = buildRouteMetrics(points);
  const boardAlong = total * 0.12;
  const alightAlong = total * 0.94;
  const board = pointAtAlong(points, cum, boardAlong);
  const alight = pointAtAlong(points, cum, alightAlong);

  const legs = [];
  const walkStart = points.slice(0, board.index + 1);
  const ride = points.slice(board.index, alight.index + 1);
  const walkEnd = points.slice(alight.index);
  if (walkStart.length > 1) legs.push({ walking: true, points: walkStart });
  if (ride.length > 1) legs.push({ walking: false, points: ride, name: '演示线路' });
  if (walkEnd.length > 1) legs.push({ walking: true, points: walkEnd });

  const walkingDistance = boardAlong + (total - alightAlong);
  const duration = walkingDistance / 1.2 + Math.max(0, alightAlong - boardAlong) / 7;

  return {
    source: 'demo',
    legs,
    points,
    cum,
    total,
    boarding: { name: '演示上车站', lat: board.point.lat, lng: board.point.lng, along: boardAlong },
    alighting: { name: '演示下车站', lat: alight.point.lat, lng: alight.point.lng, along: alightAlong },
    duration,
    walkingDistance,
    cost: null,
    demo: true,
  };
}