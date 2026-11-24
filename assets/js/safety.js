const RISK_ZONES = [
  { lat: 39.8961, lng: 116.3304, radius: 500, type: 'construction', label: '广安路地铁施工段' },
  { lat: 39.8994, lng: 116.3975, radius: 450, type: 'accident', label: '崇文门–前门事故多发段' },
  { lat: 31.2072, lng: 121.4063, radius: 600, type: 'construction', label: '延安路高架施工段' },
  { lat: 31.2304, lng: 121.4737, radius: 800, type: 'pedestrian', label: '人民广场步行区' },
];

const RISK_PENALTY = { construction: 12, accident: 12, pedestrian: 8 };
const WEATHER_PENALTY = { 毛毛雨: 10, 雨: 10, 阵雨: 10, 雷雨: 10, 雪: 10, 阵雪: 10, 雾: 6, 霾: 6 };
const PEAK_PENALTY = 8;
const LONG_ROUTE_START = 15000;
const LONG_ROUTE_STEP = 5000;
const LONG_ROUTE_UNIT = 3;
const LONG_ROUTE_CAP = 9;

function scoreGrade(score) {
  if (score >= 85) return { label: '优', tone: 'high' };
  if (score >= 70) return { label: '良', tone: 'mid' };
  return { label: '中', tone: 'low' };
}

function isPeakHour(hour) {
  return (hour >= 7 && hour < 9) || (hour >= 17 && hour < 19);
}

function crossedRiskZones(points) {
  return RISK_ZONES.filter((zone) =>
    points.some((point) => distanceBetween(point, zone) <= zone.radius),
  );
}

function scoreRoute(points, options = {}) {
  const hour = Number.isFinite(options.hour) ? options.hour : new Date().getHours();
  const weather = options.weather ?? null;
  const factors = [];
  let penalty = 0;

  for (const zone of crossedRiskZones(points)) {
    const weight = RISK_PENALTY[zone.type] ?? 0;
    penalty += weight;
    factors.push({ type: zone.type, label: `途经${zone.label}`, weight });
  }

  if (isPeakHour(hour)) {
    penalty += PEAK_PENALTY;
    factors.push({ type: 'peak', label: `早晚高峰（${hour} 点）`, weight: PEAK_PENALTY });
  }

  const weatherWeight = weather?.text ? WEATHER_PENALTY[weather.text] ?? 0 : 0;
  if (weatherWeight > 0) {
    penalty += weatherWeight;
    factors.push({ type: 'weather', label: `起点天气：${weather.text}`, weight: weatherWeight });
  }

  const { total } = buildRouteMetrics(points);
  if (total > LONG_ROUTE_START) {
    const over = Math.ceil((total - LONG_ROUTE_START) / LONG_ROUTE_STEP);
    const weight = Math.min(LONG_ROUTE_CAP, over * LONG_ROUTE_UNIT);
    penalty += weight;
    factors.push({ type: 'length', label: `路线较长（${(total / 1000).toFixed(1)} km）`, weight });
  }

  const score = Math.max(0, Math.round(100 - penalty));
  if (!factors.length) factors.push({ type: 'clear', label: '无明显风险因子', weight: 0 });

  return { score, grade: scoreGrade(score).label, factors };
}
